import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { startServer } from '../src/server/http.mjs'
import { machineId, pairingCode, revoke, digest } from '../src/auth.mjs'
import { credentials, link, remote, dispatch, workerRequest, events } from '../src/client/http.mjs'
import { packPreview } from '../src/packer/index.mjs'
import { Store } from '../src/store.mjs'

const post = data => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
const code = name => error => error.code === name
async function fixture(t) {
  const root = await mkdtemp(join(process.cwd(),'.relay-test-'))
  const config = {mode:'both',lanHost:'127.0.0.1',localPort:0,lanPort:0,projects:{demo:root},
    sourceHome:join(root,'home'),previewDir:join(root,'previews'),dataDir:join(root,'data')}
  const launches = [], wakes = []
  const server = await startServer(config, (config,sidecar)=>({
    available:(h,mode)=>['codex','claude-code'].includes(h) || (h==='antigravity' && (mode==='cli'||sidecar.connected())),
    launch:async job=>{launches.push(job);if(job.targetHarness==='antigravity' && job.antigravityMode!=='cli')
      await sidecar.send({pointer:'Read PROMPT.md',cwd:root})},
    wake:async (job,dir,waiting)=>{wakes.push(job);return waiting ? undefined : 'needs_resume'},registered(){},close(){}
  }))
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true})})
  const {db} = server.store
  config.localPort=server.localServer.address().port
  const local='http://127.0.0.1:'+config.localPort
  const lan='http://127.0.0.1:'+server.lanServer.address().port
  const enroll = async (code,clientName='desktop')=>fetch(lan+'/api/pair',post({code,clientName}))
  const creds = {...await(await enroll(pairingCode(db))).json(),serverUrl:lan}
  const request=remote(creds)
  const preview = await packPreview({previewDir:config.previewDir,plan:'Inspect the local code.'})
  const spec = {targetProject:'demo',targetHarness:'codex',bundleHash:preview.bundleHash}
  const send=(extra={})=>dispatch(config,request,{...spec,idempotencyKey:randomUUID(),...extra})
  const raw=(meta=spec,key=randomUUID(),body)=>fetch(lan+'/api/jobs',{method:'POST',body:body??'',
    headers:{Authorization:'Bearer '+creds.token,'Idempotency-Key':key,'X-Connecter-Dispatch':Buffer.from(JSON.stringify(meta)).toString('base64url')}})
  async function worker(job) {
    const dir=join(config.dataDir,'jobs',job.id)
    const file=(await readdir(dir)).find(name=>name.startsWith('worker-'))
    const credential=JSON.parse(await readFile(join(dir,file),'utf8'))
    return {dir,...credential,call:(action,params={})=>workerRequest(config,action,{
      jobId:job.id,runId:credential.runId,...params})}
  }
  return {root,config,db,server,lan,local,enroll,creds,request,send,raw,spec,preview,worker,launches,wakes}
}

test('dual listener routing, pairing expiry, lockout, single use, token hashing and revocation',async t=>{
  const {lan,local,enroll,db,creds,request,server}=await fixture(t)
  assert.equal(server.localServer.address().address,'127.0.0.1')
  for(const path of ['/api/jobs','/api/events','/health','/']) assert.equal((await fetch(local+path)).status,404)
  for(const path of ['/local/jobs/x/register','/local/sidecar/heartbeat','/local/sidecar/events'])
    assert.equal((await fetch(lan+path,post({}))).status,404)
  assert.equal((await fetch(lan+'/api/jobs?token='+creds.token)).status,401)
  const html=await(await fetch(lan+'/')).text()
  assert.match(html,/textContent/);assert.doesNotMatch(html,/innerHTML|localStorage|EventSource/)
  let pin=pairingCode(db)
  for(let i=0;i<5;i++) assert.equal((await enroll('x')).status,403)
  assert.equal((await enroll(pin)).status,403)
  pin=pairingCode(db)
  db.exec('UPDATE pairing SET expires=0')
  assert.equal((await enroll(pin)).status,403)
  pin=pairingCode(db)
  const attempts=await Promise.all([enroll(pin,'other'),enroll(pin,'other')])
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,403])
  const {token,serverMachineId}=await attempts.find(r=>r.ok).json()
  assert.equal(token.length,64);assert.equal(serverMachineId,creds.serverMachineId)
  assert.match(serverMachineId,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  assert.equal(db.prepare('SELECT hash FROM clients WHERE name=?').get('other').hash,digest(token))
  assert.equal((await request('/api/capabilities')).headers.get('x-protocol-version'),'1')
  assert.equal(revoke(db,'desktop'),1)
  await assert.rejects(request('/api/jobs'),code('UNAUTHORIZED'))
  assert.equal((await fetch(lan+'/api/jobs',{headers:{Authorization:'Bearer '+token}})).status,200)
})

test('client persists TOFU pin; replaced machine, version mismatch and redirects fail before bearer disclosure',async t=>{
  const {root,db,lan,creds}=await fixture(t)
  const old=process.env.AGENT_CONNECTER_HOME
  process.env.AGENT_CONNECTER_HOME=join(root,'client')
  t.after(()=>{if(old===undefined) delete process.env.AGENT_CONNECTER_HOME;else process.env.AGENT_CONNECTER_HOME=old})
  const linked=await link(lan,pairingCode(db),'cli')
  assert.equal(linked.serverMachineId,machineId(db))
  assert.equal((await credentials()).clientId,linked.clientId)
  let version='1.0.0', replacement=randomUUID(), redirect=false
  const seen=[]
  const fake=createServer((req,res)=>{
    seen.push([req.url,req.headers.authorization])
    res.writeHead(redirect?302:200,{'X-Protocol-Version':1,'X-Plugin-Version':version,'X-Server-Machine-Id':replacement,Location:lan+'/health'})
    res.end('{}')
  })
  fake.listen(0,'127.0.0.1');await once(fake,'listening')
  t.after(()=>new Promise(resolve=>{fake.close(resolve);fake.closeAllConnections()}))
  const url='http://127.0.0.1:'+fake.address().port
  const request=remote({...creds,serverUrl:url})
  await assert.rejects(request('/api/jobs'),code('MACHINE_ID_MISMATCH'))
  await assert.rejects(link(url,'000000'),code('MACHINE_ID_MISMATCH'))
  replacement=machineId(db);version='2.0.0'
  await assert.rejects(request('/api/jobs'),code('VERSION_MISMATCH'))
  version='1.0.0';redirect=true
  await assert.rejects(request('/api/jobs'))
  assert.ok(seen.every(([path,auth])=>path==='/health' && !auth))
})

test('dispatch requires both targets on each boundary, permits parallel jobs, deduplicates retries and rejects session collisions',async t=>{
  const {send,raw,spec,launches,db,worker,request,preview}=await fixture(t)
  for (const [bad,error] of [
    [{targetHarness:undefined},'TARGET_HARNESS_REQUIRED'],[{targetHarness:'dsh'},'TARGET_HARNESS_UNAVAILABLE'],
    [{targetProject:undefined},'TARGET_PROJECT_UNKNOWN'],[{targetProject:'unknown'},'TARGET_PROJECT_UNKNOWN'],
    [{targetHarness:'antigravity'},'TARGET_HARNESS_UNAVAILABLE']]) {
    await assert.rejects(send(bad),code(error))
    assert.equal((await (await raw({...spec,...bad})).json()).error,error)
  }
  const broken=await raw(spec,'broken',await readFile(preview.bundlePath).then(b=>b.subarray(0,5)))
  assert.equal(broken.status,400)
  const wrongHash = await raw({...spec,bundleHash:'0'.repeat(64)},'wrong-hash',await readFile(preview.bundlePath))
  assert.equal((await wrongHash.json()).error,'BUNDLE_HASH_MISMATCH')
  const pair=await Promise.all([send({idempotencyKey:'repeat',targetSessionId:'one'}),send({idempotencyKey:'repeat',targetSessionId:'one'})])
  assert.equal(pair[0].id,pair[1].id)
  assert.equal(launches.length,1)
  await assert.rejects(send({targetSessionId:'one'}),code('SESSION_BUSY'))
  await assert.rejects(send({idempotencyKey:'repeat',targetSessionId:'else'}),code('IDEMPOTENCY_CONFLICT'))
  const racing=await Promise.allSettled([send({targetSessionId:'race'}),send({targetSessionId:'race'})])
  assert.equal(racing.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(racing.find(r=>r.status==='rejected').reason.code,'SESSION_BUSY')
  const multiple=await Promise.all(Array.from({length:6},(_,i)=>send({targetSessionId:'parallel-'+i})))
  assert.equal(new Set(multiple.map(j=>j.id)).size,6)
  const fresh=await send(), w=await worker(fresh)
  await assert.rejects(w.call('register',{harnessSessionId:'one',pid:1}),code('SESSION_BUSY'))
  await w.call('register',{harnessSessionId:'actual',pid:process.pid})
  await assert.rejects(send({targetSessionId:'actual'}),code('SESSION_BUSY'))
  await w.call('reports',{kind:'failed',text:'Session ended'})
  await send({targetSessionId:'actual'})
  db.prepare('UPDATE dedupe SET at=0 WHERE key=?').run('repeat')
  await send({idempotencyKey:'repeat',targetSessionId:'new'})
  assert.ok((await (await request('/api/jobs')).json()).every(j=>!j.runId && !j.token))
})

test('worker capabilities bind both job and run; proposals, decisions, questions and acks survive reconnection',async t=>{
  const {send,worker,request,local,wakes,config,server}=await fixture(t)
  const job=await send(), second=await send(), w=await worker(job)
  for (const [id,runId] of [[second.id,w.runId],[job.id,randomUUID()]]) {
    const res=await fetch(local+'/local/jobs/'+id+'/reports',{...post({kind:'failed',text:'wrong credential'}),
      headers:{Authorization:'Bearer '+w.token,'X-Run-Id':runId}})
    assert.equal(res.status,403)
  }
  const state=()=>server.store.get(job.id).status
  const register=await w.call('register',{harnessSessionId:'active',pid:process.pid})
  assert.equal(register.job.status,'planning')
  const report=(kind,text)=>w.call('reports',{kind,text})
  const respond=async input=>(await request('/api/jobs/'+job.id+'/respond',post(input))).json()
  const ack=seq=>w.call('ack-decision',{seq})
  await assert.rejects(report('completed','premature'),code('REPORT_OUT_OF_PHASE'))
  const v1=await report('plan_proposal','Verified repository. Split modules A and B.')
  const revise=await respond({proposalId:v1.proposalId,action:'revise',message:'Include C'})
  assert.equal(state(),'needs_resume')
  assert.equal((await w.call('wait-decision',{seconds:0})).decision.seq,revise.seq)
  assert.equal((await ack(revise.seq)).status,'planning')
  const v2=await report('plan_proposal','Include C')
  assert.equal(v2.version,2);assert.notEqual(v2.proposalId,v1.proposalId)
  await assert.rejects(respond({proposalId:v1.proposalId,action:'approve'}),code('DECISION_STALE'))
  const listening = new Promise(resolve=>server.store.once('newListener',resolve))
  const waiting=w.call('wait-decision',{seconds:10})
  assert.equal(await listening,'changed')
  const approved=await respond({proposalId:v2.proposalId,action:'approve'})
  assert.equal(wakes.length,2)
  assert.equal(state(),'approved')
  assert.deepEqual((await waiting).decision,approved)
  await assert.rejects(ack(approved.seq+1),code('DECISION_STALE'))
  await assert.rejects(ack(revise.seq),code('DECISION_STALE'))
  assert.equal((await ack(approved.seq)).status,'executing')
  assert.equal((await ack(approved.seq)).status,'executing')
  await report('progress','Tests running')
  const q=await report('needs_input','Choose a fixture')
  await assert.rejects(respond({questionId:'obsolete',action:'reply',message:'one'}),code('DECISION_STALE'))
  await assert.rejects(respond({questionId:q.questionId,action:'approve'}),code('INVALID_DECISION'))
  const reply=await respond({questionId:q.questionId,action:'reply',message:'fixture A'})
  assert.equal((await readFile(join(w.dir,'decisions','decision-'+reply.seq+'.md'),'utf8')).includes('fixture A'),true)
  assert.equal((await ack(reply.seq)).status,'executing')
  await report('completed','Changed a.mjs. Test suite passed.')
  assert.equal((await w.call('wait-decision',{seconds:0})).finished,true)
  await assert.rejects(report('progress','late'),code('REPORT_OUT_OF_PHASE'))
  const reopened=new Store(config.dataDir)
  try {
    const {job:read,reports,decisions}=reopened.history(job.id)
    assert.equal(read.status,'completed');assert.equal(reports.length,5);assert.equal(decisions.length,3)
    assert.equal(machineId(reopened.db),machineId(server.store.db))
  } finally {reopened.db.close()}
  const other=await worker(second)
  await other.call('register',{harnessSessionId:'cancel-me',pid:process.pid})
  const p=await other.call('reports',{kind:'plan_proposal',text:'Ready'})
  await request('/api/jobs/'+second.id+'/respond',post({proposalId:p.proposalId,action:'cancel'}))
  assert.equal(server.store.get(second.id).status,'cancelled')
})

test('HTTP expansion overflow returns 413 and leaves no job or launch behind',async t=>{
  const {raw,spec,config,launches}=await fixture(t)
  const chunk=Buffer.alloc(1024*1024)
  const zipped=Readable.from((function*(){for(let i=0;i<129;i++)yield chunk})()).pipe(createGzip({level:1}))
  const compressed=[]
  for await(const part of zipped) compressed.push(part)
  const bytes=Buffer.concat(compressed)
  const response=await raw({...spec,bundleHash:digest(bytes)},'oversize',bytes)
  assert.equal(response.status,413)
  assert.equal((await response.json()).error,'BUNDLE_TOO_LARGE')
  assert.deepEqual(await readdir(join(config.dataDir,'jobs')),[])
  assert.equal(launches.length,0)
})

test('worker long poll clamps its timeout to 55 seconds',async t=>{
  const {send,worker}=await fixture(t)
  const w=await worker(await send())
  const original=globalThis.setTimeout
  const waits=[]
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{
    if (ms >= 55000) {
      waits.push(ms)
      return original(fn,0,...args)
    }
    return original(fn,ms,...args)
  })
  const result=await w.call('wait-decision',{seconds:600})
  assert.equal(result.decision,null)
  assert.ok(waits.includes(55000))
  assert.ok(!waits.includes(600000))
})

test('SSE resumes after Last-Event-ID, respects retention, exposes live sidecar availability',async t=>{
  const {send,worker,request,local,server}=await fixture(t)
  const job=await send()
  const sub=new AbortController()
  const stream=events(await request('/api/events',{signal:sub.signal}))
  const initial=(await stream.next()).value
  sub.abort()
  await stream.return()
  const worker1=await worker(job)
  await worker1.call('register',{harnessSessionId:'sse',pid:2})
  const again=new AbortController()
  const replay=events(await request('/api/events',{signal:again.signal,headers:{'Last-Event-ID':String(initial.id)}}))
  assert.deepEqual([(await replay.next()).value.status,(await replay.next()).value.status],['launching','planning'])
  again.abort();await replay.return()
  const store=server.store
  store.change(()=>{for(let i=0;i<505;i++)store.save(store.get(job.id))})
  assert.equal(store.events(0).length,500)
  store.db.exec('UPDATE events SET at=0')
  assert.equal(store.events(0).length,0)
  const side=new AbortController()
  const commands=events(await fetch(local+'/local/sidecar/events',{signal:side.signal}))
  assert.equal((await (await request('/api/capabilities')).json()).antigravityApp,true)
  const dispatching=send({targetHarness:'antigravity'})
  const command=(await commands.next()).value
  assert.equal(command.pointer,'Read PROMPT.md')
  await fetch(local+'/local/sidecar/heartbeat',post({requestId:command.requestId,ok:true}))
  assert.equal((await dispatching).targetHarness,'antigravity')
  // Browser Origin on loopback sidecar is rejected; invalid App options fail before persisting.
  assert.equal((await fetch(local+'/local/sidecar/heartbeat',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:'{}'})).status,403)
  await assert.rejects(send({targetHarness:'antigravity',reasoningEffort:'high'}),code('UNSUPPORTED_SESSION_OPTION'))
  await assert.rejects(send({targetSessionId:'-bad'}),code('INVALID_SESSION_ID'))
  const badDispatch=send({targetHarness:'antigravity'})
  const badCmd=(await commands.next()).value
  await fetch(local+'/local/sidecar/heartbeat',post({requestId:badCmd.requestId,ok:false,error:'wrong workspace',code:'TARGET_PROJECT_UNKNOWN',status:409}))
  await assert.rejects(badDispatch,code('TARGET_PROJECT_UNKNOWN'))
  // Last-Event-ID: latest skips historical backlog
  const latestCtrl=new AbortController()
  const latestRes=await request('/api/events',{signal:latestCtrl.signal,headers:{'Last-Event-ID':'latest'}})
  assert.equal(latestRes.status,200)
  latestCtrl.abort()
  side.abort();await commands.return()
})

test('remote sessions listing and redacted transcript extraction with paging',async t=>{
  const {request,config}=await fixture(t)
  const dir=join(config.sourceHome,'.claude','projects','demo-proj')
  await mkdir(join(dir,'memory'),{recursive:true})
  await writeFile(join(dir,'memory','MEMORY.md'),'Saved note with sk-secretTokenValue123456\n')
  await writeFile(join(dir,'sess-1.jsonl'),[
    JSON.stringify({type:'user',cwd:'/repo',sessionId:'sess-1',slug:'整理测试',message:{content:'请整理 sk-secretTokenValue123456 的记录'}}),
    JSON.stringify({type:'assistant',cwd:'/repo',sessionId:'sess-1',message:{content:[{type:'text',text:'已完成整理并核实结论。'}]}})
  ].join('\n')+'\n')
  const list=await (await request('/api/sessions?harness=claude-code')).json()
  assert.equal(list.length,1)
  assert.equal(list[0].id,'sess-1')
  assert.equal(list[0].title,'整理测试')
  assert.equal(list[0].archived,null)
  assert.ok(list[0].updatedAt)
  // Antigravity annotation archived:true is detected and filtered by activeOnly=true
  const agLogs=join(config.sourceHome,'.gemini','antigravity','brain','ag-arch','.system_generated','logs')
  await mkdir(agLogs,{recursive:true})
  await writeFile(join(agLogs,'transcript.jsonl'),JSON.stringify({step_index:0,type:'USER_INPUT',content:'hi'})+'\n')
  const agAnn=join(config.sourceHome,'.gemini','antigravity','annotations')
  await mkdir(agAnn,{recursive:true})
  await writeFile(join(agAnn,'ag-arch.pbtxt'),'title:"Archived Task" archived:true\n')
  const agAll=await (await request('/api/sessions?harness=antigravity')).json()
  assert.equal(agAll[0].archived,true)
  assert.equal(agAll[0].title,'Archived Task')
  const agActive=await (await request('/api/sessions?harness=antigravity&activeOnly=true')).json()
  assert.equal(agActive.length,0)
  await assert.rejects(request('/api/sessions?harness=dsh'),code('HARNESS_UNKNOWN'))
  const full=await (await request('/api/sessions/extract',post({harness:'claude-code',id:'sess-1'}))).json()
  assert.equal(full.complete,true)
  assert.equal(full.session.id,'sess-1')
  assert.equal(full.stats.redactedCount,2)
  assert.ok(full.files.some(f=>f.path==='transcript.jsonl' && f.text.includes('已完成整理') && !f.text.includes('sk-secretTokenValue123456')))
  assert.ok(full.files.some(f=>f.path==='memory/MEMORY.md' && f.text.includes('[REDACTED]')))
  const page1=await (await request('/api/sessions/extract',post({harness:'claude-code',id:'sess-1',file:'transcript.jsonl',offset:0,limit:40}))).json()
  assert.equal(page1.complete,false)
  assert.equal(page1.files[0].nextOffset,40)
  const page2=await (await request('/api/sessions/extract',post({harness:'claude-code',id:'sess-1',file:'transcript.jsonl',offset:40,limit:10000}))).json()
  assert.equal(page2.complete,true)
  assert.equal(page1.files[0].text+page2.files[0].text, full.files.find(f=>f.path==='transcript.jsonl').text)
  await assert.rejects(request('/api/sessions/extract',post({harness:'claude-code',id:'missing'})),code('SESSION_NOT_FOUND'))
})
