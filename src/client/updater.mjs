import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { packageRoot, validatePlugins } from '../../scripts/validate-plugins.mjs'
import { sha256 } from '../server/updater.mjs'

const maxBundle = 16 * 1024 * 1024
function verifyManifest(manifest) {
  const { manifestSha256, ...fields } = manifest
  if (sha256(JSON.stringify(fields)) !== manifestSha256 || fields.name !== 'agent-connecter'
      || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(fields.pluginVersion)
      || !/^[a-f0-9]{64}$/.test(fields.bundleSha256)
      || !Number.isSafeInteger(fields.bundleBytes) || fields.bundleBytes < 1 || fields.bundleBytes > maxBundle) {
    throw new Error('UPDATE_MANIFEST_INVALID')
  }
}

async function activate(installDir, manifest, bundle) {
  if (bundle.length !== manifest.bundleBytes || sha256(bundle) !== manifest.bundleSha256) {
    throw new Error('UPDATE_BUNDLE_HASH_MISMATCH')
  }
  const entries = JSON.parse(gunzipSync(bundle, { maxOutputLength: 32 * 1024 * 1024 }))
  const releases = resolve(installDir, 'releases')
  await mkdir(releases, { recursive: true })
  const staged = await mkdtemp(join(releases, manifest.pluginVersion + '-'))
  const current = resolve(installDir, 'current')
  const next = staged + '.link'
  let switched = false
  try {
    for (const [name, data] of Object.entries(entries)) {
      // Each package entry is a relative, portable filename. No links are accepted.
      if (!name.split('/').every(p => /^[\w.-]+$/.test(p) && !p.endsWith('.') && !/^(con|prn|aux|nul|(?:com|lpt)\d)(?:\.|$)/i.test(p))) {
        throw new Error('UPDATE_ENTRY_INVALID')
      }
      const path = join(staged, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx' })
    }
    const pkg = await validatePlugins(staged)
    if (pkg.version !== manifest.pluginVersion) throw new Error('UPDATE_VERSION_MISMATCH')
    for (const file of Object.values(pkg.bin)) {
      if (!Object.hasOwn(entries, file.replace(/^\.\//, ''))) throw new Error('UPDATE_BIN_INVALID')
      await chmod(join(staged, file), 0o755)
    }
    await symlink(staged, next, process.platform === 'win32' ? 'junction' : 'dir')
    const currentStat = await lstat(current).catch(() => null)
    if (process.platform === 'win32' && currentStat) {
      if (!currentStat.isSymbolicLink()) throw new Error('UPDATE_CURRENT_UNMANAGED')
      const shim = fileURLToPath(new URL('./retarget-junction.ps1', import.meta.url))
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shim], {
        shell: false, windowsHide: true, stdio: 'inherit',
        env: { ...process.env, CONNECTER_CURRENT: current, CONNECTER_NEXT: next }
      })
    } else {
      await rename(next, current)
    }
    switched = true
  } finally {
    if (existsSync(next)) await unlink(next)
    if (!switched) await rm(staged, { recursive: true, force: true })
  }
  return { updated: true, pluginVersion: manifest.pluginVersion, current }
}

export async function installLocal(config, { manifest, bundlePath }) {
  verifyManifest(manifest)
  return activate(config.installDir, manifest, await readFile(bundlePath))
}

export async function updateClient(config, request) {
  const manifest = await (await request('/api/update/manifest')).json()
  verifyManifest(manifest)
  const current = resolve(config.installDir, 'current')
  const local = JSON.parse(await readFile(join(existsSync(current) ? current : packageRoot, 'package.json'), 'utf8'))
  if (local.version.split('.')[0] !== manifest.pluginVersion.split('.')[0]) throw new Error('UPDATE_MAJOR_MISMATCH')
  if (existsSync(current) && local.version === manifest.pluginVersion) return { updated: false, pluginVersion: local.version, current }
  const response = await request('/api/update/bundle')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > manifest.bundleBytes) throw new Error('UPDATE_BUNDLE_HASH_MISMATCH')
    chunks.push(chunk)
  }
  return activate(config.installDir, manifest, Buffer.concat(chunks, size))
}
