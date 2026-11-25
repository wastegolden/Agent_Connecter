import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import pkg from '../package.json' with { type: 'json' }

export const pluginVersion = pkg.version
export const protocolVersion = 1
export const harnesses = ['codex', 'claude-code', 'antigravity']
export const configDir = () => process.env.AGENT_CONNECTER_HOME || join(homedir(), '.agent-connecter')

export async function loadConfig() {
  const root = configDir()
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  if (!['client', 'server', 'both'].includes(config.mode)) throw Error('Invalid configuration mode')
  for (const cwd of Object.values(config.projects ?? {}))
    if (!isAbsolute(cwd)) throw Error('Project paths must be absolute')
  return {
    lanHost: '0.0.0.0', lanPort: 3090, localPort: 3091, projects: {},
    dataDir: join(root, 'data'), previewDir: join(root, 'previews'),
    installDir: join(process.env.LOCALAPPDATA || root, 'agent-connecter'),
    ...config
  }
}

export function fail(code, status = 400, message = code) {
  throw Object.assign(new Error(message), { code, status })
}

export function targets(input, available) {
  if (!input.targetHarness) fail('TARGET_HARNESS_REQUIRED')
  if (!harnesses.includes(input.targetHarness) || !available.harnesses.includes(input.targetHarness))
    fail('TARGET_HARNESS_UNAVAILABLE', 409)
  if (!input.targetProject || !available.projects.includes(input.targetProject)) fail('TARGET_PROJECT_UNKNOWN')
}

export function workerFile(config, jobId, runId) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  if (!uuid.test(jobId) || !uuid.test(runId)) fail('WORKER_UNAUTHORIZED', 403)
  return join(config.dataDir, 'jobs', jobId, 'worker-' + runId + '.json')
}
