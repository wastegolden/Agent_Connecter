import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { fail } from './config.mjs'

export const secret = () => randomBytes(32).toString('hex')
export const digest = value => createHash('sha256').update(value).digest('hex')
export const matches = (value, hash) => typeof value === 'string' && !!hash &&
  timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'))

export function pairingCode(db) {
  const code = String(randomInt(1000000)).padStart(6, '0')
  db.prepare('INSERT OR REPLACE INTO pairing VALUES (1, ?, ?, 0)').run(digest(code), Date.now() + 300000)
  return code
}

export function pair(db, {code, clientName}) {
  if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 128) fail('CLIENT_NAME_REQUIRED')
  const row = db.prepare('SELECT * FROM pairing WHERE id=1').get()
  if (!row || row.expires <= Date.now() || row.attempts >= 5) return null
  if (!matches(code, row.hash)) {
    db.prepare('UPDATE pairing SET attempts=attempts+1 WHERE id=1').run()
    return null
  }
  const token = secret()
  const clientId = randomUUID()
  db.prepare('INSERT INTO clients VALUES (?,?,?)').run(clientId, clientName, digest(token))
  db.exec('DELETE FROM pairing')
  return { clientId, token, serverMachineId: machineId(db) }
}

export const machineId = db => db.prepare('SELECT machine FROM identity WHERE id=1').get().machine
export function clientAuth(db, authorization) {
  const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
  const row = token && db.prepare('SELECT * FROM clients WHERE hash=?').get(digest(token))
  if (!row) fail('UNAUTHORIZED', 401)
  return row.id
}
export const revoke = (db, name) => db.prepare('DELETE FROM clients WHERE name=?').run(name).changes
