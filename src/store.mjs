import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './config.mjs'

const day = 86400000
const terminal = ['completed', 'cancelled', 'failed']

export class Store extends EventEmitter {
  constructor(dataDir) {
    super()
    this.setMaxListeners(0)
    mkdirSync(dataDir, {recursive: true})
    const db = this.db = new DatabaseSync(join(dataDir, 'relay.sqlite'))
    db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA cache_size=-1024;
      CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY, machine TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing(id INTEGER PRIMARY KEY, hash TEXT, expires INTEGER, attempts INTEGER);
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, name TEXT, hash TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, doc TEXT NOT NULL, workerHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dedupe(client TEXT, key TEXT, signature TEXT, job TEXT, at INTEGER, PRIMARY KEY(client,key));
      CREATE TABLE IF NOT EXISTS reports(seq INTEGER PRIMARY KEY, job TEXT, doc TEXT);
      CREATE TABLE IF NOT EXISTS decisions(seq INTEGER PRIMARY KEY, job TEXT, doc TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, doc TEXT);
    `)
    db.prepare('INSERT OR IGNORE INTO identity VALUES (1,?)').run(randomUUID())
  }

  get(id) {
    const row = this.db.prepare('SELECT doc FROM jobs WHERE id=?').get(id)
    if (!row) fail('JOB_UNKNOWN', 404)
    return JSON.parse(row.doc)
  }

  jobs() { return this.db.prepare('SELECT doc FROM jobs ORDER BY rowid DESC').all().map(r => JSON.parse(r.doc)) }

  existing(client, key, signature) {
    const hit = this.db.prepare('SELECT * FROM dedupe WHERE client=? AND key=? AND at>?').get(client, key, Date.now()-day)
    if (hit && hit.signature !== signature) fail('IDEMPOTENCY_CONFLICT', 409)
    return hit && this.get(hit.job)
  }

  sessionFree(session, id) {
    if (!session) return
    const busy = this.db.prepare(`SELECT 1 FROM jobs WHERE id<>? AND
      json_extract(doc,'$.status') NOT IN ('completed','failed','cancelled') AND
      (?=json_extract(doc,'$.targetSessionId') OR ?=json_extract(doc,'$.harnessSessionId')) LIMIT 1`).get(id, session, session)
    if (busy) fail('SESSION_BUSY', 409)
  }

  create(job, workerHash, client, key, signature) {
    this.sessionFree(job.targetSessionId, job.id)
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, JSON.stringify(job), workerHash)
    this.db.prepare('DELETE FROM dedupe WHERE at<=?').run(Date.now()-day)
    this.db.prepare('INSERT INTO dedupe VALUES (?,?,?,?,?)').run(client, key, signature, job.id, Date.now())
    this.save(job)
  }

  save(job) {
    this.db.prepare('UPDATE jobs SET doc=? WHERE id=?').run(JSON.stringify(job), job.id)
    const event = {jobId: job.id, status: job.status, at: Date.now()}
    if (job.proposalId) event.proposalId = job.proposalId
    if (job.questionId) event.questionId = job.questionId
    const id = Number(this.db.prepare('INSERT INTO events(at,doc) VALUES (?,?)').run(event.at, JSON.stringify(event)).lastInsertRowid)
    this.db.prepare('DELETE FROM events WHERE id<=? OR at<=?').run(id-500, event.at-day)
  }

  // Publish only committed transitions. All state mutations here are synchronous.
  change(operation) {
    this.db.exec('BEGIN IMMEDIATE')
    let result
    try {
      result = operation()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.emit('changed')
    return result
  }

  register(id, {harnessSessionId,pid}) {
    if (typeof harnessSessionId !== 'string' || !harnessSessionId || harnessSessionId.startsWith('-') ||
        /[;\x00-\x1f\x7f]/.test(harnessSessionId) || !Number.isSafeInteger(pid) || pid < 1) fail('SESSION_ID_AND_PID_REQUIRED')
    const job = this.get(id)
    if (terminal.includes(job.status)) fail('JOB_FINISHED', 409)
    if ((job.harnessSessionId || job.targetSessionId) && (job.harnessSessionId || job.targetSessionId) !== harnessSessionId)
      fail('SESSION_MISMATCH', 409)
    this.sessionFree(harnessSessionId, id)
    Object.assign(job, {harnessSessionId, pid, heartbeat: Date.now()})
    if (job.status === 'launching') job.status = 'planning'
    this.save(job)
    return job
  }

  report(id, input) {
    const job = this.get(id)
    const {kind} = input
    if (!job.harnessSessionId || terminal.includes(job.status)) fail('REPORT_OUT_OF_PHASE', 409)
    const report = { ...input, at: Date.now() }
    if (kind === 'failed') {
      job.status = 'failed'
      delete job.pendingSeq
      delete job.proposalId
      delete job.questionId
    }
    else if (job.pendingSeq) fail('REPORT_OUT_OF_PHASE', 409)
    else if (kind === 'plan_proposal' && job.status === 'planning') {
      job.status = 'awaiting_approval'
      report.proposalId = job.proposalId = randomUUID()
      report.version = job.version = (job.version || 0) + 1
    } else if (kind === 'needs_input' && ['planning','executing'].includes(job.status)) {
      job.previousPhase = job.status
      job.status = 'needs_input'
      report.questionId = job.questionId = randomUUID()
    } else if (kind === 'completed' && job.status === 'executing') job.status = 'completed'
    else if (kind !== 'progress' || !['planning','executing'].includes(job.status)) fail('REPORT_OUT_OF_PHASE', 409)
    this.db.prepare('INSERT INTO reports(job,doc) VALUES (?,?)').run(id, JSON.stringify(report))
    this.save(job)
    return report
  }

  respond(id, {action,proposalId,questionId,message = ''}) {
    const job = this.get(id)
    const proposal = job.status === 'awaiting_approval' && !!proposalId && proposalId === job.proposalId && !questionId
    const question = job.status === 'needs_input' && !!questionId && questionId === job.questionId && !proposalId
    if (!proposal && !question) fail('DECISION_STALE', 409)
    if (!(question ? ['reply','cancel'] : ['approve','revise','cancel']).includes(action) ||
        typeof message !== 'string' || (action === 'reply' && !message.trim())) fail('INVALID_DECISION')
    const decision = {action, message, ...(proposal ? {proposalId} : {questionId}), at: Date.now()}
    const seq = Number(this.db.prepare('INSERT INTO decisions(job,doc) VALUES (?,?)').run(id, JSON.stringify(decision)).lastInsertRowid)
    job.pendingSeq = seq
    job.nextPhase = action === 'revise' ? 'planning' : (question ? job.previousPhase : 'executing')
    if (action === 'cancel') job.status = 'cancelled'
    else if (action === 'approve') job.status = 'approved'
    delete job.proposalId
    delete job.questionId
    this.save(job)
    return {seq,...decision}
  }

  decision(job) {
    if (!job.pendingSeq) return null
    const row = this.db.prepare('SELECT doc FROM decisions WHERE seq=?').get(job.pendingSeq)
    return {seq: job.pendingSeq,...JSON.parse(row.doc)}
  }

  ack(id, seq) {
    const job = this.get(id)
    if (!job.pendingSeq && seq && seq === job.ackedSeq) return job
    if (!seq || seq !== job.pendingSeq) fail('DECISION_STALE',409)
    job.ackedSeq = seq
    if (job.status !== 'cancelled') job.status = job.nextPhase
    delete job.pendingSeq
    delete job.nextPhase
    this.save(job)
    return job
  }

  history(id) {
    return {job: this.get(id), reports: this.db.prepare('SELECT doc FROM reports WHERE job=? ORDER BY seq').all(id).map(r=>JSON.parse(r.doc)),
      decisions: this.db.prepare('SELECT seq,doc FROM decisions WHERE job=? ORDER BY seq').all(id).map(r=>({seq:r.seq,...JSON.parse(r.doc)}))}
  }

  events(after) {
    return this.db.prepare('SELECT id,doc FROM events WHERE id>? AND at>? ORDER BY id').all(after, Date.now()-day)
      .map(r=>({id:r.id,...JSON.parse(r.doc)}))
  }
}
