#!/usr/bin/env node
// @ts-check
// One real turn on the free lane — only when the caller asks for one.
//
// Without `--live` this prints `Skipped` and sends nothing, which is how CI runs
// it: the CI job must be able to prove that the script exists, runs, and reaches
// no network, without spending the lane's quota.
//
// With `--live` it starts the package's own gateway on loopback and drives it the
// way a client would, so the thing under test is the shipped path rather than a
// diagnostic side door. Exactly one request, no retry, and a refusal is reported
// as a finding with its class — never retried.
//
// The JSON it prints carries the transport observation 督查 requires: which
// implementation sent the request (`bun` worker child / `node` fetch), that
// worker's pid as the spawn observer saw it, and the version the executable
// reports when asked. `basis: "observed"` is written by the branch that sent, in
// src/egress.js; nothing here reads an environment variable to decide it.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = name => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

if (!argv.includes('--live')) {
  console.log('Skipped: pass --live to send an actual request.')
  process.exit(0)
}

const model = arg('--model') ?? 'nemotron-3.5-lightning-free'
const { startGateway } = await import('../src/gateway.js')
const { transportRecord } = await import('../src/egress.js')

/** The worker spawns the preload recorded, if the run was started with it. */
function workerSpawns() {
  const dir = process.env.OFM_WIRE_DIR
  if (!dir) return []
  const file = join(dir, 'transport.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(entry => entry?.kind === 'spawn')
}

/** Ask the executable for its version, rather than trusting a variable. */
function observedVersion(executable) {
  if (typeof executable !== 'string' || executable === '') return null
  try {
    return execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim() || null
  } catch {
    return null
  }
}

const gateway = await startGateway({ port: 0 })
try {
  const started = Date.now()
  const response = await fetch(`${gateway.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Do not use tools. Reply with exactly: PONG' }],
      max_completion_tokens: 128,
    }),
  })
  const body = await response.json().catch(() => null)
  const reply = String(body?.choices?.[0]?.message?.content ?? '')
  const ok = response.status === 200 && reply.trim() === 'PONG'
  const record = transportRecord()
  const spawns = workerSpawns()
  const worker = spawns[0] ?? null
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    model,
    ok,
    status: response.status,
    reply: reply.slice(0, 120),
    elapsedMs: Date.now() - started,
    billingSource: body?.usage?.opencode?.billing_source ?? null,
    laneCode: response.headers.get('x-free-lane-code'),
    retried: false,
    transport: {
      observed: record.observed,
      basis: record.basis,
      requests: record.requests,
      last: record.last,
      worker: worker === null ? null : {
        pid: worker.pid,
        command: worker.command,
        version: observedVersion(worker.command),
        observerPid: worker.observerPid ?? null,
      },
      spawns: spawns.length,
    },
    note: ok ? 'single request, no retry' : 'single request, no retry — a refusal is a finding, not a retry trigger',
  }, null, 1))
  process.exitCode = ok ? 0 : 1
} finally {
  await gateway.close()
}
