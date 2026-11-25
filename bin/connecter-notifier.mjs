#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'
import { credentials, remote, events } from '../src/client/http.mjs'
import { notify } from '../src/client/toast.mjs'
const request = remote(await credentials())
let cursor='latest'
for (;;) {
  try {
    const res=await request('/api/events',{headers:{'Last-Event-ID':String(cursor)}})
    for await (const event of events(res)) {
      if (['awaiting_approval','needs_input','needs_resume','completed','failed'].includes(event.status)) await notify(event)
      cursor=event.id
    }
  } catch (error) {
    console.error(error.message)
    if ([401,403,409].includes(error.status)) process.exit(1)
  }
  await delay(2000)
}
