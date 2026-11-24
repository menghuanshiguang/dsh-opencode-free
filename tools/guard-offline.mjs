// CI network guard: a preload that refuses every outbound request except loopback.
//
// The CI job must not spend the free lane's quota by accident, and the honest way
// to promise "not one byte to opencode.ai" is to enforce it in the process that
// would send the byte, not to trust a source scan. Every off-loopback `fetch` and
// every attempt to start a native `bun` (the lane's production transport) throws.
import { createRequire } from 'node:module'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '0:0:0:0:0:0:0:1'])
const attempts = []

const hostOf = input => {
  const raw = typeof input === 'string' ? input : input?.url ?? String(input)
  try { return new URL(raw) } catch { return null }
}

const originalFetch = globalThis.fetch
globalThis.fetch = function guardedFetch(input, init) {
  const url = hostOf(input)
  const host = url?.hostname ?? ''
  if (!LOOPBACK.has(host)) {
    attempts.push(host || String(input))
    console.error(`[guard-offline] BLOCKED fetch ${host || '?'}${url?.pathname ?? ''}`)
    return Promise.reject(new Error(`offline CI: outbound request to ${host || 'unknown host'} is forbidden`))
  }
  return originalFetch.call(this, input, init)
}

// `bunFetch` spawns the native Bun worker; that is the lane's real transport and
// must never start in a CI run. Replacing the CJS export covers callers that
// destructure `spawn` after this preload runs.
const require = createRequire(import.meta.url)
try {
  const childProcess = require('node:child_process')
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function guardedSpawn(command, ...rest) {
    if (/bun/i.test(String(command))) {
      attempts.push(`spawn:${command}`)
      throw new Error('offline CI: starting the Bun worker is forbidden here')
    }
    return originalSpawn.call(this, command, ...rest)
  }
} catch { /* a platform without child_process cannot spawn Bun either */ }

process.on('exit', code => {
  if (attempts.length) {
    console.error(`[guard-offline] blocked ${attempts.length} attempt(s): ${attempts.join(', ')}`)
    if (code === 0) process.exitCode = 1
  } else {
    console.error('[guard-offline] no off-loopback request was attempted')
  }
})
