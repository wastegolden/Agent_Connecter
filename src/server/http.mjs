import http from 'node:http'
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Store } from '../store.mjs'
import { clientAuth, pair, digest, machineId, secret, matches } from '../auth.mjs'
import { harnesses, protocolVersion, pluginVersion, fail, targets, workerFile } from '../config.mjs'
import { unpackBundle } from '../packer/index.mjs'
import { createLauncher } from '../launcher/index.mjs'
import { createUpdate } from './updater.mjs'

async function body(req) {
  let bytes = 0
  const parts = []
  for await (const part of req) {
    if ((bytes += part.length) > 1024*1024) fail('REQUEST_TOO_LARGE', 413)
    parts.push(part)
  }
  const value = JSON.parse(Buffer.concat(parts).toString() || '{}')
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('INVALID_BODY')
  return value
}
function json(res, data, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'})
  res.end(JSON.stringify(data))
}
function publicJob({runId, ...job}) { return job }
const dashboard = new URL('./dashboard.html', import.meta.url)

export async function startServer(config, launcherFactory = createLauncher) {
  if (!['server','both'].includes(config.mode)) fail('SERVER_MODE_REQUIRED')
  if (config.lanPort && config.lanPort === config.localPort) fail('PORT_CONFLICT')
  const store = new Store(config.dataDir)
  const jobsDir = join(config.dataDir,'jobs')
  await mkdir(jobsDir, {recursive:true})
  const id = machineId(store.db)
  let sidecarStream, heartbeat = 0, update, closing = false
  const commands = new Map()
  const waiting = new Map()
  const streams = new Set()
  const sidecar = {
    connected: () => !!sidecarStream && Date.now()-heartbeat < 30000,
    send(command) {
      if (!sidecar.connected()) fail('TARGET_HARNESS_UNAVAILABLE',409)
      const requestId = randomUUID()
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => finish(false, 'Sidecar acknowledgement timed out'), 30000)
        function finish(ok,error,code,status) {
          clearTimeout(timer)
          commands.delete(requestId)
          if (ok) resolve()
          else reject(Object.assign(Error(error || 'Sidecar disconnected'),
            {code: code || 'TARGET_HARNESS_UNAVAILABLE', status: status || 409}))
        }
        commands.set(requestId,finish)
        sidecarStream.write('data: '+JSON.stringify({...command, requestId})+'\n\n')
      })
    }
  }
  const launcher = launcherFactory(config,sidecar)
  function capabilities() {
    return { serverMachineId:id, protocolVersion, pluginVersion, projects:Object.keys(config.projects),
      harnesses:harnesses.filter(h => launcher.available(h) || (h==='antigravity' && launcher.available(h,'cli'))),
      antigravityApp: launcher.available('antigravity'), antigravityCli:launcher.available('antigravity','cli') }
  }
  function sse(res) {
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'})
    res.write(': connected\n\n')
    streams.add(res)
    const timer = setInterval(() => res.write(': heartbeat\n\n'),15000)
    res.on('close', () => {clearInterval(timer); streams.delete(res)})
  }
  async function dispatch(req, res, client) {
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || !key.trim() || key.length>256) fail('IDEMPOTENCY_KEY_REQUIRED')
    const meta = JSON.parse(Buffer.from(req.headers['x-connecter-dispatch'] || '', 'base64url').toString())
    if (!meta || typeof meta !== 'object') fail('INVALID_DISPATCH')
    const {targetHarness,targetProject,targetSessionId,targetModel,reasoningEffort,antigravityMode,approvalMode='plan_first',bundleHash} = meta
    if (approvalMode !== 'plan_first' || (antigravityMode && !['app','cli'].includes(antigravityMode))) fail('INVALID_DISPATCH')
    for (const value of [targetSessionId,targetModel,reasoningEffort])
      if (value !== undefined && (typeof value!=='string' || !value || /[;\x00-\x1f\x7f]/.test(value))) fail('INVALID_DISPATCH')
    if (targetSessionId?.startsWith('-')) fail('INVALID_SESSION_ID')
    if (targetHarness === 'antigravity' && antigravityMode !== 'cli' && (reasoningEffort || (targetSessionId && targetModel)))
      fail('UNSUPPORTED_SESSION_OPTION', 400)
    if (!/^[a-f0-9]{64}$/.test(bundleHash)) fail('BUNDLE_HASH_REQUIRED')
    const spec = {targetHarness,targetProject,targetSessionId,targetModel,reasoningEffort,antigravityMode,approvalMode,bundleHash}
    const signature = digest(JSON.stringify(spec))
    const existing = store.existing(client,key,signature)
    if (existing) { req.resume(); return json(res,publicJob(existing)) }
    targets(spec,capabilities())
    if (!launcher.available(targetHarness,antigravityMode)) fail('TARGET_HARNESS_UNAVAILABLE',409)
    const job = {id:randomUUID(), runId:randomUUID(), ...spec, status:'queued', createdAt:Date.now()}
    const dir = join(jobsDir,job.id)
    await unpackBundle(req,dir,bundleHash)
    const token = secret()
    let persisted = false
    try {
      await writeFile(workerFile(config,job.id,job.runId), JSON.stringify({jobId:job.id,runId:job.runId,token}), {mode:0o600})
      const prior = store.change(() => {
        const cached = store.existing(client,key,signature)
        if (cached) return cached
        store.create(job,digest(token),client,key,signature)
        job.status = 'launching'
        store.save(job)
      })
      if (prior) return json(res,publicJob(prior))
      persisted = true
      await launcher.launch(job,dir)
      return json(res,publicJob(store.get(job.id)),201)
    } catch (error) {
      if (persisted) store.change(() => {
        const current = store.get(job.id)
        current.status = 'failed'
        current.error = error.code || error.message
        store.save(current)
      })
      throw error
    } finally {
      if (!persisted) await rm(dir,{force:true,recursive:true})
    }
  }

  async function respond(res, jobId, input) {
    const hasWaiter = waiting.has(jobId)
    const dir = join(jobsDir,jobId)
    const decision = store.change(() => {
      const recorded = store.respond(jobId,input)
      const decisionsDir = join(dir,'decisions')
      mkdirSync(decisionsDir,{recursive:true})
      const ref = recorded.proposalId || recorded.questionId
      writeFileSync(join(decisionsDir,'decision-'+recorded.seq+'.md'), '# '+recorded.action+'\n\n'+ref+'\n\n'+recorded.message+'\n')
      return recorded
    })
    const job = store.get(jobId)
    if (job.pendingSeq === decision.seq && job.status !== 'cancelled') {
      let result
      try { result = await launcher.wake(job,dir,hasWaiter) }
      catch { result = 'needs_resume' }
      if (result === 'needs_resume') store.change(() => {
        const latest = store.get(jobId)
        if (latest.pendingSeq === decision.seq) {latest.status='needs_resume'; store.save(latest)}
      })
    }
    json(res,decision)
  }

  function waitDecision(res,jobId,seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) fail('INVALID_TIMEOUT')
    const timer = setTimeout(() => finish(null), Math.min(seconds,55)*1000)
    waiting.set(jobId,(waiting.get(jobId)||0)+1)
    function cleanup() {
      clearTimeout(timer)
      store.off('changed',check)
      res.off('close',cleanup)
      const count = waiting.get(jobId)-1
      if (count) waiting.set(jobId,count)
      else waiting.delete(jobId)
    }
    function finish(decision,finished=false) {cleanup(); json(res,{decision,finished})}
    function check() {
      const job = store.get(jobId)
      const decision = store.decision(job)
      const finished = ['completed','failed','cancelled'].includes(job.status)
      if (decision || finished) finish(decision,finished)
    }
    res.once('close',cleanup)
    store.on('changed',check)
    check()
  }

  async function local(req,res,path) {
    const post = req.method === 'POST'
    if (path === '/local/sidecar/events' && req.method === 'GET') {
      if (req.headers.origin) fail('FORBIDDEN',403)
      if (sidecarStream) fail('SIDECAR_CONNECTED',409)
      sidecarStream = res
      heartbeat = Date.now()
      sse(res)
      res.on('close',() => {sidecarStream=undefined; for (const finish of commands.values()) finish(false)})
      return
    }
    if (path === '/local/sidecar/heartbeat' && post) {
      if (req.headers.origin) fail('FORBIDDEN',403)
      const message = await body(req)
      heartbeat = Date.now()
      if (message.requestId) commands.get(message.requestId)?.(message.ok,message.error,message.code,message.status)
      return json(res,{ok:true})
    }
    const match = /^\/local\/jobs\/([^/]+)\/(register|reports|wait-decision|ack-decision)$/.exec(path)
    if (!match || !post) fail('NOT_FOUND',404)
    const [,jobId,action] = match
    const row = store.db.prepare('SELECT doc,workerHash FROM jobs WHERE id=?').get(jobId)
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
    if (!row || !matches(token,row.workerHash) || req.headers['x-run-id'] !== JSON.parse(row.doc).runId)
      fail('WORKER_UNAUTHORIZED',403)
    const input = await body(req)
    if (action === 'register') {
      const job = store.change(()=>store.register(jobId,input))
      launcher.registered(jobId)
      const dir = join(jobsDir,jobId)
      return json(res,{job:publicJob(job),dir,plan:join(dir,'PLAN.md'),context:join(dir,'CONTEXT'),
        decision:store.decision(job)})
    }
    if (action === 'wait-decision') return waitDecision(res,jobId,input.seconds ?? 50)
    if (action === 'ack-decision') {
      const job = store.change(()=>store.ack(jobId,input.seq))
      launcher.registered(jobId)
      return json(res,publicJob(job))
    }
    if (typeof input.text !== 'string' || !input.text.trim()) fail('REPORT_TEXT_REQUIRED')
    const report = store.change(()=>store.report(jobId,input))
    return json(res,report,201)
  }

  async function lan(req,res,path) {
    const get = req.method==='GET', post = req.method==='POST'
    if (get && path==='/') {
      res.writeHead(200,{
        'Content-Type':'text/html; charset=utf-8',
        'Referrer-Policy':'no-referrer',
        'X-Content-Type-Options':'nosniff',
        'X-Frame-Options':'DENY',
        'Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
      })
      return res.end(await readFile(dashboard))
    }
    if (get && path==='/health') return json(res,{ok:true,serverMachineId:id,protocolVersion,pluginVersion})
    if (!path.startsWith('/api/')) fail('NOT_FOUND',404)
    if (post && path==='/api/pair') {
      const input = await body(req)
      const result = store.change(()=>pair(store.db,input))
      if (!result) fail('PAIR_DENIED',403)
      return json(res,result)
    }
    const client = clientAuth(store.db,req.headers.authorization)
    if (req.headers['x-server-machine-id'] && req.headers['x-server-machine-id']!==id) fail('MACHINE_ID_MISMATCH',409)
    if (req.headers['x-protocol-version'] && req.headers['x-protocol-version']!==String(protocolVersion)) fail('VERSION_MISMATCH',409)
    if (req.headers['x-plugin-version'] && req.headers['x-plugin-version'].split('.')[0]!==pluginVersion.split('.')[0]) fail('VERSION_MISMATCH',409)
    if (get && path==='/api/capabilities') return json(res,capabilities())
    if (get && path==='/api/jobs') return json(res,store.jobs().map(publicJob))
    if (post && path==='/api/jobs') return dispatch(req,res,client)
    if (get && path==='/api/events') {
      const rawCursor = req.headers['last-event-id']
      let cursor = rawCursor === 'latest'
        ? store.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id
        : Number(rawCursor || 0)
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail('INVALID_CURSOR')
      sse(res)
      function deliver() {
        if (!store.db.prepare('SELECT 1 FROM clients WHERE id=?').get(client)) return res.end()
        if (res.writableNeedDrain) return
        for (const event of store.events(cursor)) {
          cursor = event.id
          if (!res.write('id: '+cursor+'\ndata: '+JSON.stringify(event)+'\n\n')) break
        }
      }
      // Revocation may be issued by a separate CLI process.
      const poll = setInterval(deliver,5000)
      store.on('changed',deliver)
      res.on('drain',deliver)
      res.on('close',()=>{clearInterval(poll);store.off('changed',deliver)})
      return deliver()
    }
    const match = /^\/api\/jobs\/([^/]+)(\/respond)?$/.exec(path)
    if (match && get && !match[2]) {
      const history = store.history(match[1])
      history.job = publicJob(history.job)
      return json(res,history)
    }
    if (match && post && match[2]) return respond(res,match[1],await body(req))
    if (get && config.serveUpdates && ['/api/update/manifest','/api/update/bundle'].includes(path)) {
      update ??= createUpdate(config).catch(error=>{update=undefined;throw error})
      const {manifest,bundlePath} = await update
      if (path.endsWith('manifest')) return json(res,manifest)
      res.writeHead(200,{'Content-Type':'application/gzip'})
      const stream = createReadStream(bundlePath)
      stream.on('error',e=>res.destroy(e))
      res.on('close',()=>stream.destroy())
      return stream.pipe(res)
    }
    fail('NOT_FOUND',404)
  }

  function listen(handler) {
    return http.createServer(async (req,res) => {
      res.setHeader('X-Protocol-Version',protocolVersion)
      res.setHeader('X-Plugin-Version',pluginVersion)
      res.setHeader('X-Server-Machine-Id',id)
      try { await handler(req,res,req.url.split('?')[0]) }
      catch (error) {
        if (res.destroyed || res.headersSent) return res.destroy()
        const status = error.status || (error instanceof SyntaxError ? 400 : 500)
        json(res,{error:error.status ? error.code : status===400?'INVALID_JSON':'INTERNAL_ERROR'},status)
        if (status===500) console.error(error)
      }
    })
  }
  const lanServer = listen(lan), localServer = listen(local)
  async function close() {
    if (closing) return
    closing = true
    for (const res of streams) res.end()
    launcher.close()
    await Promise.all([lanServer,localServer].map(s => new Promise(resolve => {
      s.close(resolve)
      s.closeAllConnections()
    })))
    store.db.close()
  }
  try {
    localServer.listen(config.localPort,'127.0.0.1')
    await once(localServer,'listening')
    lanServer.listen(config.lanPort,config.lanHost || '0.0.0.0')
    await once(lanServer,'listening')
  } catch (error) { await close(); throw error }
  return {store,lanServer,localServer,close}
}
