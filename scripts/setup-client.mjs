import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { setup } from './setup.mjs'

const { values } = parseArgs({ options: {
  server: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' }
} })
if (values.help) {
  console.log('node scripts/setup-client.mjs [--server URL --code CODE [--name CLIENT]]')
  process.exit(0)
}
if (Boolean(values.server) !== Boolean(values.code)) throw new Error('Pair with --server URL --code CODE')
const { current } = await setup('client', {})
if (values.server) {
  const args = [join(current, 'bin/connecter-cli.mjs'), 'link', values.server, '--code', values.code]
  if (values.name) args.push('--name', values.name)
  execFileSync(process.execPath, args, { shell: false, stdio: 'inherit' })
}
console.log('Client configured. Local plugin directory:', current)
