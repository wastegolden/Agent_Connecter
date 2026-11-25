import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { files, hasTable, jsonLines, original, snapshot } from './io.mjs'
import { cleanLines, redactJson } from './redact.mjs'

export async function codexSessions(home, tempDir) {
  const root = join(home, '.codex')
  const catalog = join(root, 'sqlite', 'codex.db')
  let rows
  if (existsSync(catalog)) {
    rows = await snapshot(catalog, tempDir, db => {
      if (hasTable(db, 'local_thread_catalog') && hasTable(db, 'local_thread_catalog_hosts')) {
        return db.prepare("SELECT c.* FROM local_thread_catalog c JOIN local_thread_catalog_hosts h USING(host_id) WHERE h.host_kind='local'").all()
      }
    })
  }
  const index = join(root, 'session_index.jsonl')
  rows ??= existsSync(index) ? [...jsonLines(readFileSync(index))].filter(r => !r.host_kind || r.host_kind === 'local') : []
  const paths = ['sessions', 'archived_sessions'].flatMap(dir => files(join(root, dir), true))
    .filter(path => /^rollout-.*\.jsonl$/.test(basename(path)))
  const rollouts = new Map(paths.map(path => [basename(path, '.jsonl').replace(/^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, ''), path]))
  return rows.flatMap(r => {
    const id = r.thread_id ?? r.id
    const path = rollouts.get(id) ?? paths.find(p => p.endsWith('-' + id + '.jsonl'))
    return path ? [{ harness: 'codex', id, cwd: r.cwd, title: r.display_title ?? r.thread_name ?? id, root, path }] : []
  })
}

export async function* codexFiles(session, { prefix, tempDir, includeMemories }) {
  const { root, path, id } = session
  const raw = readFileSync(path)
  const lines = []
  for (const entry of jsonLines(raw)) {
    const p = entry.payload
    if (!p || typeof p !== 'object') continue
    if (entry.type === 'session_meta') {
      const { base_instructions, developer_instructions, dynamic_tools, ...meta } = p
      lines.push({ type: 'session_meta', ...meta })
    }
    if (entry.type !== 'response_item') continue
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const content = typeof p.content === 'string' ? [p.content]
        : Array.isArray(p.content) ? p.content.flatMap(part => {
          if (part.type === 'input_image') return ['[image omitted]']
          return ['input_text', 'output_text'].includes(part.type) ? [part.text] : []
        }) : []
      lines.push({ role: p.role, content })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      lines.push({ tool: p.name, callId: p.call_id })
    }
  }
  yield { name: prefix + '/transcript.jsonl', raw, ...cleanLines(lines) }

  let latest
  for (const dbPath of [join(root, 'sqlite', 'memories_1.sqlite'), join(root, 'memories_1.sqlite')]) {
    if (!existsSync(dbPath)) continue
    const row = await snapshot(dbPath, tempDir, db => hasTable(db, 'stage1_outputs')
      ? db.prepare('SELECT * FROM stage1_outputs WHERE thread_id=? ORDER BY source_updated_at DESC LIMIT 1').get(id) : null)
    if (row && (!latest || row.source_updated_at > latest.source_updated_at)) latest = row
  }
  if (latest) yield { name: prefix + '/stage1-memory.json', raw: Buffer.from(JSON.stringify(latest, null, 2)), ...redactJson(latest, 2) }
  if (includeMemories) {
    const dir = join(root, 'memories')
    for (const p of files(dir, true)) {
      yield original(p, 'CONTEXT/codex-memories/' + relative(dir, p).split(sep).join('/'))
    }
  }
}
