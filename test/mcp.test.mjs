import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, rm, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import { startServer } from '../src/server/http.mjs'

test('CLI pairing and three MCP roles over actual stdio, including tools dispatch to worker completion',async t=>{
  const root=await mkdtemp(join(process.cwd(),'.stdio-test-'))
  const config={mode:'both',lanHost:'127.0.0.1',lanPort:0,localPort:0,projects:{demo:root},
    dataDir:join(root,'data'),previewDir:join(root,'preview'),sourceHome:root}
  const server=await startServer(config,()=>({available:h=>h==='codex',launch(){},wake(){},registered(){},close(){}}))
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true})})
  config.localPort=server.localServer.address().port
  const setMode=mode=>writeFile(join(root,'config.json'),JSON.stringify({...config,mode}))
  await setMode('both')
  const url='http://127.0.0.1:'+server.lanServer.address().port
  async function run(bin,args,input=''){
    const stdin=join(root,'in'),stdout=join(root,'out'),stderr=join(root,'err')
    await writeFile(stdin,input)
    const files=await Promise.all([open(stdin,'r'),open(stdout,'w'),open(stderr,'w')])
    try{
      const proc=spawn(process.execPath,['bin/connecter-'+bin+'.mjs',...args],{
        stdio:files.map(f=>f.fd),shell:false,windowsHide:true,env:{...process.env,AGENT_CONNECTER_HOME:root}})
      const [rc]=await once(proc,'exit')
      assert.equal(rc,0,await readFile(stderr,'utf8'))
      return (await readFile(stdout,'utf8')).trim()
    }finally{await Promise.all(files.map(f=>f.close()))}
  }
  const rpc=(id,method,params)=>({jsonrpc:'2.0',id,method,params})
  const stdio=async(...messages)=>(await run('mcp',[],messages.map(msg=>typeof msg==='string'?msg:JSON.stringify(msg)).join('\n')+'\n'))
    .split('\n').map(line=>JSON.parse(line))
  async function call(name,args){
    const [r]=await stdio(rpc(1,'tools/call',{name:'connecter_'+name,arguments:args}))
    assert.equal(r.result.isError,undefined,r.result.content[0].text)
    return JSON.parse(r.result.content[0].text)
  }
  const pin=await run('cli',['pair'])
  assert.match(pin,/^\d{6}$/)
  const paired=JSON.parse(await run('cli',['link',url,'--code',pin,'--name','cli-test']))
  assert.equal(paired.serverUrl,url)
  for (const [mode,count] of [['client',9],['server',4],['both',13]]){
    await setMode(mode)
    const replies=await stdio('{broken',rpc(0,'initialize',{protocolVersion:'2025-06-18'}),
      {jsonrpc:'2.0',method:'notifications/initialized'},rpc(1,'tools/list'))
    assert.equal(replies[0].error.code,-32700)
    assert.equal(replies[1].result.serverInfo.name,'agent-connecter')
    assert.equal(replies[1].result.protocolVersion,'2025-06-18')
    assert.equal(replies[2].result.tools.length,count)
    const names=replies[2].result.tools.map(t=>t.name)
    assert.equal(names.includes('connecter_dispatch'),mode!=='server')
    assert.equal(names.includes('connecter_ack_decision'),mode!=='client')
    if(mode==='client') {
      const [denied]=await stdio(rpc(1,'tools/call',{name:'connecter_job_context',arguments:{}}))
      assert.equal(denied.result.content[0].text,'UNKNOWN_TOOL')
    }
  }
  const caps=await call('targets')
  assert.deepEqual(caps.harnesses,['codex'])
  const preview=await call('pack_preview',{plan:'Run local tests',sources:[]})
  const args={bundleHash:preview.bundleHash,targetHarness:'codex',targetProject:'demo',idempotencyKey:'stdio'}
  const job=await call('dispatch',args)
  assert.equal(job.status,'launching')
  const ids={jobId:job.id,runId:server.store.get(job.id).runId}
  const context=await call('job_context',{...ids,harnessSessionId:'stdio-session',pid:process.pid})
  assert.equal(await readFile(context.plan,'utf8'),'Run local tests')
  const proposal=await call('submit_report',{...ids,kind:'plan_proposal',text:'I checked the code'})
  const approval=JSON.parse(await run('cli',['approve','--job',job.id,'--proposal',proposal.proposalId]))
  const pending=JSON.parse(await run('cli',['wait-decision','--job',job.id,'--once']))
  assert.equal(pending.decision.seq,approval.seq)
  await call('ack_decision',{...ids,seq:approval.seq})
  await call('submit_report',{...ids,kind:'completed',text:'Tests passed'})
  assert.equal((await call('get_report',{jobId:job.id})).job.status,'completed')
  const revoked=JSON.parse(await run('cli',['revoke','cli-test']))
  assert.equal(revoked.revoked,1)
})
