#!/usr/bin/env node
/**
 * gates.json 校验器 —— 零依赖，只用 node 内置模块。
 *
 * 它不是「schema 的近似」：每条规则都对应 gates/gates.schema.json 里的一个字段，
 * 另外加了一组 schema 表达不了的跨字段不变量（工具哈希闭环、run id 与 URL 一致、
 * platform 与 shell 描述一致、artifact 挂在同一个 run 上）。任何一条不过就是 exit 1。
 *
 * 用法：
 *   node gates/validate.mjs <gates.json> [--stage 0] [--allow-synthetic]
 *   node gates/validate.mjs <gates.json> --stage 0 --json
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const file = argv.find(a => !a.startsWith('--'))
const wantStage = (() => {
  const i = argv.indexOf('--stage')
  return i >= 0 ? argv[i + 1] : undefined
})()
const allowSynthetic = argv.includes('--allow-synthetic')
const requireCoverage = argv.includes('--require-negative-coverage')
const asJson = argv.includes('--json')
const lockFile = (() => {
  const i = argv.indexOf('--lock')
  return i >= 0 ? argv[i + 1] : undefined
})()

const TOOL_ORDER = [
  'read', 'shell', 'edit', 'glob', 'grep', 'write', 'patch',
  'webfetch', 'websearch', 'question', 'skill', 'subagent', 'todowrite',
]
const STAGE0_GATES = new Set([
  'P1', 'P2', 'P3',
  '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9',
])

if (!file) {
  console.error('usage: node gates/validate.mjs <gates.json> [--stage 0] [--allow-synthetic] [--json]')
  process.exit(2)
}

const errors = []
function fail(path, message) { errors.push(`${path}: ${message}`) }
function check(path, cond, message) { if (!cond) fail(path, message) }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function hex(v, n) { return typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v) }
function int(v, min = 0) { return Number.isInteger(v) && v >= min }
function str(v) { return typeof v === 'string' && v.length > 0 }

const raw = fs.readFileSync(file, 'utf8')
const sha = crypto.createHash('sha256').update(raw).digest('hex')
let doc
try {
  doc = JSON.parse(raw)
} catch (error) {
  console.error(`FATAL ${file}: 不是合法 JSON（${error.message}）`)
  process.exit(1)
}
check('.', isObject(doc), '顶层必须是对象')

// ---- 顶层 ----
check('schemaVersion', doc.schemaVersion === 1, '必须是 1')
const stage = doc.stage
check('stage', ['0', '1', '2', '3', '4', '5'].includes(stage), `stage 非法：${JSON.stringify(stage)}`)
if (wantStage !== undefined) check('stage', String(stage) === String(wantStage), `期望 stage=${wantStage}，实际 ${stage}`)
check('synthetic', doc.synthetic === undefined || typeof doc.synthetic === 'boolean', '必须是布尔')
if (doc.synthetic === true && !allowSynthetic) {
  fail('synthetic', '这是合成样例（synthetic=true），归档器与阶段判定一律不接受；演示请加 --allow-synthetic')
}

// ---- run ----
const run = doc.run ?? {}
check('run', isObject(doc.run), '缺失')
check('run.id', int(run.id, 1), '必须是正整数')
check('run.url', typeof run.url === 'string' && run.url.startsWith('https://github.com/') && run.url.includes('/actions/runs/'), '必须是 Actions run URL')
if (str(run.url) && int(run.id, 1)) {
  check('run.url', run.url.endsWith(`/runs/${run.id}`), `URL 与 run.id=${run.id} 不一致`)
}
check('run.workflow', str(run.workflow), '必须非空')
check('run.event', run.event === 'workflow_dispatch', '只接受 workflow_dispatch')
check('run.conclusion', run.conclusion === 'success', '必须是 success')
check('run.attempt', int(run.attempt, 1), '必须是 ≥1 的整数')
check('run.createdAt', typeof run.createdAt === 'string' && !Number.isNaN(Date.parse(run.createdAt)), '必须是 ISO 时间')
check('run.headSha', hex(run.headSha, 40), '必须是小写 40 位 hex')

// ---- repo ----
const repo = doc.repo ?? {}
check('repo', isObject(doc.repo), '缺失')
check('repo.visibility', repo.visibility === 'public', '必须是 public')
check('repo.fullName', typeof repo.fullName === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.fullName ?? ''), '必须是 owner/name')
const commit = repo.commit ?? {}
check('repo.commit.sha', hex(commit.sha, 40), '必须是小写 40 位 hex')
check('repo.commit.sha', commit.sha === run.headSha, `与 run.headSha 不一致（repo ${commit.sha} vs run ${run.headSha}）`)
check('repo.commit.branch', str(commit.branch), '必须非空')

// ---- env（生产传输硬门）----
const env = doc.env ?? {}
check('env', isObject(doc.env), '缺失')
check('env.runner', env.runner === 'ubuntu-latest', '只接受 ubuntu-latest')
check('env.runtime', env.runtime === 'bun', '必须是 bun')
check('env.bunVersion', typeof env.bunVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+/.test(env.bunVersion ?? ''), '必须是 semver 开头')
check('env.transport', env.transport === 'bun', '生产证据必须是 bun 传输；node 只算诊断')
check('env.transportOverride', env.transportOverride === false, 'OUR_FREE_MODEL_FREE_TRANSPORT 被设置过 → 不是生产路径')
check('env.transportBasis', ['observed', 'derived'].includes(env.transportBasis), 'transportBasis 只能是 observed 或 derived')
check('env.transportBasis', !(env.transportBasis === 'derived' && !((doc.request?.postCount ?? 0) >= 1)), 'derived 的依据要求 postCount>=1：零请求的 run 推不出 Bun')
check('env.transportEvidence', str(env.transportEvidence), '必须给出证明实际传输路径的日志定位')

// ---- egress ----
const egress = doc.egress ?? {}
check('egress', isObject(doc.egress), '缺失')
check('egress.ip', str(egress.ip) && egress.ip.length >= 3, '必须非空')
check('egress.country', typeof egress.country === 'string' && /^[A-Z]{2}$/.test(egress.country ?? ''), '必须是两位国家码')
check('egress.source', str(egress.source), '必须写明来源（哪个服务返回的）')

// ---- request ----
const request = doc.request ?? {}
check('request', isObject(doc.request), '缺失')
check('request.model', str(request.model), '必须非空')
check('request.modelsFreeCount', int(request.modelsFreeCount, 1), '必须 ≥1')
check('request.postCount', request.postCount === 1, '单发纪律：必须恰为 1')
check('request.retried', request.retried === false, '必须为 false')
check('request.endpoint', request.endpoint === '/inference/openai/v1/chat/completions', '端点必须是 /inference/openai/v1/chat/completions')
check('request.ua', request.ua === 'opencode/latest/2.2.3/cli', 'UA 必须是 opencode/latest/2.2.3/cli')

// ---- fingerprint（哈希闭环）----
const fp = doc.fingerprint ?? {}
check('fingerprint', isObject(doc.fingerprint), '缺失')
check('fingerprint.toolCount', fp.toolCount === 13, '必须是 13')
check('fingerprint.toolOrder', Array.isArray(fp.toolOrder) && fp.toolOrder.length === 13 && fp.toolOrder.every((n, i) => n === TOOL_ORDER[i]), `顺序必须逐位等于 ${TOOL_ORDER.join(' ')}`)
check('fingerprint.toolsSha256', hex(fp.toolsSha256, 64), '必须是小写 64 位 hex')
check('fingerprint.expectedToolsSha256', hex(fp.expectedToolsSha256, 64), '必须是小写 64 位 hex')
check('fingerprint.toolsSha256', fp.toolsSha256 === fp.expectedToolsSha256, 'live 打印的 toolsSha256 与 CI 期望值不等 → 指纹环没闭合')
check('fingerprint.systemBytes', int(fp.systemBytes, 1), '必须 ≥1')
check('fingerprint.systemSha256', hex(fp.systemSha256, 64), '必须是小写 64 位 hex')
check('fingerprint.platform', ['linux', 'darwin', 'win32'].includes(fp.platform), '只能是官方三平台之一')
check('fingerprint.platform', fp.platform === 'linux', 'runner 上必须是 linux（darwin/win32 只用于历史 run 的对账）')
check('fingerprint.shellDescPrefix', fp.shellDescPrefix === 'Commands run on Linux using bash.', 'platform=linux 时 shell 描述前缀必须是 "Commands run on Linux using bash."')

// ---- 锁：docs/fingerprint-baseline.json（可选，但 CI 归档时必须给）----
if (lockFile) {
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  } catch (error) {
    fail('lock', `读不了锁文件：${error.message}`)
  }
  if (lock) {
    check('lock.toolsSha256', lock.toolsSha256 === fp.toolsSha256, `锁里的 toolsSha256=${lock.toolsSha256} 与 live 的 ${fp.toolsSha256} 不等`)
    check('lock.toolsSha256', lock.toolsSha256 === fp.expectedToolsSha256, '锁值与 expectedToolsSha256 不等（传递相等的链断了）')
    check('lock.toolCount', lock.toolCount === fp.toolCount, `锁里 toolCount=${lock.toolCount}`)
    check('lock.platform', lock.platform === fp.platform, `锁里 platform=${lock.platform}`)
    check('lock.shellDescriptionPrefix', lock.shellDescriptionPrefix === fp.shellDescPrefix, '锁里 shell 描述前缀与记录不同')
    check('lock.userAgent', lock.userAgent === request.ua, `锁里 UA=${lock.userAgent}`)
    check('lock.endpoint', lock.endpoint === request.endpoint, `锁里 endpoint=${lock.endpoint}`)
    check('lock.model', lock.model === request.model, `锁里 model=${lock.model}`)
  }
}

// ---- response ----
const response = doc.response ?? {}
check('response', isObject(doc.response), '缺失')
check('response.status', response.status === 200, '必须是 200')
check('response.ok', response.ok === true, '必须是 true')
check('response.reply', response.reply === 'PONG', '必须恰为 PONG')
check('response.billingSource', str(response.billingSource), '必须非空')
check('response.elapsedMs', typeof response.elapsedMs === 'number' && response.elapsedMs > 0, '必须 >0')
if (response.errorType !== undefined) check('response.errorType', response.errorType === null, '200 时必须是 null')

// ---- assets（逐字节来源）----
const assets = doc.assets ?? {}
check('assets', isObject(doc.assets), '缺失')
check('assets.tag', assets.tag === 'v2.2.3', '必须锁 v2.2.3')
const prov = assets.provenance ?? {}
check('assets.provenance.blobMatch', prov.blobMatch === 14, '必须是 14')
check('assets.provenance.total', prov.total === 14, '必须是 14')
check('assets.lockSha256', hex(assets.lockSha256, 64), '必须是小写 64 位 hex')
check('assets.contractsSha256', hex(assets.contractsSha256, 64), '必须是小写 64 位 hex')

// ---- gates ----
const gates = doc.gates
check('gates', Array.isArray(gates), '缺失')
if (Array.isArray(gates)) {
  check('gates', gates.length >= 4, '至少 4 条（阶段 0 是 P1–P3 + 0.1–0.9）')
  const ids = new Set()
  gates.forEach((g, i) => {
    const at = `gates[${i}]`
    check(at, isObject(g), '必须是对象')
    check(`${at}.id`, typeof g.id === 'string' && /^(P[1-3]|[0-5]\.[0-9]+)$/.test(g.id), `id 非法：${JSON.stringify(g.id)}`)
    check(`${at}.pass`, g.pass === true, '未通过的条目不许归档')
    check(`${at}.evidence`, str(g.evidence), '必须写证据（命令/日志定位）')
    if (ids.has(g.id)) fail(`${at}.id`, `重复：${g.id}`)
    ids.add(g.id)
  })
  if (String(stage) === '0') {
    for (const id of STAGE0_GATES) check('gates', ids.has(id), `阶段 0 缺条目 ${id}`)
    for (const id of ids) check('gates', STAGE0_GATES.has(id), `阶段 0 多出条目 ${id}`)
  } else {
    for (const id of ids) check('gates', id.startsWith(`${stage}.`), `stage ${stage} 里出现 ${id}，前缀不符`)
  }
}

// ---- artifacts ----
const artifacts = doc.artifacts
check('artifacts', Array.isArray(artifacts), '缺失')
if (Array.isArray(artifacts)) {
  check('artifacts', artifacts.length >= 1, '至少一个')
  artifacts.forEach((a, i) => {
    const at = `artifacts[${i}]`
    check(at, isObject(a), '必须是对象')
    check(`${at}.name`, str(a.name), '必须非空')
    check(`${at}.kind`, ['log', 'artifact'].includes(a.kind), '必须是 log 或 artifact')
    check(`${at}.url`, str(a.url), '必须非空')
    if (str(a.url) && str(run.url)) check(`${at}.url`, a.url.includes(`/runs/${run.id}`), `必须挂在 run ${run.id} 上`)
    check(`${at}.sha256`, hex(a.sha256, 64), '必须是小写 64 位 hex')
    check(`${at}.retentionDays`, int(a.retentionDays, 30), '留存必须 ≥30 天')
  })
  check('artifacts', artifacts.some(a => a?.kind === 'log'), '至少一个 kind=log（原始日志）')
}

// ---- verdict ----
const verdict = doc.verdict ?? {}
check('verdict', isObject(doc.verdict), '缺失')
check('verdict.pass', verdict.pass === true, '必须是 true（未通过不许归档）')
check('verdict.failed', Array.isArray(verdict.failed) && verdict.failed.length === 0, '必须为空数组')

// ---- negativeTests（每条闸门都要有一次反向证据）----
const negTests = doc.negativeTests
check('negativeTests', Array.isArray(negTests), '缺失')
if (Array.isArray(negTests)) {
  check('negativeTests', negTests.length >= 3, '至少 3 条')
  const seen = new Map()
  negTests.forEach((t, i) => {
    const at = `negativeTests[${i}]`
    check(at, isObject(t), '必须是对象')
    check(`${at}.gate`, typeof t.gate === 'string' && /^(P[1-3]|[0-5]\.[0-9]+)$/.test(t.gate), `gate 非法：${JSON.stringify(t.gate)}`)
    check(`${at}.case`, str(t.case), '必须写清喂了什么坏输入')
    check(`${at}.command`, str(t.command), '必须给可复跑命令')
    check(`${at}.exitCode`, t.exitCode === 1, '反向测试必须 exit 1（门得真的挡住）')
    if (!seen.has(t.gate)) seen.set(t.gate, [])
    seen.get(t.gate).push(t.case)
  })
  if (requireCoverage && Array.isArray(gates)) {
    for (const g of gates) {
      if (!seen.has(g.id)) fail('negativeTests', `闸门 ${g.id} 没有反向测试证据（拿不出就按未建成处理）`)
    }
    for (const id of seen.keys()) {
      check('negativeTests', gates.some(g => g.id === id), `反向测试指向了不存在的闸门 ${id}`)
    }
  }
}

// ---- producedBy ----
const producedBy = doc.producedBy ?? {}
check('producedBy', isObject(doc.producedBy), '缺失')
check('producedBy.bot', str(producedBy.bot), '必须非空')
check('producedBy.at', typeof producedBy.at === 'string' && !Number.isNaN(Date.parse(producedBy.at)), '必须是 ISO 时间')
if (str(run.createdAt) && str(producedBy.at)) {
  check('producedBy.at', Date.parse(producedBy.at) >= Date.parse(run.createdAt), '归档时间早于 run 创建时间')
}

const summary = {
  file,
  sha256: sha,
  stage: String(stage),
  runId: run.id ?? null,
  model: request.model ?? null,
  toolsSha256: fp.toolsSha256 ?? null,
  synthetic: doc.synthetic === true,
  errors: errors.length,
  pass: errors.length === 0,
}

if (asJson) {
  console.log(JSON.stringify({ ...summary, messages: errors }, null, 2))
} else if (errors.length === 0) {
  console.log(`PASS stage=${summary.stage} run=${summary.runId} model=${summary.model}`)
  console.log(`     toolsSha256=${summary.toolsSha256}`)
  console.log(`     fileSha256=${summary.sha256}`)
} else {
  console.log(`FAIL ${errors.length} 条：`)
  for (const e of errors) console.log(`  - ${e}`)
}
process.exit(errors.length === 0 ? 0 : 1)
