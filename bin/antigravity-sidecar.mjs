#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '../src/config.mjs'
import { agentApiBinary, callAgentApi } from '../src/launcher/antigravity.mjs'

const config = await loadConfig()
if (config.mode === 'client') process.exit(0)
const binary = await agentApiBinary(config.executables?.agentapi)
const base = 'http://127.0.0.1:' + config.localPort + '/local/sidecar/'

async function heartbeat(message) {
  const res = await fetch(base + 'heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message), signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw Error('Heartbeat HTTP ' + res.status)
  await res.arrayBuffer()
}

async function handle(command) {
  let message = { requestId: command.requestId, ok: true }
  try { await callAgentApi(binary, command) }
  catch (error) { message = { requestId: command.requestId, ok: false, error: error.message, code: error.code, status: error.status } }
  await heartbeat(message)
}

while (true) {
  const connection = new AbortController()
  let timer
  try {
    const res = await fetch(base + 'events', { signal: connection.signal })
    if (!res.ok) throw Error('Sidecar event stream HTTP ' + res.status)
    await heartbeat({})
    timer = setInterval(() => heartbeat({}).catch(error => connection.abort(error)), 10000)
    const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity })
    for await (const line of lines) {
      if (line.startsWith('data:')) handle(JSON.parse(line.slice(5))).catch(error => connection.abort(error))
    }
  } catch (error) {
    console.error('Agent Connecter sidecar:', error.message)
  } finally {
    clearInterval(timer)
    connection.abort()
  }
  await delay(3000)
}
