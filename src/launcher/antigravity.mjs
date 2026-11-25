import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail } from '../config.mjs'
import { cleanEnv } from './env.mjs'
import { resolveExecutable, run } from './wt.mjs'

export function agyArgs(job, session, pointer) {
  const args = []
  if (job.targetModel) args.push('--model=' + job.targetModel)
  if (job.reasoningEffort) args.push('--effort=' + job.reasoningEffort)
  if (session) args.push('--conversation', session)
  return [...args, '--prompt-interactive', pointer]
}

export async function agentApiBinary(configured) {
  const native = resolveExecutable(configured || (process.platform === 'win32' ? 'agentapi.exe' : 'agentapi'))
  if (native && !/\.(?:bat|cmd)$/i.test(native))
    return { file: native, prefix: /^language_server(?:_[\w-]+)?\.exe$/i.test(basename(native)) ? ['agentapi'] : [] }
  // The Windows App installs a two-line batch shim. Invoke its native host directly.
  const shim = native || (!configured && resolveExecutable('agentapi.bat'))
  const host = shim && /^@echo off\r?\n"([^"\r\n]+\.exe)" agentapi %\*\s*$/i.exec(await readFile(shim, 'utf8'))?.[1]
  if (!host || !isAbsolute(host) || !resolveExecutable(host)) fail('TARGET_HARNESS_UNAVAILABLE', 409, 'Cannot locate native agentapi')
  return { file: host, prefix: ['agentapi'] }
}

export async function callAgentApi(binary, { sessionId, pointer, cwd, projectId, targetModel, reasoningEffort }) {
  if (reasoningEffort || (sessionId && targetModel))
    fail('UNSUPPORTED_SESSION_OPTION', 400, 'agentapi cannot set these options on this conversation')
  const env = cleanEnv()
  // Only the App-side child needs the credentials supplied by the sidecar host.
  for (const key of ['ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_CSRF_TOKEN', 'ANTIGRAVITY_LS_VERSION',
    'ANTIGRAVITY_PROJECT_ID', 'ANTIGRAVITY_SIDECAR_UI_TOKEN', 'ANTIGRAVITY_EXECUTABLE_DATA_DIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId
  else if (!sessionId) {
    const id = env.ANTIGRAVITY_PROJECT_ID
    if (!id) fail('TARGET_PROJECT_UNKNOWN', 409, 'Set the sidecar projectId in Antigravity')
    const file = join(homedir(), '.gemini', 'config', 'projects', id + '.json')
    const project = JSON.parse(await readFile(file, 'utf8'))
    const folders = project.projectResources?.resources ?? []
    if (!folders.some(folder => folder.folderUri?.startsWith('file:') && relative(cwd, fileURLToPath(folder.folderUri)) === ''))
      fail('TARGET_PROJECT_UNKNOWN', 409, 'The configured sidecar project does not contain the selected workspace')
  }
  const args = sessionId ? ['send-message', sessionId, pointer] : [
    'new-conversation', ...(targetModel ? ['--model=' + targetModel] : []), '--', pointer]
  return run(binary.file, [...binary.prefix, ...args], cwd, env)
}
