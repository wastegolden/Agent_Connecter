import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { installLocal, updateClient } from '../src/client/updater.mjs'
import { createUpdate, sha256 } from '../src/server/updater.mjs'
import { validatePlugins } from '../scripts/validate-plugins.mjs'
import { startServer } from '../src/server/http.mjs'
import { pairingCode } from '../src/auth.mjs'
import { remote } from '../src/client/http.mjs'

test('a paired client installs the deployed package through the real LAN update endpoints', async t => {
  const root = await mkdtemp(resolve('.test-update-lan-'))
  const config = { mode: 'server', dataDir: root, installDir: join(root, 'client'), serveUpdates: true,
    projects: {}, localPort: 0, lanPort: 0, lanHost: '127.0.0.1' }
  const server = await startServer(config)
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })
  const serverUrl = 'http://127.0.0.1:' + server.lanServer.address().port
  assert.equal((await fetch(serverUrl + '/api/update/manifest')).status, 401)
  const code = pairingCode(server.store.db)
  const pair = await fetch(serverUrl + '/api/pair', { method: 'POST', body: JSON.stringify({ code, clientName: 'setup' }) })
  const request = remote({ serverUrl, ...await pair.json() })
  const result = await updateClient(config, request)
  assert.equal(result.updated, true)
  assert.equal((await validatePlugins(result.current)).version, result.pluginVersion)
  config.serveUpdates = false
  await assert.rejects(request('/api/update/manifest'), /NOT_FOUND/)
})

test('a verified update switches the entire registered plugin directory, leaving open releases usable', async t => {
  const root = await mkdtemp(resolve('.test-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { updateDir: join(root, 'updates'), installDir: join(root, 'installed') }
  const first = await createUpdate(config)
  const { current } = await installLocal(config, first)
  const original = await realpath(current)
  const source = join(root, 'deployed')
  await cp(original, source, { recursive: true })
  const version = first.manifest.pluginVersion.split('.').slice(0, 2).concat('99').join('.')
  for (const file of ['package.json', ...['claude', 'codex', 'antigravity'].map(host => '.' + host + '-plugin/plugin.json')]) {
    const path = join(source, file)
    const spec = JSON.parse(await readFile(path, 'utf8'))
    spec.version = version
    await writeFile(path, JSON.stringify(spec))
  }
  const second = await createUpdate(config, source)
  const goodBytes = await readFile(second.bundlePath)
  let manifest = second.manifest, bytes = goodBytes, downloads = 0
  const server = createServer((req, res) => {
    if (req.url === '/api/update/manifest') return res.end(JSON.stringify(manifest))
    assert.equal(req.url, '/api/update/bundle')
    downloads++
    res.end(bytes)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(done => server.close(done)))
  const request = path => fetch('http://127.0.0.1:' + server.address().port + path)

  manifest = { ...second.manifest, pluginVersion: '1.0.9' }
  await assert.rejects(updateClient(config, request), /UPDATE_MANIFEST_INVALID/)
  assert.equal(downloads, 0)
  manifest = second.manifest
  bytes = Buffer.from(goodBytes)
  bytes[0] ^= 0xff
  await assert.rejects(updateClient(config, request), /UPDATE_BUNDLE_HASH_MISMATCH/)
  assert.equal(await realpath(current), original)

  const entries = JSON.parse(gunzipSync(goodBytes))
  const sign = () => {
    bytes = gzipSync(JSON.stringify(entries))
    const { manifestSha256, ...fields } = second.manifest
    fields.bundleBytes = bytes.length
    fields.bundleSha256 = sha256(bytes)
    manifest = { ...fields, manifestSha256: sha256(JSON.stringify(fields)) }
  }
  entries['../escaped'] = Buffer.from('invalid').toString('base64')
  sign()
  await assert.rejects(updateClient(config, request), /UPDATE_ENTRY_INVALID/)
  delete entries['../escaped']
  entries['.codex-plugin/plugin.json'] = Buffer.from('{"name":"different"}').toString('base64')
  sign()
  await assert.rejects(updateClient(config, request), /codex plugin name/)
  assert.equal(await realpath(current), original)
  assert.equal((await readdir(join(config.installDir, 'releases'))).length, 1)

  manifest = second.manifest
  bytes = goodBytes
  const updated = await updateClient(config, request)
  assert.deepEqual(updated, { updated: true, pluginVersion: version, current })
  assert.notEqual(await realpath(current), original)
  assert.equal((await validatePlugins(current)).version, version)
  assert.equal((await validatePlugins(original)).version, first.manifest.pluginVersion)
  const before = downloads
  assert.equal((await updateClient(config, request)).updated, false)
  assert.equal(downloads, before)

  // A failed final link switch leaves the existing unmanaged directory and its contents intact.
  const other = { ...config, installDir: join(root, 'unmanaged') }
  const old = join(other.installDir, 'current')
  await mkdir(old, { recursive: true })
  await cp(join(original, 'package.json'), join(old, 'package.json'))
  await assert.rejects(updateClient(other, request))
  assert.deepEqual(await readdir(old), ['package.json'])
  assert.deepEqual(await readdir(join(other.installDir, 'releases')), [])
})
