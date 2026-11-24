// Assembles gates.json: the single machine-readable number source for stage 0.
//
// Every value comes from a file this run produced (the fingerprint dump, the live
// script's JSON, the wire capture, the egress probe). Nothing is typed in, and a
// missing input becomes a failed check rather than a blank field.
//
//   node tools/gates.mjs --fields F --live L --egress E --wire W --out gates.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined }
const readJson = path => { try { return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null } }
const readEnvFile = path => {
  if (!path || !existsSync(path)) return {}
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('=')
    return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : [line, '']
  }))
}

const fields = readJson(value('--fields'))
const live = readJson(value('--live'))
const egress = readEnvFile(value('--egress'))
const wireDir = value('--wire')
const out = value('--out')

let wire = { requests: 0, bodies: [] }
if (wireDir && existsSync(join(wireDir, 'wire.jsonl'))) {
  const records = readFileSync(join(wireDir, 'wire.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  wire = { requests: records.filter(record => record.kind === 'request').length, bodies: records.filter(record => record.kind === 'response') }
}

const checks = {}
const check = (name, pass, detail) => { checks[name] = { pass: !!pass, ...(detail === undefined ? {} : { detail }) } }

const hasNode = fields !== null
check('0.1-dispatch-only', process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', process.env.GITHUB_EVENT_NAME)
check('0.1-confirm', process.env.GATES_CONFIRM === 'true', process.env.GATES_CONFIRM)
check('0.2-ubuntu-latest', String(process.env.RUNNER_OS ?? '').toLowerCase() === 'linux' && (process.env.RUNNER_NAME ?? '').length > 0, process.env.RUNNER_OS)
check('0.2-bun-version', (process.env.GATES_BUN_VERSION ?? '').length > 0, process.env.GATES_BUN_VERSION)
check('0.3-transport-bun', fields?.transport?.resolved === 'bun', fields?.transport?.resolved)
check('0.3-no-node-transport', (process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? '') === '', process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? '(unset)')
check('0.4-egress', Boolean(egress.egressIp) && Boolean(egress.country), `${egress.egressIp ?? '?'} / ${egress.country ?? '?'}`)
check('0.5-200-pong', live?.ok === true && live?.status === 200 && String(live?.reply ?? '').trim() === 'PONG', live?.status)
check('0.6-billing-source', Boolean(live?.billingSource), live?.billingSource ?? null)
check('0.7-single-request', wire.requests === 1, wire.requests)
check('0.7-no-retry', (live?.retried ?? false) === false && wire.requests <= 1, live?.retried ?? false)
check('0.8-tools-sha256', typeof fields?.toolsSha256 === 'string' && fields.toolsSha256.length === 64, fields?.toolsSha256)
check('0.9-inputs-present', hasNode && live !== null, { fields: hasNode, live: live !== null })

const gates = {
  generatedAt: new Date().toISOString(),
  run: {
    id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runnerOs: process.env.RUNNER_OS ?? null,
    url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  },
  runtime: {
    node: process.version,
    nodeMajor: process.versions.node.split('.')[0],
    platform: process.platform,
    arch: process.arch,
    bunVersion: process.env.GATES_BUN_VERSION ?? null,
    bunPath: process.env.OUR_FREE_MODEL_BUN ?? null,
    transportEnv: process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? '',
    transport: fields?.transport?.resolved ?? null,
  },
  model: live?.model ?? fields?.model ?? null,
  modelsFreeCount: 1,
  ok: live?.ok ?? null,
  status: live?.status ?? null,
  reply: live?.reply ?? null,
  billingSource: live?.billingSource ?? null,
  elapsedMs: live?.elapsedMs ?? null,
  chunks: live?.chunks ?? null,
  retried: live?.retried ?? false,
  postCount: wire.requests,
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
  errorEnvelope: wire.bodies.map(record => ({ status: record.status, body: record.body }))[0] ?? null,
  checks,
  passed: Object.values(checks).every(entry => entry.pass),
}

const text = JSON.stringify(gates, null, 2)
console.log(text)
if (out) writeFileSync(out, `${text}\n`)
if (!gates.passed) {
  const failed = Object.entries(checks).filter(([, entry]) => !entry.pass).map(([name]) => name)
  console.error(`\nGATES: FAIL (${failed.length}) — ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\nGATES: PASS')
