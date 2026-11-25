import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { configDir, loadConfig } from '../src/config.mjs'
import { setup } from './setup.mjs'

const { values } = parseArgs({ options: {
  project: { type: 'string', multiple: true },
  'lan-port': { type: 'string' }, 'local-port': { type: 'string' },
  task: { type: 'boolean' }, firewall: { type: 'boolean' }, 'serve-updates': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
} })
if (values.help) {
  console.log('node scripts/setup-server.mjs [--project name=directory]... [--task] [--serve-updates] [--lan-port N] [--local-port N]\nnode scripts/setup-server.mjs --firewall [--lan-port N]')
  process.exit(0)
}
const changes = {}
for (const [flag, key] of [['lan-port', 'lanPort'], ['local-port', 'localPort']]) {
  if (values[flag] === undefined) continue
  const port = Number(values[flag])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --' + flag)
  changes[key] = port
}
function powershell(script, env) {
  if (process.platform !== 'win32') throw new Error('Windows is required for Task Scheduler and firewall setup')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'\n" + script], {
    shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env, ...env }
  })
}

if (values.firewall) {
  // Standalone elevated operation, without creating a task under an administrator account.
  if (values.task || values.project || values['serve-updates'] || values['local-port']) {
    throw new Error('Run --firewall separately from normal-user server setup')
  }
  const port = changes.lanPort ?? (existsSync(join(configDir(), 'config.json')) ? (await loadConfig()).lanPort : 3090)
  powershell(`
    $rule = @{ Name='AgentConnecter-PrivateLAN'; Direction='Inbound'; Protocol='TCP'; LocalPort=$env:CONNECTER_PORT; RemoteAddress='LocalSubnet'; Profile='Private'; Action='Allow'; Enabled='True' }
    if (Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue) { Set-NetFirewallRule @rule }
    else { New-NetFirewallRule @rule -DisplayName 'Agent Connecter (Private LAN)' }
  `, { CONNECTER_PORT: String(port) })
} else {
  if (values.project) {
    const entries = []
    for (const spec of values.project) {
      const delimiter = spec.indexOf('=')
      const name = spec.slice(0, delimiter)
      const cwd = spec.slice(delimiter + 1)
      if (delimiter < 1 || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
        throw new Error('Use --project name=absolute-directory')
      }
      entries.push([name, cwd])
    }
    changes.projects = Object.fromEntries(entries)
  }
  if (values['serve-updates']) changes.serveUpdates = true
  const { current } = await setup('server', changes)
  if (values.task) {
    const envFile = join(configDir(), 'task.env')
    await writeFile(envFile, "AGENT_CONNECTER_HOME='" + configDir() + "'\n")
    powershell(`
      $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      $action = New-ScheduledTaskAction -Execute $env:CONNECTER_NODE -Argument ('--env-file="' + $env:CONNECTER_ENV + '" "' + $env:CONNECTER_SERVER + '"')
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
      $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
      Register-ScheduledTask -TaskName 'Agent Connecter Server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
      Start-ScheduledTask -TaskName 'Agent Connecter Server'
    `, { CONNECTER_NODE: process.execPath, CONNECTER_SERVER: join(current, 'bin/connecter-server.mjs'), CONNECTER_ENV: envFile })
  }
  console.log('Server configured. Local plugin directory:', current)
}
