import { createReadStream } from 'node:fs'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { configDir, fail, protocolVersion, pluginVersion, targets, workerFile } from '../config.mjs'

function handshake(response, pin) {
  if (response.headers.get('x-protocol-version') !== String(protocolVersion) ||
      response.headers.get('x-plugin-version')?.split('.')[0] !== pluginVersion.split('.')[0]) fail('VERSION_MISMATCH',409)
  const machine = response.headers.get('x-server-machine-id')
  if (!machine || (pin && pin !== machine)) fail('MACHINE_ID_MISMATCH',409)
  return machine
}
async function checked(response) {
  if (!response.ok) {
    const data = await response.text()
    let code
    try { code = JSON.parse(data).error } catch {}
    fail(code || 'HTTP_'+response.status, response.status)
  }
  return response
}
export async function credentials() {
  return JSON.parse(await readFile(join(configDir(),'credentials.json'),'utf8'))
}
export async function link(address, code, clientName = hostname()) {
  const url = new URL(address)
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
    fail('SERVER_ORIGIN_REQUIRED')
  const prev = await credentials().catch(error=>{if(error.code!=='ENOENT') throw error})
  const probe = await checked(await fetch(url.origin+'/health',{redirect:'error'}))
  const machine = handshake(probe,prev?.serverMachineId)
  await probe.body.cancel()
  const response = await checked(await fetch(url.origin+'/api/pair',{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({code,clientName})}))
  handshake(response,machine)
  const {token,serverMachineId,clientId} = await response.json()
  if (serverMachineId!==machine) fail('MACHINE_ID_MISMATCH',409)
  const root = configDir()
  await mkdir(root,{recursive:true})
  const tmp = join(root,'credentials-'+randomUUID()+'.tmp')
  await writeFile(tmp,JSON.stringify({serverUrl:url.origin,token,serverMachineId,clientId}),{mode:0o600})
  await rename(tmp,join(root,'credentials.json'))
  return {serverUrl:url.origin,serverMachineId,clientId}
}

export function remote(creds) {
  return async function request(path,options={}) {
    if (!path.startsWith('/api/')) fail('API_PATH_REQUIRED')
    // Avoid presenting a saved bearer to a replacement host at the same address.
    const probe = await checked(await fetch(creds.serverUrl+'/health',{signal:options.signal,redirect:'error'}))
    handshake(probe,creds.serverMachineId)
    await probe.body.cancel()
    const response = await fetch(creds.serverUrl+path,{...options,redirect:'error',
      headers:{...options.headers,Authorization:'Bearer '+creds.token,'X-Server-Machine-Id':creds.serverMachineId,
        'X-Protocol-Version':String(protocolVersion),'X-Plugin-Version':pluginVersion}})
    handshake(response,creds.serverMachineId)
    return checked(response)
  }
}

export async function dispatch(config, request, args) {
  if (!args.targetHarness) fail('TARGET_HARNESS_REQUIRED')
  if (!args.targetProject) fail('TARGET_PROJECT_UNKNOWN')
  const caps = await (await request('/api/capabilities')).json()
  targets(args,caps)
  if (args.targetHarness==='antigravity' && !(args.antigravityMode==='cli' ? caps.antigravityCli : caps.antigravityApp))
    fail('TARGET_HARNESS_UNAVAILABLE',409)
  const {bundleHash,idempotencyKey,...rest} = args
  if (typeof bundleHash!=='string' || !/^[a-f0-9]{64}$/.test(bundleHash)) fail('BUNDLE_HASH_REQUIRED')
  if (!idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED')
  const stream = createReadStream(join(config.previewDir,bundleHash+'.gz'))
  try {
    const res = await request('/api/jobs',{method:'POST',duplex:'half',body:stream,
      headers:{'Content-Type':'application/gzip','Idempotency-Key':idempotencyKey,
        'X-Connecter-Dispatch':Buffer.from(JSON.stringify({...rest,bundleHash})).toString('base64url')}})
    return await res.json()
  } finally { stream.destroy() }
}

export async function workerRequest(config,action,{jobId,runId,...params}) {
  const path = workerFile(config,jobId,runId)
  const {token} = JSON.parse(await readFile(path,'utf8'))
  const res = await fetch('http://127.0.0.1:'+config.localPort+'/local/jobs/'+jobId+'/'+action,{
    method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'X-Run-Id':runId,'Content-Type':'application/json'},
    body:JSON.stringify(params)})
  return (await checked(res)).json()
}

export async function* events(response) {
  let pending=''
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    pending += chunk
    let end
    while ((end=pending.indexOf('\n\n')) >= 0) {
      const frame=pending.slice(0,end)
      pending=pending.slice(end+2)
      const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
      if (data) yield JSON.parse(data)
    }
  }
}
