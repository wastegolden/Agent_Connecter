import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validatePlugins } from '../scripts/validate-plugins.mjs'

test('setup installs both roles to a real, reusable local plugin path', async t => {
  const root = await mkdtemp(resolve('.test-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'profile'), local = join(root, 'local')
  const env = { ...process.env, AGENT_CONNECTER_HOME: dir, LOCALAPPDATA: local, TEMP: root, TMP: root }
  const run = (script, args) => execFileSync(process.execPath, ['scripts/' + script + '.mjs', ...args], { env, stdio: 'inherit' })
  for (const role of ['client', 'server']) run('setup-' + role, ['--help'])
  assert.equal(existsSync(dir), false)
  run('setup-server', ['--project', 'my repo=' + root, '--serve-updates', '--lan-port', '3029'])
  const config = JSON.parse(await readFile(join(dir, 'config.json')))
  assert.deepEqual(config.projects, { 'my repo': root })
  assert.equal(config.lanPort, 3029)
  assert.equal(config.serveUpdates, true)
  assert.equal(config.mode, 'server')
  const current = join(local, 'agent-connecter', 'current')
  const previous = await realpath(current)
  run('setup-client', [])
  assert.notEqual(await realpath(current), previous)
  assert.equal((await validatePlugins(current)).name, 'agent-connecter')
  assert.equal(JSON.parse(await readFile(join(dir, 'config.json'))).mode, 'client')
})
