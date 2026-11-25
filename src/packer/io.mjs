import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

const forbidden = /^(?:auth\.json|\.credentials\.json|\.sandbox-secrets)$/i

export function files(dir, recursive = false) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (forbidden.test(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isFile()) return [path]
    return recursive && entry.isDirectory() ? files(path, true) : []
  })
}

export function* jsonLines(raw) {
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (line.trim()) yield JSON.parse(line)
  }
}

export function original(path, name) {
  return { name, raw: readFileSync(path) }
}

// Opening even a clean WAL-mode source read-only may create companion files.
export async function snapshot(path, tempDir, query) {
  await mkdir(tempDir, { recursive: true })
  const dir = await mkdtemp(join(tempDir, 'snapshot-'))
  const copy = join(dir, 'snapshot.db')
  try {
    if (existsSync(path + '-wal')) {
      const source = new DatabaseSync(path, { readOnly: true })
      try { await backup(source, copy) } finally { source.close() }
    } else {
      await copyFile(path, copy)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      db.exec('PRAGMA cache_size=-1024')
      return query(db)
    } finally { db.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export function hasTable(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name))
}

export function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}
