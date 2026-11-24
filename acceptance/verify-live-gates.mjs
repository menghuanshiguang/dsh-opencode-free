#!/usr/bin/env node
// 验收员 live gate: judge one live run's gates.json against the lock and the stage-4 criteria.
// Nothing here is taken on trust: postCount, the transport observation, toolsSha256 and the
// billing source are each compared, and each check has a demonstrated red side (--selftest).
//
// usage:
//   verify-live-gates.mjs --gates <gates.json> --lock <docs/fingerprint-baseline.json>
//   verify-live-gates.mjs --selftest
// rc: 0 pass, 1 fail (each failure named), 2 cannot run / bad usage.
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const sha = s => s

function check(gates, lock) {
  const failures = []
  const fail = m => failures.push(m)
  const req = gates.request ?? {}
  const env = gates.env ?? {}
  const resp = gates.response ?? {}
  const fp = gates.fingerprint ?? {}

  // 1. exactly one request, never retried
  if (req.postCount !== 1) fail(`postCount is ${JSON.stringify(req.postCount)}, expected 1`)
  if (req.retried !== false) fail(`retried is ${JSON.stringify(req.retried)}, expected false`)

  // 2. the transport must be an observation, not an inference
  if (env.transport !== 'bun') fail(`transport is ${JSON.stringify(env.transport)}, expected "bun"`)
  if (env.transportBasis === 'derived') fail('transport is derived, not observed — a derived transport cannot be shipped as evidence')
  if (!String(env.bunVersion ?? '').trim()) fail('bunVersion is empty')
  if (req.postCount !== 1 && env.transport === 'bun') fail('transport claims bun while postCount is not 1: nothing proved it')

  // 3. the fingerprint is the locked one, byte for byte
  if (fp.toolsSha256 !== lock.toolsSha256) fail(`toolsSha256 ${String(fp.toolsSha256).slice(0, 16)}… != lock ${String(lock.toolsSha256).slice(0, 16)}…`)

  // 4. the upstream actually answered, on the free lane
  if (resp.ok !== true) fail(`response.ok is ${JSON.stringify(resp.ok)}, expected true`)
  if (resp.status !== 200) fail(`response.status is ${JSON.stringify(resp.status)}, expected 200`)
  if (!String(resp.billingSource ?? '').trim()) fail('billingSource is empty')

  // 5. one model, the locked one
  if (req.model !== lock.model) fail(`model ${JSON.stringify(req.model)} != lock ${JSON.stringify(lock.model)}`)

  // 6. every gate passes, and there is a gate set to speak of
  const list = Array.isArray(gates.gates) ? gates.gates : []
  if (list.length === 0) fail('no gates in the document')
  for (const g of list) if (g.pass !== true) fail(`gate ${g.id} did not pass: ${String(g.evidence ?? '').slice(0, 120)}`)

  return { failures, verdict: failures.length === 0 ? 'PASS' : 'FAIL', summary: {
    model: req.model, postCount: req.postCount, transport: env.transport, transportBasis: env.transportBasis ?? null,
    bunVersion: env.bunVersion ?? null, toolsSha256: fp.toolsSha256, response: { ok: resp.ok, status: resp.status, billingSource: resp.billingSource },
    gates: { total: list.length, passed: list.filter(g => g.pass === true).length },
  } }
}

if (argv.includes('--selftest')) {
  // a healthy document that must pass, then one mutation per check that must fail
  const lock = { model: 'm-free', toolsSha256: 'aa'.repeat(32) }
  const healthy = {
    request: { model: 'm-free', postCount: 1, retried: false },
    env: { transport: 'bun', transportBasis: 'observed', bunVersion: '1.4.5' },
    fingerprint: { toolsSha256: 'aa'.repeat(32) },
    response: { ok: true, status: 200, billingSource: 'free' },
    gates: [{ id: '0.1', pass: true }, { id: '0.2', pass: true }],
  }
  const cases = [
    ['healthy', null, 'PASS'],
    ['postCount 0', d => { d.request.postCount = 0 }, 'FAIL'],
    ['retried true', d => { d.request.retried = true }, 'FAIL'],
    ['transport derived', d => { d.env.transportBasis = 'derived' }, 'FAIL'],
    ['transport node', d => { d.env.transport = 'node' }, 'FAIL'],
    ['toolsSha256 one byte off', d => { d.fingerprint.toolsSha256 = 'ab' + 'aa'.repeat(31) }, 'FAIL'],
    ['billingSource empty', d => { d.response.billingSource = '' }, 'FAIL'],
    ['status 429', d => { d.response.status = 429; d.response.ok = false }, 'FAIL'],
    ['a gate did not pass', d => { d.gates[1].pass = false }, 'FAIL'],
  ]
  let bad = 0
  for (const [name, mutate, expected] of cases) {
    const doc = structuredClone(healthy)
    if (mutate) mutate(doc)
    const r = check(doc, lock)
    const got = r.verdict === expected ? 'ok  ' : 'BAD '
    if (r.verdict !== expected) bad++
    console.log(`  ${got}${name}: ${r.verdict}${r.failures.length ? ' — ' + r.failures[0] : ''}`)
  }
  console.log(bad === 0 ? 'SELFTEST: PASS (every check has a red side)' : `SELFTEST: FAIL (${bad} case(s) did not behave)`)
  process.exit(bad === 0 ? 0 : 1)
}

const gatesPath = arg('gates'), lockPath = arg('lock')
if (!gatesPath || !lockPath) { console.error('usage: verify-live-gates.mjs --gates <gates.json> --lock <docs/fingerprint-baseline.json> | --selftest'); process.exit(2) }
let gates, lock
try {
  gates = JSON.parse(readFileSync(gatesPath, 'utf8'))
  lock = JSON.parse(readFileSync(lockPath, 'utf8'))
} catch (e) { console.error(`verify-live-gates: cannot read: ${e.message}`); process.exit(2) }

const r = check(gates, lock)
console.log(JSON.stringify({ ...r.summary, failures: r.failures, VERDICT: r.verdict }, null, 2))
console.log(r.verdict === 'PASS' ? 'LIVE-GATES: PASS' : `LIVE-GATES: FAIL (${r.failures.length})`)
process.exit(r.verdict === 'PASS' ? 0 : 1)
