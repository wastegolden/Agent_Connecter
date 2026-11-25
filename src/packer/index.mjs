import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { antigravityFiles, antigravitySessions } from './antigravity.mjs'
import { claudeFiles, claudeSessions } from './claude.mjs'
import { codexFiles, codexSessions } from './codex.mjs'
import { problem } from './io.mjs'
import { redact } from './redact.mjs'

const readers = new Map([['codex', codexSessions], ['claude-code', claudeSessions], ['antigravity', antigravitySessions]])
const extractors = new Map([['codex', codexFiles], ['claude-code', claudeFiles], ['antigravity', antigravityFiles]])
const sha = data => createHash('sha256').update(data).digest('hex')
const compressedLimit = 32 * 1024 ** 2
const plainLimit = 128 * 1024 ** 2
const magic = Buffer.from('ACB1')

async function catalog(harness, home, tempDir) {
  const scan = readers.get(harness)
  if (!scan) throw problem('HARNESS_UNKNOWN', 'Unknown source harness')
  return scan(home, tempDir)
}

export async function listSessions({ harness, home = homedir(), tempDir = tmpdir() } = {}) {
  const sessions = []
  for (const name of harness ? [harness] : readers.keys()) {
    for (const { id, cwd, title, origin } of await catalog(name, home, tempDir)) {
      sessions.push({ harness: name, id, origin, cwd: cwd && redact(cwd).clean, title: redact(title).clean })
    }
  }
  return sessions
}

function meter(limit, digest) {
  let size = 0
  return new Transform({
    transform(chunk, _, callback) {
      size += chunk.length
      if (size > limit) return callback(problem('BUNDLE_TOO_LARGE', 'Context bundle exceeds its byte limit', 413))
      digest?.update(chunk)
      callback(null, chunk)
    }
  })
}

// After the ACB1 prefix, each file is [nameBytes:u32, dataBytes:u32, name, data].
function frame(name, data) {
  const key = Buffer.from(name)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(key.length)
  header.writeUInt32BE(data.length, 4)
  return [header, key, data]
}

function checkName(name) {
  const parts = name.split('/')
  if (name === 'manifest.json' || name === 'PLAN.md') return
  if (parts.shift() !== 'CONTEXT' || !parts.length || parts.some(p =>
    !p || /[<>:"\\|?*\x00-\x1f]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)
  )) throw problem('BUNDLE_INVALID', 'Invalid context file name')
}

export async function packPreview({ sources = [], plan = '', home = homedir(), previewDir = join(home, '.agent-connecter', 'previews'), ...options } = {}) {
  await mkdir(previewDir, { recursive: true })
  const stage = await mkdtemp(join(previewDir, 'pack-'))
  const frozen = join(stage, 'bundle.gz')
  const digest = createHash('sha256')
  const stats = { rawBytes: 0, cleanBytes: 0, redactedCount: 0, files: 0 }
  const manifest = { format: 1, sessions: [], sources: [], stats }
  const catalogs = new Map()
  const memories = new Set()
  async function* entries() {
    yield { name: 'PLAN.md', raw: Buffer.from(plan) }
    for (const [i, source] of sources.entries()) {
      const { harness, id, origin } = source
      if (!catalogs.has(harness)) catalogs.set(harness, await catalog(harness, home, stage))
      const found = catalogs.get(harness).filter(s => s.id === id && (!origin || s.origin === origin))
      if (found.length !== 1) throw problem('SESSION_NOT_FOUND', 'Select an existing, unambiguous local session, including origin for duplicate IDs')
      const session = found[0]
      const prefix = 'CONTEXT/' + (i + 1) + '-' + harness
      manifest.sessions.push({ harness, id, origin: session.origin, path: prefix })
      yield* extractors.get(harness)(session, {
        attachToolResults: true, ...options, home, prefix, tempDir: stage, includeMemories: !memories.has(session.root)
      })
      memories.add(session.root)
    }
  }
  async function* archive() {
    yield magic
    for await (const { name, raw, clean, redactedCount = 0, inputs, derivedFrom } of entries()) {
      checkName(name)
      const encoding = isUtf8(raw) ? 'utf8' : 'latin1'
      const masked = clean === undefined ? redact(raw.toString(encoding)) : { clean, redactedCount: 0 }
      const data = Buffer.from(masked.clean, clean === undefined ? encoding : 'utf8')
      const row = { path: name, rawBytes: raw.length, rawSha256: sha(raw), cleanBytes: data.length, cleanSha256: sha(data), redactedCount: masked.redactedCount + redactedCount }
      if (inputs?.length) {
        const combined = createHash('sha256')
        row.inputs = [{ name: basename(name), raw }, ...inputs].map(({ name, raw }) => {
          combined.update(raw)
          return { name, rawBytes: raw.length, rawSha256: sha(raw) }
        })
        row.rawBytes = row.inputs.reduce((n, input) => n + input.rawBytes, 0)
        row.rawSha256 = combined.digest('hex')
      }
      if (derivedFrom) row.derivedFrom = derivedFrom
      manifest.sources.push(row)
      stats.files++
      if (!derivedFrom) stats.rawBytes += row.rawBytes
      stats.cleanBytes += row.cleanBytes
      stats.redactedCount += row.redactedCount
      yield* frame(name, data)
    }
    yield* frame('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  }
  try {
    await pipeline(Readable.from(archive()), meter(plainLimit), createGzip(), meter(compressedLimit, digest), createWriteStream(frozen))
    const bundleHash = digest.digest('hex')
    const bundlePath = join(previewDir, bundleHash + '.gz')
    if (!existsSync(bundlePath)) await rename(frozen, bundlePath)
    return { bundleHash, bundlePath, stats, manifest }
  } finally { await rm(stage, { recursive: true, force: true }) }
}

export async function unpackBundle(readable, destDir, expectedHash) {
  const parent = dirname(destDir)
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(join(parent, '.unpack-'))
  const payload = join(stage, 'payload')
  const output = join(stage, 'files')
  const digest = createHash('sha256')
  try {
    // Keep the HTTP socket usable for a structured error response on early rejection.
    const input = Readable.from(readable.iterator?.({ destroyOnReturn: false }) ?? readable)
    await pipeline(input, meter(compressedLimit, digest), createGunzip(), meter(plainLimit), createWriteStream(payload))
    if (digest.digest('hex') !== expectedHash) throw problem('BUNDLE_HASH_MISMATCH', 'Frozen bundle SHA-256 differs')
    await mkdir(join(output, 'CONTEXT'), { recursive: true })
    const length = (await stat(payload)).size
    const fd = await open(payload, 'r')
    const seen = new Set()
    try {
      const header = Buffer.alloc(8)
      await fd.read(header, 0, magic.length, 0)
      if (!magic.equals(header.subarray(0, magic.length))) throw problem('BUNDLE_INVALID', 'Unsupported context bundle format')
      let pos = magic.length
      while (pos < length) {
        if (pos + 8 > length) throw problem('BUNDLE_INVALID', 'Truncated file header')
        await fd.read(header, 0, 8, pos)
        const keyLen = header.readUInt32BE()
        const size = header.readUInt32BE(4)
        pos += 8
        if (!keyLen || keyLen > 32767 || pos + keyLen + size > length) throw problem('BUNDLE_INVALID', 'Invalid file frame')
        const key = Buffer.alloc(keyLen)
        await fd.read(key, 0, keyLen, pos)
        pos += keyLen
        const name = key.toString('utf8')
        checkName(name)
        if (seen.has(name.toLowerCase())) throw problem('BUNDLE_INVALID', 'Duplicate context file')
        seen.add(name.toLowerCase())
        const dest = join(output, name)
        await mkdir(dirname(dest), { recursive: true })
        if (size) await pipeline(createReadStream(payload, { start: pos, end: pos + size - 1 }), createWriteStream(dest, { flags: 'wx' }))
        else await writeFile(dest, '', { flag: 'wx' })
        pos += size
      }
    } finally { await fd.close() }
    if (!seen.has('plan.md') || !seen.has('manifest.json')) throw problem('BUNDLE_INVALID', 'Plan and manifest are required')
    await rename(output, destDir)
    return { bundleHash: expectedHash, manifestPath: join(destDir, 'manifest.json') }
  } catch (err) {
    if (err.code?.startsWith('Z_')) throw problem('BUNDLE_INVALID', 'Corrupt context bundle')
    throw err
  } finally { await rm(stage, { recursive: true, force: true }) }
}
