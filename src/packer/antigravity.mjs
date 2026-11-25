import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { files, hasTable, jsonLines, original, problem, snapshot } from './io.mjs'
import { cleanLines } from './redact.mjs'

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (/^\d+$/.test(text)) {
    const n = BigInt(text)
    const ms = n > 10n ** 15n ? Number(n / 1000000n) : n > 10n ** 12n ? Number(n) : Number(n * 1000n)
    const d = new Date(ms)
    return Number.isNaN(d.valueOf()) ? null : d.toISOString()
  }
  const d = new Date(text)
  return Number.isNaN(d.valueOf()) ? null : d.toISOString()
}

export async function antigravitySessions(home, tempDir) {
  const sessions = []
  for (const [origin, folder] of [['app', 'antigravity'], ['cli', 'antigravity-cli']]) {
    const root = join(home, '.gemini', folder)
    const brain = join(root, 'brain')
    if (!existsSync(brain)) continue
    const catalog = join(root, 'conversation_summaries.db')
    const metadata = new Map()
    if (existsSync(catalog)) await snapshot(catalog, tempDir, db => {
      for (const table of ['conversations_fts', 'conversation_summaries']) {
        if (!hasTable(db, table)) continue
        const names = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name)
        const columns = ['conversation_id', 'title', 'workspace', 'workspace_uris', 'archived', 'last_modified_time'].filter(key => names.includes(key))
        if (!columns.includes('conversation_id')) continue
        const select = columns.map(c => c === 'last_modified_time' ? 'CAST(last_modified_time AS TEXT) AS last_modified_time' : c).join(',')
        for (const row of db.prepare('SELECT DISTINCT ' + select + ' FROM ' + table).iterate()) {
          metadata.set(row.conversation_id, { ...metadata.get(row.conversation_id), ...row })
        }
      }
    })
    for (const entry of readdirSync(brain, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const dir = join(brain, id)
      const logs = join(dir, '.system_generated', 'logs')
      const transcript = join(logs, 'transcript.jsonl')
      if (!existsSync(transcript)) continue
      const row = metadata.get(id)
      const annPath = join(root, 'annotations', id + '.pbtxt')
      const ann = existsSync(annPath) ? readFileSync(annPath, 'utf8') : ''
      const annArchived = /\barchived\s*:\s*(true|false)\b/.exec(ann)?.[1]
      const annTitle = /\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(ann)?.[1]?.replace(/\\(.)/g, '$1')
      const archived = annArchived !== undefined ? annArchived === 'true' : (row?.archived !== undefined ? Boolean(row.archived) : false)
      const updatedAt = parseTimestamp(row?.last_modified_time) ?? statSync(transcript).mtime.toISOString()
      sessions.push({ harness: 'antigravity', origin, id, cwd: row?.workspace ?? row?.workspace_uris, title: row?.title || annTitle || id, archived, updatedAt, dir, logs })
    }
  }
  return sessions
}

export async function* antigravityFiles(session, { prefix }) {
  const raw = readFileSync(join(session.logs, 'transcript.jsonl'))
  const records = [...jsonLines(raw)].filter(r => ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC'].includes(r.type))
  const missing = new Set(records.filter(r => r.truncated_fields && Object.keys(r.truncated_fields).length).map(r => r.step_index))
  const full = new Map()
  const inputs = []
  if (missing.size) {
    const fullPath = join(session.logs, 'transcript_full.jsonl')
    if (!existsSync(fullPath)) throw problem('TRANSCRIPT_INCOMPLETE', 'Missing transcript_full.jsonl in ' + session.id)
    const data = readFileSync(fullPath)
    inputs.push({ name: 'transcript_full.jsonl', raw: data })
    for (const row of jsonLines(data)) {
      if (missing.has(row.step_index)) full.set(row.step_index, row)
    }
    if (full.size !== missing.size) throw problem('TRANSCRIPT_INCOMPLETE', 'Missing full Antigravity step in ' + session.id)
  }
  const turns = records.map(row => {
    const { input_tokens, cache_read_tokens, output_tokens, truncated_fields, ...turn } = full.get(row.step_index) ?? row
    return turn
  })
  yield { name: prefix + '/transcript.jsonl', raw, ...cleanLines(turns), inputs }
  for (const p of files(session.dir).filter(path => path.endsWith('.md'))) {
    yield original(p, prefix + '/brain/' + basename(p))
  }
}
