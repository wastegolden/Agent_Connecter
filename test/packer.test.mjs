import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createGzip, gzipSync } from 'node:zlib'
import { listSessions, packPreview, unpackBundle } from '../src/packer/index.mjs'
import { redact } from '../src/packer/redact.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join('\r\n') + '\r\n'

async function fixture(t) {
  const home = await mkdtemp(join(repo, '.packer-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  async function put(path, body) {
    const dest = join(home, path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, body)
    return dest
  }
  function preview(sources, options = {}) {
    return packPreview({ sources, home, previewDir: join(home, 'preview'), plan: 'review', ...options })
  }
  async function unpack(bundle, folder = 'job') {
    const dest = join(home, folder)
    await unpackBundle(createReadStream(bundle.bundlePath), dest, bundle.bundleHash)
    return name => readFile(join(dest, name), 'utf8')
  }
  return { home, put, preview, unpack }
}

test('Codex joins local catalog hosts, snapshots active WAL, and keeps newest memory from both stores', async t => {
  let db
  t.after(() => db?.close())
  const { home, put, preview, unpack } = await fixture(t)
  const dbDir = join(home, '.codex/sqlite')
  await mkdir(dbDir, { recursive: true })
  db = new DatabaseSync(join(dbDir, 'codex.db'))
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE local_thread_catalog_hosts(host_id,host_kind);
    CREATE TABLE local_thread_catalog(host_id,thread_id,display_title,cwd);
    INSERT INTO local_thread_catalog_hosts VALUES(1,'local'),(2,'remote-control'),(3,'chatgpt');
    INSERT INTO local_thread_catalog VALUES(1,'local','Local','/repo'),(2,'remote','Remote','/repo'),(3,'chat','Chat','/repo');`)
  const raw = jsonl(
    { type: 'session_meta', payload: { id: 'local', base_instructions: 'hidden setup' } },
    ...['user', 'assistant', 'developer', 'system'].map(role => ({ type: 'response_item', payload: { role, type: 'message', content: [
      { type: role === 'assistant' ? 'output_text' : 'input_text', text: role + ' says hello' }, { type: 'input_image', image_url: 'data:image/secret' }
    ] } })),
    { type: 'response_item', payload: { type: 'function_call', name: 'locate', call_id: 'call1', arguments: 'tool internals' } },
    ...['compaction', 'thread_settings_applied', 'world_state', 'token_count'].map(type => ({ type, payload: {} }))
  )
  await put('.codex/archived_sessions/rollout-date-local.jsonl', raw)
  await put('.codex/sessions/2026/11/25/rollout-date-remote.jsonl', raw)
  await put('.codex/sessions/2026/11/25/rollout-date-chat.jsonl', raw)
  await put('.codex/memories/nested/file.md', 'entire\r\nmarkdown\r\n')
  await put('.codex/memories/auth.json', 'do not read')
  await put('.codex/memories/.credentials.json', 'do not read')
  await put('.codex/memories/.sandbox-secrets/token', 'do not read')
  for (const [base, time] of [['sqlite/', 22], ['', 10]]) {
    const path = join(home, '.codex', base, 'memories_1.sqlite')
    const mem = new DatabaseSync(path)
    mem.exec('PRAGMA journal_mode=WAL; CREATE TABLE stage1_outputs(thread_id,source_updated_at,raw_memory,rollout_summary)')
    mem.prepare('INSERT INTO stage1_outputs VALUES(?,?,?,?)').run('local', time, 'memory ' + time, 'all details')
    mem.close()
    assert.ok(!existsSync(path + '-wal'))
  }
  const sessions = await listSessions({ home, harness: 'codex', tempDir: home })
  assert.deepEqual(sessions.map(s => s.id), ['local'])
  const bundle = await preview(sessions)
  const read = await unpack(bundle)
  const transcript = await read('CONTEXT/1-codex/transcript.jsonl')
  for (const expected of ['session_meta', 'user says hello', 'assistant says hello', '[image omitted]', 'locate']) assert.ok(transcript.includes(expected))
  assert.doesNotMatch(transcript, /hidden setup|system says|developer says|world_state|compaction|token_count|thread_settings|tool internals|data:image/)
  const summary = JSON.parse(await read('CONTEXT/1-codex/stage1-memory.json'))
  assert.equal(summary.raw_memory, 'memory 22')
  assert.equal(summary.rollout_summary, 'all details')
  assert.equal(await read('CONTEXT/codex-memories/nested/file.md'), 'entire\r\nmarkdown\r\n')
  assert.doesNotMatch(JSON.stringify(bundle.manifest), /auth\.json|\.credentials|sandbox-secrets/)
  assert.equal(bundle.manifest.sources.find(s => s.path.endsWith('transcript.jsonl')).rawSha256, hash(raw))
  for (const rel of ['.codex/sqlite/memories_1.sqlite', '.codex/memories_1.sqlite']) {
    for (const suffix of ['-wal', '-shm']) assert.equal(existsSync(join(home, rel + suffix)), false)
  }
})

test('Codex session_index fallback requires a rollout', async t => {
  const { home, put } = await fixture(t)
  await put('.codex/session_index.jsonl', jsonl({ id: 'found', thread_name: 'local index' }, { id: 'missing' }))
  await put('.codex/sessions/2026/11/25/rollout-2026-11-25T10-45-30-found.jsonl', '')
  const rows = await listSessions({ home, tempDir: home })
  assert.deepEqual(rows.map(s => [s.id, s.title]), [['found', 'local index']])
})

test('quoted assignments, multiline private keys and nested result fields are masked before JSON serialization', async t => {
  const { put, preview, unpack } = await fixture(t)
  const transcript = jsonl(
    { type: 'user', cwd: '/actual', sessionId: 'secrets', message: { content: 'Run with API_KEY="test-value-123".\n-----BEGIN PRIVATE KEY-----\nsecret-file-body\n-----END PRIVATE KEY-----' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'API_KEY="test-value-456"', apiKey: 'test-value-789' }] }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'API_KEY="test-value-long"' + 'n'.repeat(5000) }] }] } }
  )
  await put('.claude/projects/proj/secrets.jsonl', transcript)
  const bundle = await preview([{ harness: 'claude-code', id: 'secrets' }])
  const read = await unpack(bundle)
  const original = await read('CONTEXT/1-claude-code/transcript.jsonl')
  assert.doesNotMatch(original, /test-value|secret-file-body|BEGIN PRIVATE/)
  assert.equal((original.match(/\[REDACTED\]/g) ?? []).length, 5)
  const attachment = bundle.manifest.sources.find(s => s.derivedFrom)
  assert.doesNotMatch(await read(attachment.path), /test-value/)
  assert.equal(bundle.stats.redactedCount, 5)
  assert.equal(bundle.stats.rawBytes, Buffer.byteLength(transcript) + Buffer.byteLength('review'))
  for (const { path, cleanSha256, cleanBytes } of bundle.manifest.sources) {
    const data = await read(path)
    assert.equal(hash(data), cleanSha256)
    assert.equal(Buffer.byteLength(data), cleanBytes)
  }
})

test('Claude preserves turns, graph metadata, tool error traces and memory originals; history and thinking are opt-in', async t => {
  const { home, put, preview, unpack } = await fixture(t)
  const root = '.claude/projects/encoded-path/'
  const secret = 'sk-test-long-enough'
  const toolText = 'start\n' + 'a'.repeat(5000) + '\nError: middle stack\n    at function\n' + 'z'.repeat(5000) + '\n' + secret + ' tail'
  await put(root + 'thread.jsonl', jsonl(
    { type: 'progress', cwd: '/actual path', sessionId: 'thread', detail: 'noisy row' },
    { type: 'user', uuid: 'user1', parentUuid: null, isSidechain: true, message: { content: '请保留我的原话\nHere.' } },
    { type: 'assistant', uuid: 'assistant1', parentUuid: 'user1', message: { content: [{ type: 'thinking', thinking: 'private thoughts' }, { type: 'text', text: 'all\nanswer' }, { type: 'tool_use', id: 't', name: 'check', input: 'noisy arguments' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: 't', content: toolText }] } }
  ))
  const original = 'Memory, verbatim\r\nsecond line\r\n'
  await put(root + 'memory/note.md', original)
  await put('.claude/history.jsonl', jsonl({ sessionId: 'thread', display: 'selected input' }, { sessionId: 'other', display: 'other input' }))
  const sessions = await listSessions({ home, tempDir: home })
  assert.equal(sessions[0].cwd, '/actual path')
  const bundle = await preview(sessions)
  const read = await unpack(bundle)
  const rows = (await read('CONTEXT/1-claude-code/transcript.jsonl')).trim().split('\n').map(x => JSON.parse(x))
  assert.equal(rows[0].isSidechain, true)
  assert.equal(rows[0].content[0].text, '请保留我的原话\nHere.')
  assert.equal(rows[1].parentUuid, 'user1')
  assert.equal(rows[1].content[0].text, 'all\nanswer')
  assert.equal(rows[1].content[1].name, 'check')
  const result = rows[2].content[0]
  assert.ok(result.content.length < 4096)
  assert.match(result.content, /middle stack/)
  assert.doesNotMatch(JSON.stringify(rows), /noisy|private thoughts|sk-test/)
  assert.equal(await read(result.attachment), toolText.replace(secret, '[REDACTED]'))
  assert.equal(await read('CONTEXT/1-claude-code/memory/note.md'), original)
  assert.equal(bundle.stats.redactedCount, 1)
  assert.equal(bundle.manifest.sources.some(s => s.path.endsWith('/history.jsonl')), false)
  const withHistory = await preview(sessions, { includeHistory: true, includeThinking: true, attachToolResults: false })
  const otherRead = await unpack(withHistory, 'job2')
  assert.match(await otherRead('CONTEXT/1-claude-code/transcript.jsonl'), /private thoughts/)
  const history = await otherRead('CONTEXT/1-claude-code/history.jsonl')
  assert.match(history, /selected input/)
  assert.doesNotMatch(history, /other input/)
  assert.ok(!withHistory.manifest.sources.some(s => s.path.includes('/attachments/')))
})

test('Antigravity scans App and CLI catalogs and resolves truncated steps by step_index', async t => {
  const { home, put, preview, unpack } = await fixture(t)
  for (const [origin, dir] of [['app', 'antigravity'], ['cli', 'antigravity-cli']]) {
    const base = '.gemini/' + dir
    const src = base + '/brain/session/.system_generated/logs/'
    await put(src + 'transcript.jsonl', jsonl(
      { type: 'USER_INPUT', step_index: 9, content: 'trunc', truncated_fields: ['content'] },
      { type: 'SYSTEM_MESSAGE', step_index: 10, content: 'hidden' },
      { type: 'GENERIC', step_index: 12, content: 'trunc', truncated_fields: ['content'] },
      { type: 'PLANNER_RESPONSE', step_index: 27, content: 'trunc', truncated_fields: ['content'] }
    ))
    await put(src + 'transcript_full.jsonl', jsonl(...[27, 9, 12].map((step_index, i) => ({
      type: ['PLANNER_RESPONSE', 'USER_INPUT', 'GENERIC'][i], step_index, content: origin + ' full ' + step_index
    }))))
    await put(base + '/brain/session/plan.md', origin + ' full artifact')
    const db = new DatabaseSync(join(home, base, 'conversation_summaries.db'))
    db.exec(`CREATE TABLE conversation_summaries(conversation_id,title);
      CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id,title,workspace);
      INSERT INTO conversations_fts VALUES ('session','search title','actual workspace')`)
    db.prepare('INSERT INTO conversation_summaries VALUES (?,?)').run('session', origin)
    db.close()
  }
  const sessions = await listSessions({ home, tempDir: home })
  assert.deepEqual(sessions.map(s => [s.origin, s.title, s.cwd]), [['app', 'app', 'actual workspace'], ['cli', 'cli', 'actual workspace']])
  await assert.rejects(preview([{ harness: 'antigravity', id: 'session' }]), { code: 'SESSION_NOT_FOUND' })
  const bundle = await preview(sessions)
  const read = await unpack(bundle)
  for (const [i, { origin }] of sessions.entries()) {
    const prefix = 'CONTEXT/' + (i + 1) + '-antigravity'
    const rows = (await read(prefix + '/transcript.jsonl')).trim().split('\n').map(s => JSON.parse(s))
    assert.deepEqual(rows.map(r => r.content), [9, 12, 27].map(n => origin + ' full ' + n))
    assert.equal(await read(prefix + '/brain/plan.md'), origin + ' full artifact')
    const source = bundle.manifest.sources.find(s => s.path === prefix + '/transcript.jsonl')
    assert.deepEqual(source.inputs.map(x => x.name), ['transcript.jsonl', 'transcript_full.jsonl'])
    assert.equal(source.rawBytes, source.inputs.reduce((n, input) => n + input.rawBytes, 0))
  }
})

test('redaction counts each replacement, and frozen previews pin exact bytes', async t => {
  const { home, preview, unpack } = await fixture(t)
  const plan = 'sk-oneSecretExample Bearer abc123.foo api_key=oneExampleToken\n-----BEGIN RSA PRIVATE KEY-----\naaa\n-----END RSA PRIVATE KEY-----'
  const masked = redact(plan)
  assert.equal(masked.redactedCount, 4)
  const a = await preview([], { plan })
  const b = await preview([], { plan: 'changed' })
  assert.notEqual(a.bundleHash, b.bundleHash)
  assert.equal(hash(await readFile(a.bundlePath)), a.bundleHash)
  const read = await unpack(a)
  assert.equal(await read('PLAN.md'), masked.clean)
  const m = JSON.parse(await read('manifest.json'))
  assert.equal(m.stats.redactedCount, 4)
  assert.equal(m.sources[0].rawBytes, Buffer.byteLength(plan))
  assert.equal(m.sources[0].cleanSha256, hash(masked.clean))
  const dest = join(home, 'bad')
  await assert.rejects(unpackBundle(createReadStream(a.bundlePath), dest, b.bundleHash), { code: 'BUNDLE_HASH_MISMATCH' })
  assert.ok(!existsSync(dest))
})

test('unpack stops streaming at the 128 MiB expansion limit and removes partial files', async t => {
  const { home } = await fixture(t)
  const block = Buffer.alloc(2 ** 20)
  const bomb = Readable.from((function* () { for (let n = 0; n < 129; n++) yield block })()).pipe(createGzip({ level: 1 }))
  await assert.rejects(unpackBundle(bomb, join(home, 'job'), 'unused'), { code: 'BUNDLE_TOO_LARGE', status: 413 })
  assert.deepEqual(await readdir(home), [])
})

test('unpack rejects compressed overflow and invalid or escaping file frames', async t => {
  const { home } = await fixture(t)
  const gzip = gzipSync('safe')
  const bomb = Readable.from([gzip, Buffer.alloc(32 * 2 ** 20)])
  await assert.rejects(unpackBundle(bomb, join(home, 'job'), ''), { code: 'BUNDLE_TOO_LARGE' })
  for (const key of ['../bad', 'CONTEXT/../bad', 'CONTEXT/file:stream', 'CONTEXT/CON.txt', 'PROMPT.md']) {
    const name = Buffer.from(key)
    const frame = Buffer.alloc(8)
    frame.writeUInt32BE(name.length)
    const bytes = gzipSync(Buffer.concat([Buffer.from('ACB1'), frame, name]))
    await assert.rejects(unpackBundle(Readable.from([bytes]), join(home, 'job'), hash(bytes)), { code: 'BUNDLE_INVALID' })
  }
  assert.deepEqual(await readdir(home), [])
})
