import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { packageRoot, validatePlugins } from '../../scripts/validate-plugins.mjs'

const files = ['package.json', 'README.md', 'DESIGN.md', '.codex-mcp.json', '.antigravity-mcp.json']
const directories = ['bin', 'src', 'scripts', 'skills', 'sidecars', 'test', '.claude-plugin', '.codex-plugin', '.antigravity-plugin']
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// The local account's other files (including a checkout's .git and job data) never enter a release.
export async function createUpdate(config, root = packageRoot) {
  const pkg = await validatePlugins(root)
  const entries = {}
  async function collect(path) {
    for (const item of await readdir(join(root, path), { withFileTypes: true })) {
      const name = path + '/' + item.name
      if (item.isDirectory()) await collect(name)
      else if (item.isFile()) entries[name] = (await readFile(join(root, name))).toString('base64')
    }
  }
  for (const name of files) entries[name] = (await readFile(join(root, name))).toString('base64')
  for (const dir of directories) await collect(dir)
  const bundle = gzipSync(JSON.stringify(entries))
  const fields = { name: pkg.name, pluginVersion: pkg.version, bundleBytes: bundle.length, bundleSha256: sha256(bundle) }
  const manifest = { ...fields, manifestSha256: sha256(JSON.stringify(fields)) }
  const cache = config.updateDir ?? join(config.dataDir, 'updates')
  const bundlePath = join(cache, fields.bundleSha256 + '.gz')
  await mkdir(cache, { recursive: true })
  const temporary = join(cache, randomUUID() + '.tmp')
  try {
    await writeFile(temporary, bundle)
    await rename(temporary, bundlePath)
  } finally {
    await rm(temporary, { force: true })
  }
  return { manifest, bundlePath }
}
