// The validator's own fixture: a perfect synthetic run must pass, and a run that
// sent nothing must fail the checks that claim a request went out.
//
// This exists because "0.3 passes with postCount=0" was a real defect that a code
// review had accepted: the transport was inferred, not observed. A check nobody
// has watched fail is decoration.
//
//   node tools/gates-selftest.mjs
import { buildGates } from './gates.mjs'

const baseEnv = {
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GATES_CONFIRM: 'true',
  RUNNER_OS: 'linux',
  GATES_BUN_VERSION: '1.4.5',
  OUR_FREE_MODEL_BUN: '/home/runner/.bun/bin/bun',
  GITHUB_RUN_ID: '1',
  GITHUB_REPOSITORY: 'menghuanshiguang/dsh-opencode-free',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_WORKFLOW: 'free-lane-live',
  GITHUB_ACTOR: 'fixture',
}

const perfectFields = {
  model: 'nemotron-3.5-lightning-free',
  endpoint: '/inference/openai/v1/chat/completions',
  platform: 'linux',
  userAgent: 'opencode/latest/2.2.3/cli',
  sessionId: 'ses_e8af4439fffe2Mai2160XtxifI',
  toolsSha256: '6fb3aed805228cc69ca5e838b7af2fffa9bf57b8c27ebd7606fd94e41c05b77f',
  systemPromptSha256: '24f1d1d475e1abc4e43ecd22d9caa7f27397bdce5d091247c4e8551a2565f2e7',
  systemPrompt: { bytes: 2007 },
  toolCount: 13,
  tools: [{ name: 'read' }],
  transport: { env: '(unset)', bun: '/home/runner/.bun/bin/bun', resolved: 'bun' },
}

// The transport observation is part of a perfect run now (督查 2026-11-24): the
// code that sent the request records which implementation it used, the worker's
// pid and the version the executable reports. A `derived` transport is the stage-0
// shape and must fail 0.3 — the case below keeps that red side honest.
const observedTransport = {
  observed: 'bun',
  basis: 'observed',
  requests: 1,
  last: { method: 'POST', at: '2026-11-24T05:26:03.000Z', status: 200, elapsedMs: 631 },
  worker: { pid: 4242, command: '/home/runner/.bun/bin/bun', version: '1.4.5', observerPid: 4200 },
  spawns: 1,
}
const perfectLive = { model: 'nemotron-3.5-lightning-free', ok: true, status: 200, reply: 'PONG', billingSource: 'free', elapsedMs: 1723, chunks: 37, retried: false, transport: observedTransport }
/** The stage-0 shape: transport described, never observed. */
const derivedLive = { ...perfectLive, transport: { observed: 'bun', basis: 'derived', requests: 1, worker: { pid: 4242 } } }
const egress = { egressIp: '48.214.54.99', country: 'US', colo: 'IAD' }
const lockSha = perfectFields.toolsSha256
const spawnRecord = { kind: 'spawn', transport: 'bun', pid: 4242, command: '/home/runner/.bun/bin/bun', argv: ['/home/runner/.dsh/opencode-free/run/worker.mjs'] }
const sent = { requests: 1, bodies: [], transports: [spawnRecord] }
const nothing = { requests: 0, bodies: [], transports: [] }

let failed = 0
const run = (label, args) => {
  const gates = buildGates(args)
  const bad = Object.entries(gates.checks).filter(([, entry]) => !entry.pass).map(([name]) => name)
  return { label, passed: gates.passed, bad, gates }
}

// 1. A perfect synthetic run must pass everything.
{
  const result = run('positive', { fields: perfectFields, live: perfectLive, wire: sent, egress, env: { ...baseEnv }, expectedToolsSha256: lockSha })
  const ok = result.passed
  console.log(`${ok ? 'PASS' : 'FAIL'} positive: a complete 200 passes all ${Object.keys(result.gates.checks).length} checks${ok ? '' : ` — failing: ${result.bad.join(', ')}`}`)
  if (!ok) failed += 1
}

// 1b. The transport observation has its own red side: the stage-0 shape (derived)
// must fail 0.3 even though every other field of the run is perfect.
{
  const result = run('derived-transport', { fields: perfectFields, live: derivedLive, wire: sent, egress, env: { ...baseEnv }, expectedToolsSha256: lockSha })
  const ok = !result.gates.checks['0.3-transport-bun'].pass && !result.gates.checks['0.3-transport-observed'].pass
  console.log(`${ok ? 'PASS' : 'FAIL'} derived-transport: a derived transport fails 0.3 by design${ok ? '' : ` — 0.3 says: ${JSON.stringify(result.gates.checks['0.3-transport-bun'])}`}`)
  if (!ok) failed += 1
}

// 1c. And the node-branch shape: an observation that says node must fail too, so
// "recorded" alone is not enough — the recorded transport has to be the Bun worker.
{
  const nodeLive = { ...perfectLive, transport: { ...observedTransport, observed: 'node' } }
  const result = run('node-transport', { fields: perfectFields, live: nodeLive, wire: sent, egress, env: { ...baseEnv }, expectedToolsSha256: lockSha })
  const ok = !result.gates.checks['0.3-transport-bun'].pass
  console.log(`${ok ? 'PASS' : 'FAIL'} node-transport: an observed node transport fails 0.3${ok ? '' : ' — it passed, which it must not'}`)
  if (!ok) failed += 1
}

// 2. No request sent: 0.3 must NOT pass, and neither may the response checks.
{
  const result = run('negative-empty', { fields: perfectFields, live: null, wire: nothing, egress, env: { ...baseEnv }, expectedToolsSha256: lockSha })
  const mustFail = ['0.3-transport-bun', '0.5-200-pong', '0.6-billing-source', '0.7-single-request', '0.9-inputs-present']
  const stillPassing = mustFail.filter(name => result.gates.checks[name]?.pass)
  const ok = result.passed === false && stillPassing.length === 0
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-empty: no request fails ${mustFail.join(', ')}${ok ? '' : ` — still passing: ${stillPassing.join(', ') || '(none)'}`}`)
  if (!ok) failed += 1
}

// 3. Diagnostics transport forced to node: 0.3 must fail on that alone.
{
  const result = run('negative-node', {
    fields: { ...perfectFields, transport: { env: 'node', bun: '/home/runner/.bun/bin/bun', resolved: 'node' } },
    live: perfectLive, wire: sent, egress, env: { ...baseEnv, OUR_FREE_MODEL_FREE_TRANSPORT: 'node' }, expectedToolsSha256: lockSha,
  })
  // With an observed transport, 0.3-transport-bun reads the observation, so this
  // fixture asserts the two checks that are about the environment and the recorded
  // branch: the override switch must be unset, and a run whose observation says
  // `node` must not pass transport-bun.
  const nodeObserved = run('negative-node-observed', { fields: perfectFields, live: { ...perfectLive, transport: { ...observedTransport, observed: 'node' } }, wire: sent, egress, env: { ...baseEnv, OUR_FREE_MODEL_FREE_TRANSPORT: 'node' }, expectedToolsSha256: lockSha })
  const ok = result.gates.checks['0.3-no-node-transport']?.pass === false
    && nodeObserved.gates.checks['0.3-transport-bun']?.pass === false
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-node: OUR_FREE_MODEL_FREE_TRANSPORT=node fails the override check, and a node observation fails 0.3`)
  if (!ok) failed += 1
}

// 4. Bun absent: 0.3 must fail even when bytes went out.
{
  const result = run('negative-nobun', {
    fields: { ...perfectFields, transport: { env: '(unset)', bun: '', resolved: 'missing-bun' } },
    live: perfectLive, wire: sent, egress, env: { ...baseEnv, GATES_BUN_VERSION: '' }, expectedToolsSha256: lockSha,
  })
  const ok = result.gates.checks['0.3-transport-bun']?.pass === false && result.gates.checks['0.2-bun-version']?.pass === false
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-nobun: a missing Bun version fails 0.2 and 0.3`)
  if (!ok) failed += 1
}

// 5. A wrong event must be refused.
{
  const result = run('negative-push', { fields: perfectFields, live: perfectLive, wire: sent, egress, env: { ...baseEnv, GITHUB_EVENT_NAME: 'push' }, expectedToolsSha256: lockSha })
  const ok = result.gates.checks['0.1-dispatch-only']?.pass === false
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-push: a push-triggered run fails 0.1`)
  if (!ok) failed += 1
}

// 6. One flipped digit in the lock must fail 0.8 — otherwise it is a format check.
{
  const flipped = `${lockSha.slice(0, -1)}${lockSha.endsWith('f') ? '0' : 'f'}`
  const result = run('negative-sha', { fields: perfectFields, live: perfectLive, wire: sent, egress, env: { ...baseEnv }, expectedToolsSha256: flipped })
  const ok = result.gates.checks['0.8-tools-sha256']?.pass === false
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-sha: a lock that differs from the wire fails 0.8`)
  if (!ok) failed += 1
}

// 7. No lock at all must fail 0.8 as well.
{
  const result = run('negative-nolock', { fields: perfectFields, live: perfectLive, wire: sent, egress, env: { ...baseEnv }, expectedToolsSha256: null })
  const ok = result.gates.checks['0.8-tools-sha256']?.pass === false
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-nolock: no baseline lock fails 0.8`)
  if (!ok) failed += 1
}

if (failed) {
  console.error(`\nSELFTEST: FAIL (${failed} fixture(s))`)
  process.exit(1)
}
console.log('\nSELFTEST: PASS (1 positive, 6 negative)')
