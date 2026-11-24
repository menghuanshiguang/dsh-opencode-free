// Assembles gates.json: the single machine-readable number source for stage 0.
//
// Every value comes from a file the run produced (the fingerprint dump, the live
// script's JSON, the wire capture, the egress probe). Nothing is typed in, and a
// missing input is a failed check rather than a blank field.
//
// The check list is exported as a pure function so `tools/gates-selftest.mjs` can
// feed it a perfect synthetic run and a payload-free one: a validator nobody has
// seen fail is decoration, and this group has one live budget to spend.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const readEnvFile = path => {
  if (!path || !existsSync(path)) return {}
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('=')
    return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : [line, '']
  }))
}

/** Build the gate record from already-parsed inputs. Pure; no filesystem reads. */
export function buildGates({ fields = null, live = null, wire = { requests: 0, bodies: [], transports: [] }, egress = {}, env = {}, expectedToolsSha256 = null } = {}) {
  const checks = {}
  const check = (name, pass, detail) => { checks[name] = { pass: !!pass, ...(detail === undefined ? {} : { detail }) } }
  const bunVersion = env.GATES_BUN_VERSION ?? ''

  check('0.1-dispatch-only', env.GITHUB_EVENT_NAME === 'workflow_dispatch', env.GITHUB_EVENT_NAME)
  check('0.1-confirm', env.GATES_CONFIRM === 'true', env.GATES_CONFIRM)
  check('0.2-ubuntu-latest', String(env.RUNNER_OS ?? '').toLowerCase() === 'linux', env.RUNNER_OS)
  check('0.2-bun-version', bunVersion.length > 0, bunVersion)
  // 督查's ruling (2026-11-24): the transport is what the code that sent the
  // request recorded, never what the runner had installed. The live script writes
  // that observation (src/egress.js), and the spawn preload records the worker
  // child's pid; both have to agree, and at least one request must have gone out.
  // A `derived` record — the shape stage 0 produced — fails here by design.
  const observed = live?.transport ?? null
  const observedBasis = observed?.basis === 'observed'
  const workerPid = observed?.worker?.pid ?? null
  const observationDetail = observed === null
    ? 'no transport observation in live.json (derived stays derived)'
    : `observed=${observed.observed ?? 'none'} basis=${observed.basis ?? 'none'} requests=${observed.requests ?? '?'} workerPid=${workerPid ?? 'none'} spawns=${observed.spawns ?? 0}`
  check('0.3-transport-bun',
    observedBasis && observed.observed === 'bun' && Number.isInteger(observed.requests) && observed.requests >= 1
      && workerPid !== null && bunVersion.length > 0,
    observationDetail)
  check('0.3-transport-observed',
    observedBasis,
    observedBasis ? 'live.json carries basis=observed' : 'live.json carries no observation (derived)')
  check('0.3-worker-spawn-recorded',
    Array.isArray(wire.transports) && wire.transports.some(entry => entry?.kind === 'spawn' && entry?.transport === 'bun'),
    `${Array.isArray(wire.transports) ? wire.transports.length : 0} spawn record(s) in the capture`)
  check('0.3-no-node-transport', (env.OUR_FREE_MODEL_FREE_TRANSPORT ?? '') === '', env.OUR_FREE_MODEL_FREE_TRANSPORT ?? '(unset)')
  check('0.4-egress', Boolean(egress.egressIp) && Boolean(egress.country), `${egress.egressIp ?? '?'} / ${egress.country ?? '?'}`)
  check('0.5-200-pong', live?.ok === true && live?.status === 200 && String(live?.reply ?? '').trim() === 'PONG', live?.status)
  check('0.6-billing-source', Boolean(live?.billingSource), live?.billingSource ?? null)
  // The count is the observed one when there is an observation; the wire tap stays
  // as the cross-check (it records the serialised body the lane sent).
  const postCount = observedBasis && Number.isInteger(observed?.requests) ? observed.requests : wire.requests
  check('0.7-single-request', postCount === 1, postCount)
  check('0.7-no-retry', (live?.retried ?? false) === false && postCount <= 1, live?.retried ?? false)
  // 督查's ruling: 0.8 is a comparison, not a format check. The lock is validated by
  // free-lane-ci on the same commit, so equality here is transitive evidence — and
  // any 64-hex string no longer passes. The reverse fixture flips one digit.
  check('0.8-tools-sha256',
    typeof fields?.toolsSha256 === 'string' && fields.toolsSha256.length === 64
      && expectedToolsSha256 !== null && fields.toolsSha256 === expectedToolsSha256,
    `live=${fields?.toolsSha256 ?? '?'} lock=${expectedToolsSha256 ?? '(no lock)'}`)
  check('0.9-inputs-present', fields !== null && live !== null, { fields: fields !== null, live: live !== null })

  return {
    generatedAt: new Date().toISOString(),
    run: {
      id: env.GITHUB_RUN_ID ?? null,
      attempt: env.GITHUB_RUN_ATTEMPT ?? null,
      event: env.GITHUB_EVENT_NAME ?? null,
      actor: env.GITHUB_ACTOR ?? null,
      repository: env.GITHUB_REPOSITORY ?? null,
      workflow: env.GITHUB_WORKFLOW ?? null,
      runnerOs: env.RUNNER_OS ?? null,
      url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    },
    runtime: {
      node: env.NODE_VERSION_FULL ?? process.version,
      platform: env.RUNNER_OS ?? process.platform,
      bunVersion: bunVersion || null,
      bunPath: env.OUR_FREE_MODEL_BUN ?? null,
      transportEnv: env.OUR_FREE_MODEL_FREE_TRANSPORT ?? '',
      transport: observedBasis ? observed.observed : (fields?.transport?.resolved ?? null),
      transportBasis: observedBasis ? 'observed' : 'derived',
      transportDerived: !observedBasis,
      // The archive schema 总策划 froze: four keys, written by the code that sent,
      // read back from the capture. `implementation` comes from the egress record,
      // the pid from the spawn observer, the version from asking the executable,
      // and `source` names both capture files so a reader can go and look.
      transportObserved: observedBasis
        ? {
          implementation: observed.observed === 'bun' ? 'bun-worker' : 'node-fetch',
          pid: workerPid,
          version: observed.worker?.version ?? null,
          source: `live.json transport (src/egress.js) + ${join('wire', 'transport.jsonl')} spawn record`,
        }
        : null,
      transportObservation: observedBasis ? observed : null,
    },
    model: live?.model ?? fields?.model ?? null,
    ok: live?.ok ?? null,
    status: live?.status ?? null,
    reply: live?.reply ?? null,
    billingSource: live?.billingSource ?? null,
    elapsedMs: live?.elapsedMs ?? null,
    chunks: live?.chunks ?? null,
    retried: live?.retried ?? false,
    postCount,
    egressIp: egress.egressIp ?? null,
    country: egress.country ?? null,
    colo: egress.colo ?? null,
    toolsSha256: fields?.toolsSha256 ?? null,
    systemPromptSha256: fields?.systemPromptSha256 ?? null,
    systemPromptBytes: fields?.systemPrompt?.bytes ?? null,
    sessionId: fields?.sessionId ?? null,
    userAgent: fields?.userAgent ?? null,
    endpoint: fields?.endpoint ?? null,
    toolCount: fields?.toolCount ?? null,
    toolNames: fields?.tools?.map(tool => tool.name) ?? null,
    errorEnvelope: wire.bodies[0] ?? null,
    checks,
    passed: Object.values(checks).every(entry => entry.pass),
  }
}

/** Read the run's files off disk and build the record. */
export function readGatesInputs({ fieldsPath, livePath, egressPath, wireDir, lockPath }) {
  const readJson = path => { try { return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null } }
  let wire = { requests: 0, bodies: [], transports: [] }
  if (wireDir && existsSync(join(wireDir, 'wire.jsonl'))) {
    const records = readFileSync(join(wireDir, 'wire.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    wire = { requests: records.filter(record => record.kind === 'request').length, bodies: records.filter(record => record.kind === 'response'), transports: [] }
  }
  if (wireDir && existsSync(join(wireDir, 'transport.jsonl'))) {
    wire.transports = readFileSync(join(wireDir, 'transport.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  }
  const lock = readJson(lockPath)
  return { fields: readJson(fieldsPath), live: readJson(livePath), wire, egress: readEnvFile(egressPath), env: process.env, expectedToolsSha256: lock?.toolsSha256 ?? null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const value = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined }
  const inputs = readGatesInputs({
    fieldsPath: value('--fields'), livePath: value('--live'), egressPath: value('--egress'), wireDir: value('--wire'),
    lockPath: value('--lock') ?? new URL('../docs/fingerprint-baseline.json', import.meta.url).pathname,
  })
  const gates = buildGates(inputs)
  const text = JSON.stringify(gates, null, 2)
  console.log(text)
  const out = value('--out')
  if (out) writeFileSync(out, `${text}\n`)
  // The archive projection is what a rehearsal is judged on and what an artifact
  // should carry; the flat record above stays the input the archive tool reads.
  if (!gates.passed) {
    const failed = Object.entries(gates.checks).filter(([, entry]) => !entry.pass).map(([name]) => name)
    console.error(`\nGATES: FAIL (${failed.length}) — ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log('\nGATES: PASS')
}
