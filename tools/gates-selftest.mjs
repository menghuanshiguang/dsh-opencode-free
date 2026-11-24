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

const perfectLive = { model: 'nemotron-3.5-lightning-free', ok: true, status: 200, reply: 'PONG', billingSource: 'free', elapsedMs: 1723, chunks: 37 }
const egress = { egressIp: '48.214.54.99', country: 'US', colo: 'IAD' }
const lockSha = perfectFields.toolsSha256
const sent = { requests: 1, bodies: [] }
const nothing = { requests: 0, bodies: [] }

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
  const ok = result.gates.checks['0.3-transport-bun']?.pass === false && result.gates.checks['0.3-no-node-transport']?.pass === false
  console.log(`${ok ? 'PASS' : 'FAIL'} negative-node: OUR_FREE_MODEL_FREE_TRANSPORT=node fails 0.3`)
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
