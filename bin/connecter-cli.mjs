#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { credentials, link, remote } from '../src/client/http.mjs'
import { toolService } from '../src/mcp/server.mjs'
import { updateClient } from '../src/client/updater.mjs'

const [command,...argv] = process.argv.slice(2)
const help = `connecter-cli pair | revoke NAME | link URL --code CODE [--name NAME]
connecter-cli targets | local-sessions [--harness HARNESS] [--active-only] | remote-sessions [--harness HARNESS] [--active-only] | jobs | report --job UUID
connecter-cli remote-read --harness HARNESS --session ID [--origin app|cli] [--file PATH] [--offset N] [--limit N] [--out FILE] [--include-thinking] [--include-history] [--no-memories]
connecter-cli pack --plan FILE [--sources FILE] [--include-thinking] [--include-history]
connecter-cli dispatch --bundle HASH --harness HARNESS --project KEY --key IDEMPOTENCY_KEY
    [--session ID] [--model MODEL] [--effort EFFORT] [--antigravity-mode app|cli]
connecter-cli approve|revise|cancel|reply --job UUID --proposal ID|--question ID [--message TEXT]
connecter-cli wait-decision --job UUID [--run UUID] [--once]
connecter-cli update`
async function main() {
  if (!command || ['help','--help','-h'].includes(command)) return help
  const strings = ['name','code','job','run','plan','sources','bundle','harness','project','key','session','model',
    'effort','antigravity-mode','proposal','question','message','origin','file','offset','limit','out']
  const {values:v,positionals} = parseArgs({args:argv,allowPositionals:true,options:{
    ...Object.fromEntries(strings.map(k=>[k,{type:'string'}])),
    ...Object.fromEntries(['once','include-thinking','include-history','no-memories','active-only'].map(k=>[k,{type:'boolean'}]))}})
  if (command==='link') return link(positionals[0],v.code,v.name)
  const config=await loadConfig()
  if (command==='pair' || command==='revoke') {
    if (config.mode==='client') throw Error('Server mode required')
    const {Store} = await import('../src/store.mjs')
    const {pairingCode,revoke} = await import('../src/auth.mjs')
    const store = new Store(config.dataDir)
    try {
      if (command==='pair') return pairingCode(store.db)
      if (!positionals[0]) throw Error('Client name required')
      return {revoked:revoke(store.db,positionals[0])}
    } finally {store.db.close()}
  }
  const {call} = toolService(config)
  const tool = (key,args) => call('connecter_'+key,args)
  if (command==='targets' || command==='jobs') return tool(command)
  if (command==='local-sessions') return tool('local_sessions',{...(v.harness?{harness:v.harness}:{}),...(v['active-only']?{activeOnly:true}:{})})
  if (command==='remote-sessions') return tool('remote_sessions',{...(v.harness?{harness:v.harness}:{}),...(v['active-only']?{activeOnly:true}:{})})
  if (command==='remote-read') {
    const args = {harness:v.harness,id:v.session}
    if (v.origin) args.origin = v.origin
    if (v.file) args.file = v.file
    if (v.offset !== undefined) args.offset = Number(v.offset)
    if (v.limit !== undefined) args.limit = Number(v.limit)
    if (v['include-thinking']) args.includeThinking = true
    if (v['include-history']) args.includeHistory = true
    if (v['no-memories']) args.includeMemories = false
    const extracted = await tool('remote_session_read',args)
    if (v.out) {
      await writeFile(v.out, JSON.stringify(extracted,null,2))
      return {out:v.out, session:extracted.session, stats:extracted.stats, complete:extracted.complete,
        files:extracted.files.map(({text,...meta})=>meta)}
    }
    return extracted
  }
  if (command==='report') return tool('get_report',{jobId:v.job})
  if (command==='pack') return tool('pack_preview',{plan:await readFile(v.plan,'utf8'),
    sources:v.sources?JSON.parse(await readFile(v.sources,'utf8')):[],includeThinking:v['include-thinking'],includeHistory:v['include-history']})
  if (command==='dispatch') return tool('dispatch',{targetHarness:v.harness,targetProject:v.project,bundleHash:v.bundle,
    idempotencyKey:v.key,targetSessionId:v.session,targetModel:v.model,reasoningEffort:v.effort,antigravityMode:v['antigravity-mode']})
  if (['approve','revise','cancel','reply'].includes(command)) return tool('respond',{
    jobId:v.job,action:command,proposalId:v.proposal,questionId:v.question,message:v.message})
  if (command==='wait-decision') {
    if (!v.job || !/^[a-f0-9-]{36}$/.test(v.job)) throw Error('Job UUID required')
    const runId = v.run || (await readdir(join(config.dataDir,'jobs',v.job)))
      .find(name=>/^worker-[a-f0-9-]{36}\.json$/.test(name))?.slice(7,-5)
    for (;;) {
      const result = await tool('wait_decision',{jobId:v.job,runId,seconds:55})
      if (v.once || result.decision || result.finished) return result
    }
  }
  if (command==='update') return updateClient(config,remote(await credentials()))
  throw Error(help)
}
try {
  const result = await main()
  console.log(typeof result==='string' ? result : JSON.stringify(result,null,2))
} catch (error) {
  console.error(error.message)
  process.exitCode=1
}
