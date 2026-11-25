import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { files, jsonLines, original } from './io.mjs'
import { cleanLines, redact, redactJson } from './redact.mjs'

export async function claudeSessions(home) {
  const projects = join(home, '.claude', 'projects')
  const byId = new Map()
  if (!existsSync(projects)) return []
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const root = join(projects, entry.name)
    for (const path of files(root).filter(p => p.endsWith('.jsonl'))) {
      const stream = createReadStream(path)
      try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          if (!line.trim()) continue
          const { cwd, sessionId, slug } = JSON.parse(line)
          if (!cwd) continue
          const id = sessionId ?? basename(path, '.jsonl')
          const exact = basename(path, '.jsonl') === id
          if (!byId.has(id) || exact) byId.set(id, { harness: 'claude-code', id, cwd, title: slug ?? id, path, root })
          break
        }
      } finally { stream.destroy() }
    }
  }
  return [...byId.values()]
}

export async function* claudeFiles(session, { prefix, home, attachToolResults, includeThinking, includeHistory, includeMemories }) {
  const raw = readFileSync(session.path)
  const lines = []
  let attachments = 0
  let redactedCount = 0
  for (const row of jsonLines(raw)) {
    if (!['user', 'assistant'].includes(row.type) || !row.message) continue
    const parts = row.message.content
    const content = []
    for (const block of typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts) {
      if (block.type === 'text') content.push(block)
      if (block.type === 'thinking' && includeThinking) content.push({ type: 'thinking', thinking: block.thinking })
      if (block.type === 'image') content.push({ type: 'text', text: '[image omitted]' })
      if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name })
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
        const result = { type: block.type, tool_use_id: block.tool_use_id, is_error: block.is_error, content: block.content }
        if (Buffer.byteLength(text) > 4096) {
          const masked = typeof block.content === 'string' ? redact(text) : redactJson(block.content)
          redactedCount += masked.redactedCount
          const edge = Math.min(1536, Math.floor(masked.clean.length / 3))
          const middle = masked.clean.slice(edge, masked.clean.length - edge)
          const errors = middle.split(/\r?\n/).filter(line => /\berror\b|exception|traceback|^\s+at\s/i.test(line))
          result.content = [masked.clean.slice(0, edge), '[…]', ...errors, masked.clean.slice(masked.clean.length - edge)].join('\n')
          if (attachToolResults) {
            result.attachment = 'CONTEXT/attachments/' + basename(prefix) + '-' + (++attachments) + '.txt'
            yield { name: result.attachment, raw: Buffer.from(text), clean: masked.clean, derivedFrom: prefix + '/transcript.jsonl' }
          }
        }
        content.push(result)
      }
    }
    if (content.length) lines.push({ role: row.type, uuid: row.uuid, parentUuid: row.parentUuid, isSidechain: row.isSidechain, content })
  }
  const masked = cleanLines(lines)
  yield { name: prefix + '/transcript.jsonl', raw, clean: masked.clean, redactedCount: masked.redactedCount + redactedCount }
  if (includeMemories) {
    for (const path of files(join(session.root, 'memory')).filter(p => p.endsWith('.md'))) {
      yield original(path, prefix + '/memory/' + basename(path))
    }
  }
  const history = join(home, '.claude', 'history.jsonl')
  if (includeHistory && existsSync(history)) {
    const raw = readFileSync(history)
    const rows = [...jsonLines(raw)].filter(r => r.sessionId === session.id)
    if (rows.length) yield { name: prefix + '/history.jsonl', raw, ...cleanLines(rows) }
  }
}
