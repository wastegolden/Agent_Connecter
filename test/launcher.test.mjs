import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import childProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLauncher } from '../src/launcher/index.mjs'
import { cleanEnv } from '../src/launcher/env.mjs'
import { agentApiBinary, callAgentApi } from '../src/launcher/antigravity.mjs'

const plan = 'Check src/tasks first.\n</prompt>; draft a plan\n新计划'
const job = { id: 'job-1', runId: 'run-1', targetProject: 'demo', targetHarness: 'codex' }

async function fixture(t) {
  const dir = await mkdtemp(resolve('.launcher-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'PLAN.md'), plan)
  const config = { projects: { demo: dir }, antigravityProjects: { demo: 'project-id' }, executables:
    Object.fromEntries(['wt', 'codex', 'antigravity', 'claude-code'].map(k => [k, process.execPath])) }
  const commands = [], tabs = [], exec = []
  const sidecar = { connected: () => true, send: async cmd => { commands.push(cmd) } }
  const launcher = createLauncher(config, sidecar)
  t.after(() => launcher.close())
  t.mock.method(childProcess, 'spawn', (file, argv, options) => {
    const calls = argv[0] === '-w' ? tabs : exec
    calls.push({ file, argv, options })
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('exit', 0))
    return child
  })
  return { launcher, dir, commands, tabs, exec, sidecar, config }
}

test('prompt streams the full plan inside a fresh fence; Windows Terminal receives only its file pointer', async t => {
  const { launcher, dir, tabs } = await fixture(t)
  await launcher.launch(job, dir)
  const read = () => readFile(join(dir, 'PROMPT.md'), 'utf8')
  const first = await read()
  const [, boundary] = first.match(/^BEGIN (relay-[a-f0-9]{32})$/m)
  assert.ok(first.includes('BEGIN ' + boundary + '\n' + plan + '\nEND ' + boundary))
  assert.match(first, /jobId=job-1, runId=run-1/)
  await launcher.launch(job, dir)
  assert.ok(!(await read()).includes(boundary))
  const { argv, options } = tabs[0]
  assert.equal(options.shell, false)
  assert.equal(options.cwd, dir)
  assert.deepEqual(argv.slice(0, -1), ['-w','0','new-tab','--title','[connecter] job-1','-d',dir,'--',process.execPath,'-C',dir])
  assert.ok(argv.at(-1).includes(join(dir, 'PROMPT.md')))
  assert.ok(argv.every(arg => !arg.includes(';') && !arg.includes(plan) && !arg.includes('run-1')))
})

test('unsafe pointer, terminal options and session IDs are rejected before spawning', async t => {
  const { launcher, dir, tabs, exec, commands } = await fixture(t)
  await assert.rejects(launcher.wake({ ...job, targetHarness: 'antigravity', targetSessionId: 'ag' }, dir + ';bad'),
    { code: 'UNSAFE_LAUNCH_ARGUMENT' })
  await assert.rejects(launcher.wake({ ...job, targetSessionId: 'x\n' }, dir), { code: 'UNSAFE_LAUNCH_ARGUMENT' })
  await assert.rejects(launcher.wake({ ...job, targetHarness: 'claude-code', targetSessionId: '-h' }, dir),
    { code: 'INVALID_SESSION_ID' })
  assert.equal(tabs.length + exec.length + commands.length, 0)
})

test('environment scrub matches full harness patterns case-insensitively', () => {
  const vars = ['CLAUDECODE','CLAUDE_PID','claude_code_entrypoint','CODEX_THREAD_ID','CODEX_TURN_ID',
    'CODEX_CALL_ID','CODEX_APP_TOOLS_X','Antigravity_Project_Id','AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP',
    'AGENT_BRIDGE_CHAIN','DSH_MCP_TOKEN','DSH_BRIDGE_ACCESS']
  assert.deepEqual(cleanEnv({ ...Object.fromEntries(vars.map(k => [k,'inherited'])), Path:'tools', CODEX_HOME:'codex' }),
    { Path:'tools', CODEX_HOME:'codex' })
})

test('Antigravity App uses its sidecar, exact project and session; offline dispatch fails closed', async t => {
  const { launcher, sidecar, dir, tabs, commands } = await fixture(t)
  const app = { ...job, targetHarness: 'antigravity' }
  await launcher.launch(app, dir)
  await launcher.wake({ ...app, harnessSessionId: 'thread-ag', pid: process.pid }, dir)
  assert.equal(commands[0].projectId, 'project-id')
  assert.equal(commands[1].sessionId, 'thread-ag')
  assert.equal(commands[0].cwd, dir)
  assert.equal(commands[0].pointer, commands[1].pointer)
  sidecar.connected = () => false
  assert.equal(launcher.available('antigravity'), false)
  assert.equal(launcher.available('antigravity','cli'), true)
  await assert.rejects(launcher.launch(app, dir), { code: 'TARGET_HARNESS_UNAVAILABLE' })
  assert.equal(tabs.length, 0)
})

test('explicit Antigravity CLI and Claude create or resume a visible tab; live sessions require manual resume', async t => {
  const { launcher, dir, tabs } = await fixture(t)
  const agy = { ...job, targetHarness: 'antigravity', antigravityMode: 'cli', targetModel: 'model', reasoningEffort: 'high' }
  await launcher.launch(agy, dir)
  await launcher.wake({ ...agy, harnessSessionId:'ag-1' }, dir)
  const claude = { ...job, targetHarness: 'claude-code', targetModel: 'opus', reasoningEffort: 'high' }
  await launcher.launch(claude, dir)
  await launcher.wake({ ...claude, harnessSessionId: 'cc-1' }, dir)
  const args = tabs.map(tab => tab.argv.slice(tab.argv.indexOf('--') + 2, -1))
  assert.deepEqual(args, [
    ['--model=model','--effort=high','--prompt-interactive'],
    ['--model=model','--effort=high','--conversation','ag-1','--prompt-interactive'],
    ['--model','opus','--effort','high'],
    ['--model','opus','--effort','high','--resume','cc-1']])
  assert.equal(await launcher.wake({ ...claude, harnessSessionId:'cc-1', pid:process.pid }, dir), 'needs_resume')
  assert.equal(tabs.length, 4)
})

test('Codex queue requires a fresh worker confirmation, falls back to the exact thread after timeout', async t => {
  const { launcher, dir, tabs, exec } = await fixture(t)
  t.mock.timers.enable({ apis:['setTimeout'] })
  const resumed = { ...job, harnessSessionId:'cx-1' }
  let pending = launcher.wake(resumed, dir)
  launcher.registered(job.id)
  await pending
  assert.deepEqual(exec[0].argv, ['queue','--thread','cx-1','--message',exec[0].argv[4],'--resume'])
  assert.ok(exec[0].argv[4].includes('PROMPT.md'))
  assert.equal(exec[0].options.shell, false)
  assert.equal(tabs.length, 0)
  pending = launcher.wake(resumed, dir)
  launcher.registered('some-other-job')
  t.mock.timers.tick(10000)
  await pending
  assert.deepEqual(tabs[0].argv.slice(-5), ['resume','cx-1',exec[0].argv[4],'-C',dir])
  pending = launcher.wake({ ...resumed, pid: process.pid }, dir)
  t.mock.timers.tick(10000)
  assert.equal(await pending, 'needs_resume')
})

test('agentapi executes only the native program with argv and sidecar-scoped project', async t => {
  const { dir, exec } = await fixture(t)
  const shim = join(dir,'agentapi.bat')
  const native = resolve(dir, 'language_server.exe')
  await writeFile(native, '')
  await writeFile(shim, '@echo off\r\n"' + native + '" agentapi %*\r\n')
  const binary = await agentApiBinary(shim)
  assert.deepEqual(binary, { file:native, prefix:['agentapi'] })
  const command = { cwd:dir, pointer:'Read PROMPT.md', projectId:'mapped-project' }
  await callAgentApi(binary, { ...command, targetModel:'pro' })
  await callAgentApi(binary, { ...command, sessionId:'ag-1' })
  assert.deepEqual(exec.map(c => c.argv), [['agentapi','new-conversation','--model=pro','--','Read PROMPT.md'],
    ['agentapi','send-message','ag-1','Read PROMPT.md']])
  assert.equal(exec[0].options.env.ANTIGRAVITY_PROJECT_ID, 'mapped-project')
  assert.equal(exec[0].options.shell, false)
  await writeFile(shim, 'echo malformed shim')
  await assert.rejects(agentApiBinary(shim), { code: 'TARGET_HARNESS_UNAVAILABLE' })
})

test('native Codex resume applies explicit model overrides; a failed wt exit fails the launch', async t => {
  const { launcher, dir, tabs, exec } = await fixture(t)
  await launcher.launch({ ...job, targetSessionId:'s1', targetModel:'m1', reasoningEffort:'high' }, dir)
  assert.equal(exec.length, 0)
  assert.deepEqual(tabs[0].argv.slice(-8, -3), ['resume','--model=m1','-c','model_reasoning_effort="high"','s1'])
  childProcess.spawn.mock.mockImplementation(() => {
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('exit', 1))
    return child
  })
  await assert.rejects(launcher.launch(job, dir), { code:'LAUNCH_FAILED' })
})

test('sidecar subprocess consumes loopback SSE, verifies the default workspace and acknowledges agentapi', {timeout:15000}, async () => {
  const dir = await mkdtemp(resolve('.launcher-sidecar-'))
  const projects = join(dir,'.gemini','config','projects')
  const done = Promise.withResolvers()
  const acknowledgements = []
  let events, child
  const server = http.createServer(async (req, res) => {
    if (req.url === '/local/sidecar/events') {
      events = res
      res.writeHead(200, { 'Content-Type':'text/event-stream' })
      return res.write(': listening\n\n')
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks))
    res.end('{}')
    if (!message.requestId) {
      const cmds = [{ requestId:1, cwd:dir }, { requestId:2, cwd:projects }, { requestId:3, cwd:dir, sessionId:'ag1' }]
      for (const command of cmds) events.write('data: ' + JSON.stringify({ pointer:'Read PROMPT.md', ...command }) + '\n\n')
    } else {
      acknowledgements.push(message)
      if (acknowledgements.length === 3) done.resolve()
    }
  })
  try {
    await mkdir(projects, {recursive:true})
    await writeFile(join(projects,'native-project.json'), JSON.stringify({
      projectResources:{resources:[{ folderUri:pathToFileURL(dir).href }]} }))
    const script = "import {writeFileSync} from 'node:fs'\nwriteFileSync(process.argv[1] + '.args', JSON.stringify(process.argv.slice(2)))"
    for (const verb of ['new-conversation','send-message']) await writeFile(join(dir,verb), script)
    server.listen(0,'127.0.0.1')
    await once(server,'listening')
    await writeFile(join(dir,'config.json'),JSON.stringify({
      mode:'server',localPort:server.address().port,executables:{agentapi:process.execPath} }))
    child = childProcess.spawn(process.execPath,[resolve('bin/antigravity-sidecar.mjs')], {
      cwd:dir, env:{...process.env, HOME:dir, USERPROFILE:dir, AGENT_CONNECTER_HOME:dir, ANTIGRAVITY_PROJECT_ID:'native-project'},
      windowsHide:true, shell:false, stdio:'ignore' })
    child.once('error', done.reject)
    child.once('exit', code => done.reject(Error('Sidecar exit ' + code)))
    const deadline = setTimeout(() => done.reject(Error('Sidecar response timed out')),8000)
    try { await done.promise } finally { clearTimeout(deadline) }
    assert.deepEqual(acknowledgements.sort((a,b) => a.requestId - b.requestId).map(a=>a.ok), [true,false,true])
    assert.deepEqual(JSON.parse(await readFile(join(dir,'new-conversation.args'))), ['--','Read PROMPT.md'])
    assert.deepEqual(JSON.parse(await readFile(join(dir,'send-message.args'))), ['ag1','Read PROMPT.md'])
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir,{force:true,recursive:true})
  }
})

test('first Windows Terminal window staying open does not hang launch', async t => {
  const { dir, config, sidecar } = await fixture(t)
  const launcher = createLauncher({ ...config, launchGraceMs: 25 }, sidecar)
  t.after(() => launcher.close())
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter()
    child.unref = () => {}
    return child // simulates first wt.exe window remaining alive without exiting
  })
  await launcher.launch(job, dir)
})
