import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir, loadConfig } from '../src/config.mjs'
import { installLocal } from '../src/client/updater.mjs'
import { createUpdate } from '../src/server/updater.mjs'

export async function setup(mode, changes) {
  const dir = configDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'config.json')
  const previous = existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {}
  const config = { ...previous, ...changes, mode }
  if (changes.projects) config.projects = { ...previous.projects, ...changes.projects }
  const temporary = join(dir, randomUUID() + '.json')
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
  const resolved = await loadConfig()
  const { current } = await installLocal(resolved, await createUpdate(resolved))
  return { current, config: resolved }
}
