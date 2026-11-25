#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs'
import { serveStdio } from '../src/mcp/server.mjs'
await serveStdio(await loadConfig())
