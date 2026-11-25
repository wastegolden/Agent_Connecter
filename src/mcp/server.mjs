import { createInterface } from 'node:readline'
import { listSessions, packPreview } from '../packer/index.mjs'
import { remote, credentials, dispatch, workerRequest } from '../client/http.mjs'
import { fail, harnesses, pluginVersion } from '../config.mjs'

const str = {type:'string'}
const harness = {type:'string',enum:harnesses}
const job = {jobId:str,runId:str}
const jobFields = Object.keys(job)
const clientTools = [
  ['targets','List available harnesses and the server project whitelist.'],
  ['local_sessions','Find local transcripts available for explicit selection.',{harness}],
  ['pack_preview','Freeze a redacted local plan and selected transcripts for dispatch.',{
    plan:str,sources:{type:'array',items:{type:'object',properties:{harness,id:str,origin:{enum:['app','cli']}},required:['harness','id']}},
    includeThinking:{type:'boolean'},includeHistory:{type:'boolean'},attachToolResults:{type:'boolean'}},['plan']],
  ['dispatch','Upload the exact frozen preview. Reuse the key when retrying.',{
    targetHarness:harness,targetProject:str,bundleHash:str,idempotencyKey:str,targetSessionId:str,targetModel:str,
    reasoningEffort:str,antigravityMode:{enum:['app','cli']}},['targetHarness','targetProject','bundleHash','idempotencyKey']],
  ['jobs','List jobs and their current status.'],
  ['get_report','Read a job, its reports and decision history.',{jobId:str},['jobId']],
  ['respond','Respond to the current proposal or question using its exact ID.',{
    jobId:str,action:{enum:['approve','revise','reply','cancel']},proposalId:str,questionId:str,message:str},['jobId','action']]
]
const serverTools = [
  ['job_context','Register the actual harness session and CLI PID. Return local plan and context paths.',{
    ...job,harnessSessionId:str,pid:{type:'integer',minimum:1}},[...jobFields,'harnessSessionId','pid']],
  ['submit_report','Submit plan, progress, question or final evidence as Markdown.',{
    ...job,kind:{enum:['plan_proposal','progress','needs_input','completed','failed']},text:str},[...jobFields,'kind','text']],
  ['wait_decision','Wait up to 55 seconds for a pending decision.',{...job,seconds:{type:'number',minimum:0,maximum:55}},jobFields],
  ['ack_decision','Acknowledge a decision sequence before continuing.',{...job,seq:{type:'integer'}},[...jobFields,'seq']]
]

const workerActions = {job_context:'register',submit_report:'reports',wait_decision:'wait-decision',ack_decision:'ack-decision'}

export function toolService(config) {
  const defs = [...(config.mode==='server'?[]:clientTools), ...(config.mode==='client'?[]:serverTools)]
  const tools = defs.map(([key,description,properties={},required=[]])=>({name:'connecter_'+key,description,
    inputSchema:{type:'object',properties,required,additionalProperties:false}}))
  async function call(name,args={}) {
    const tool = tools.find(t=>t.name===name)
    if (!tool) fail('UNKNOWN_TOOL',404)
    const key = name.slice('connecter_'.length)
    if (!args || Array.isArray(args) || typeof args !== 'object' ||
        Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k))) fail('INVALID_ARGUMENTS')
    if (Object.hasOwn(workerActions,key)) return workerRequest(config,workerActions[key],args)
    const options = {home:config.sourceHome,previewDir:config.previewDir,tempDir:config.previewDir}
    if (key==='local_sessions') return listSessions({...options,...args})
    if (key==='pack_preview') return packPreview({...options,...args})
    const request = remote(await credentials())
    if (key==='dispatch') return dispatch(config,request,args)
    if (key==='targets') return (await request('/api/capabilities')).json()
    if (key==='jobs') return (await request('/api/jobs')).json()
    const {jobId,...decision} = args
    if (!jobId) fail('JOB_ID_REQUIRED')
    const path = '/api/jobs/'+encodeURIComponent(jobId)
    if (key==='get_report') return (await request(path)).json()
    return (await request(path+'/respond',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(decision)})).json()
  }
  return {tools,call}
}

export async function serveStdio(config,input=process.stdin,output=process.stdout) {
  const service = toolService(config)
  const work = new Set()
  async function handle(line) {
    let id=null
    const send = value=>output.write(JSON.stringify({jsonrpc:'2.0',id,...value})+'\n')
    let msg
    try { msg=JSON.parse(line) } catch { return send({error:{code:-32700,message:'Parse error'}}) }
    if (!msg || msg.jsonrpc!=='2.0' || typeof msg.method!=='string') return send({error:{code:-32600,message:'Invalid request'}})
    if (!Object.hasOwn(msg,'id')) return
    id=msg.id
    if (msg.method==='initialize') {
      const versions=['2025-11-25','2025-06-18','2025-03-26','2024-11-05']
      return send({result:{protocolVersion:versions.includes(msg.params?.protocolVersion)?msg.params.protocolVersion:versions[0],
        capabilities:{tools:{}},serverInfo:{name:'agent-connecter',version:pluginVersion}}})
    }
    if (msg.method==='ping') return send({result:{}})
    if (msg.method==='tools/list') return send({result:{tools:service.tools}})
    if (msg.method!=='tools/call') return send({error:{code:-32601,message:'Method not found'}})
    try {
      const data = await service.call(msg.params?.name,msg.params?.arguments)
      send({result:{content:[{type:'text',text:JSON.stringify(data)}]}})
    } catch (error) {
      send({result:{isError:true,content:[{type:'text',text:error.code || error.message}]}})
    }
  }
  for await (const line of createInterface({input,crlfDelay:Infinity})) {
    const p=handle(line)
    work.add(p)
    p.finally(()=>work.delete(p))
  }
  await Promise.all(work)
}
