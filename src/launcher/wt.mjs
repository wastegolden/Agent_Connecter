import childProcess from 'node:child_process'
import { lstatSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fail } from '../config.mjs'
import { cleanEnv } from './env.mjs'

export function resolveExecutable(name) {
  const candidates = dirname(name) === '.'
    ? (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name))
    : [name]
  return candidates.find(file => {
    // WindowsApps aliases are reparse points. Following one can fail even when it is runnable.
    try {
      const entry = lstatSync(file, { throwIfNoEntry: false })
      return entry?.isFile() || entry?.isSymbolicLink()
    } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
      return false
    }
  })
}

export function safeArgs(args) {
  if (args.some(arg => typeof arg !== 'string' || /[;\p{Cc}]/u.test(arg))) fail('UNSAFE_LAUNCH_ARGUMENT')
  return args
}

export function run(file, args, cwd, env = cleanEnv(), timeout = 10000) {
  const options = { cwd, env, timeout, shell: false, windowsHide: true, stdio: 'ignore' }
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(file, safeArgs(args), options)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(Object.assign(Error(file + ' exited with ' + (signal || code)), { code:'LAUNCH_FAILED', status:502 }))
    })
    child.unref()
  })
}

export function visibleTab(wt, executable, args, cwd, jobId) {
  const argv = ['-w', '0', 'new-tab', '--title', '[connecter] ' + jobId, '-d', cwd, '--', executable, ...args]
  return run(wt, argv, cwd, undefined, 0)
}
