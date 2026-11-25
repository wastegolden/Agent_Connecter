import assert from 'node:assert/strict'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = fileURLToPath(new URL('../', import.meta.url))

export async function validatePlugins(root = packageRoot) {
  const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
  const pkg = await json('package.json')
  assert.equal(pkg.name, 'agent-connecter')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.engines.node, '>=24')
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/)
  for (const host of ['claude', 'codex', 'antigravity']) {
    const plugin = await json(`.${host}-plugin/plugin.json`)
    assert.equal(plugin.name, pkg.name, `${host} plugin name`)
    assert.equal(plugin.version, pkg.version, `${host} plugin version`)
    const inline = host === 'claude'
    if (host === 'codex') {
      assert.equal(plugin.mcpServers, './.codex-mcp.json')
      assert.equal(plugin.skills, './skills/')
    }
    const servers = inline ? plugin.mcpServers : (await json(`.${host}-mcp.json`)).mcpServers
    const server = servers[pkg.name]
    assert.equal(server.command, 'node', `${host} MCP command`)
    const prefix = inline ? '${CLAUDE_PLUGIN_ROOT}' : '.'
    assert.deepEqual(server.args, [`${prefix}/bin/connecter-mcp.mjs`], `${host} MCP entry point`)
  }
  const sidecarFile = 'sidecars/antigravity-bridge/sidecar.json'
  const sidecar = await json(sidecarFile)
  assert.equal(sidecar.command, 'node')
  assert.deepEqual(sidecar.args, ['../../bin/antigravity-sidecar.mjs'])
  const skill = await readFile(join(root, 'skills/agent-connecter/SKILL.md'), 'utf8')
  assert.match(skill, /^---\r?\n[\s\S]*?^name:\s*agent-connecter\s*$/m)
  for (const file of ['bin/connecter-mcp.mjs', join(dirname(sidecarFile), sidecar.args[0]), ...Object.values(pkg.bin)]) {
    await access(join(root, file))
  }
  return pkg
}

if (import.meta.main ?? (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const pkg = await validatePlugins()
  console.log(`${pkg.name} ${pkg.version}: Claude Code, Codex and Antigravity plugins validated.`)
}
