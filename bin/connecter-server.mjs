#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs'
import { startServer } from '../src/server/http.mjs'
const {lanServer,localServer,close} = await startServer(await loadConfig())
console.log('LAN',lanServer.address(),'loopback',localServer.address())
process.once('SIGINT',close)
process.once('SIGTERM',close)
