// Transport observer for the live run: which process actually carried the bytes.
//
// A preload, like the wire tap. `setup-bun` installing a binary says nothing about
// whether this run used it, so the observation has to come from the spawn itself:
// the lane's Bun transport starts a worker child, and its pid, executable and
// argv are recorded here, in the capture directory, next to the wire records.
//
// It observes and nothing else: the child is started exactly as before, and a
// non-Bun command is passed through untouched.
import { appendFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const dir = process.env.OFM_WIRE_DIR
const bunWorker = args => Array.isArray(args) && args.some(arg => String(arg).includes('worker.mjs'))

if (dir) {
  mkdirSync(dir, { recursive: true })
  const record = payload => appendFileSync(join(dir, 'transport.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`)
  const require = createRequire(import.meta.url)
  try {
    const childProcess = require('node:child_process')
    const originalSpawn = childProcess.spawn
    childProcess.spawn = function observedSpawn(command, args, ...rest) {
      const child = originalSpawn.call(this, command, args, ...rest)
      try {
        if (/bun/i.test(String(command)) || bunWorker(args)) {
          record({
            kind: 'spawn',
            transport: 'bun',
            pid: child?.pid ?? null,
            command: String(command),
            argv: Array.isArray(args) ? args.map(String) : [],
            observerPid: process.pid,
          })
        }
      } catch { /* the observer must never disturb the send it observes */ }
      return child
    }
  } catch { /* a platform without child_process cannot spawn the Bun worker either */ }

  process.on('exit', () => {
    console.error(`[observe-transport] spawns recorded in ${join(dir, 'transport.jsonl')}`)
  })
}
