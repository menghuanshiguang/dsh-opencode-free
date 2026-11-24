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

// 线上顺序 = V2_OFFICIAL_TOOL_ORDER（字母序）。资产 JSON 的键序是取源顺序，不参与线上字节判断。
const TOOL_ORDER = [
  'edit', 'glob', 'grep', 'patch', 'question', 'read', 'shell',
  'skill', 'subagent', 'todowrite', 'webfetch', 'websearch', 'write',
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

// 闸门缺参不许降级（2026-11-24 规矩）：stage 0 与 stage 4 的核心判据就是指纹与锁的比对，
// 不带 --lock 时那段整块不会执行、退出码还是 0——那等于把判据静默关掉。这两个 stage 缺锁即 exit 2。
const LOCK_REQUIRED = new Set(['0', '4'])
if (LOCK_REQUIRED.has(String(stage)) && !lockFile) {
  console.error(`validate: stage ${stage} 必须带 --lock <docs/fingerprint-baseline.json>；不带锁时 0.8 的锁比对与传递相等链不会执行，不能算验过`)
  process.exit(2)
}
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
// 自归档：归档跑在自己这条 run 里，那一刻 conclusion 必然是 null（run 没结束）。
// 所以 stage 4 允许 null，但只在「status 还没到终态、且 live 步骤成功」时——
// 放宽必须带这三条一起，否则任何人都能拿一份没有结论的档案过关。
// stage 0 不受影响：那里的档案是在 run 结束后产出的，结论必须是真值。
const TERMINAL_STATUSES = ['completed']
const RUNNING_STATUSES = ['queued', 'in_progress', 'requested', 'waiting', 'pending']
const selfArchived = run.conclusion === null
  && RUNNING_STATUSES.includes(run.status)
  && run.liveStepOutcome === 'success'
const conclusionOk = ['success', 'failure'].includes(run.conclusion)
  || (String(stage) === '4' && selfArchived)
check('run.conclusion', conclusionOk, selfArchived && String(stage) === '4'
  ? '只能是 success 或 failure'
  : `只能是 success 或 failure；stage 4 自归档时可为 null，但要求 status ∈ {${RUNNING_STATUSES.join(',')}}（实际 ${JSON.stringify(run.status)}）且 live 步骤成功`)
check('run.status', !TERMINAL_STATUSES.includes(run.status) || run.conclusion !== null || String(stage) !== '4',
  `status=completed 却没有结论：这不是自归档，是缺结论，必须红色`)
check('run.liveStepOutcome', run.liveStepOutcome === 'success', 'live 步骤本身必须成功（0.5/0.6/0.7 的证据来源）')
// 同上：run 未终态时，失败步还没发生，空数组是假账。stage 4 自归档时允许 null。
const failedStepsOk = Array.isArray(run.failedSteps)
  || (String(stage) === '4' && run.failedSteps === null && selfArchived)
check('run.failedSteps', failedStepsOk, '必须是数组（成功时为空）；stage 4 自归档时可为 null——失败步那时还没发生')
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

// 0.3 的口径（督查 2026-11-24 裁定）：transport 只能从 capture 里读观测行，不能从环境推断。
// 阶段 0 那次是推断，历史就留在 derived 上——把它改成 observed 等于改写历史；
// 阶段 4 起，判据要求发包那层代码自己写出「谁发的包」。
if (String(stage) === '0') {
  check('env.transportBasis', env.transportBasis !== 'observed',
    '阶段 0 的 transport 只能记 derived：它是从「装了 bun + 未设退还开关 + postCount=1」推出来的，改成 observed 就是改写历史；transport=bun 这条证据由阶段 4 的观测 run 承担')
} else if (Number(stage) >= 4) {
  const observed = env.transportObserved
  check('env.transportBasis', env.transportBasis === 'observed',
    '阶段 4 起 transport 必须是观测值：由真正发包的代码写进 capture，再从 capture 读进档案')
  check('env.transportObserved', isObject(observed), '缺少 transportObserved：implementation / pid / version / source 必须由发包代码写出，不许从环境推断')
  if (isObject(observed)) {
    check('env.transportObserved.implementation', ['bun-worker', 'node-fetch'].includes(observed.implementation),
      `implementation 只能是 bun-worker 或 node-fetch，实际 ${JSON.stringify(observed.implementation)}`)
    check('env.transportObserved.pid', int(observed.pid, 1), 'pid 必须是真实子进程 id（正整数）')
    check('env.transportObserved.version', str(observed.version), 'version 不能为空')
    check('env.transportObserved.source', str(observed.source), 'source 必须写明这行观测值出自哪份 capture')
    if (env.transport === 'bun') {
      check('env.transportObserved.implementation', observed.implementation === 'bun-worker',
        'env.transport=bun 但观测行说不是 bun worker 发的包——观测值与声称值矛盾，以观测为准')
    }
  }
}

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
if (assets.ciRunId !== undefined) check('assets.ciRunId', str(assets.ciRunId), '给了就必须非空')

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
    // 阶段 4 复用的就是 0.1–0.9 这一族检查（同一条判据、同一个名字），所以它带 0.x 是
    // 语义正确，不是串了阶段；阶段 1–3 没有自己的检查族，仍按前缀判。
    if (Number(stage) === 4) {
      for (const id of ids) check('gates', /^(P[1-3]|0\.[0-9]+)$/.test(id), `stage 4 里出现 ${id}：只允许 P1–P3 与 0.1–0.9（阶段 4 复用这一族检查）`)
    } else {
      for (const id of ids) check('gates', id.startsWith(`${stage}.`), `stage ${stage} 里出现 ${id}，前缀不符`)
    }
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

// 「这份档案绑的是哪一件」——阶段 4 起必须能回答（2026-11-24 封存档案绑错对象的洞）。
// 上一版只查 artifacts[0] 的字段齐备：封存那份绑的是 archive-<runid>（run 自己那个 zip），
// 字段一个不缺，rc 还是 0。判据落在两件能各自独立复核的事上：
//   1) 名字必须逐字等于 live-<run.id>：同一条 run 的 zip 都叫 archive-<runid>，只认 live 那一件；
//   2) 必须有 id：没有 id 就说明它是按列表顺序挑出来的（挑哪一件都是猜），不是按上传那步
//      报出的 id 取的。id 与 upload 上报值的一致性由 gates/from-artifact.mjs 在生产那一步硬判
//      （单件响应的 id ≠ --artifact-id 直接拒），这里判的是「档案自己有没有把 id 钉下来」。
// 阶段 0 不追写：那两份历史档案没有 id 字段，改判据不许倒回去改已归档的记录。
if (Number(stage) >= 4 && Array.isArray(artifacts)) {
  const named = artifacts[0] ?? {}
  check('artifacts[0].id', int(named.id, 1), '阶段 4 起必须写 artifact 的 id（正整数）：没有 id 的档案是按列表顺序挑出来的，绑在哪一件上都不可核')
  if (int(run.id, 1)) {
    check('artifacts[0].name', named.name === `live-${run.id}`,
      `必须逐字等于 live-${run.id}（实际 ${JSON.stringify(named.name)}）：档案绑的必须是这一条 run 的 live 产物，不是它的封存 zip，也不是列表里的第 0 个`)
  }
}

// ---- verdict ----
const verdict = doc.verdict ?? {}
check('verdict', isObject(doc.verdict), '缺失')
check('verdict.pass', verdict.pass === true, '必须是 true（未通过不许归档）')
check('verdict.failed', Array.isArray(verdict.failed) && verdict.failed.length === 0, '必须为空数组')

// ---- run 结论与豁免（失败 run 必须由 admin 签字）----
if (isObject(run)) {
  const failedSteps = Array.isArray(run.failedSteps) ? run.failedSteps : []
  failedSteps.forEach((f, i) => {
    check(`run.failedSteps[${i}]`, isObject(f) && str(f.name) && str(f.reason), '每一格都要有 name 与 reason')
  })
  if (run.conclusion === 'success') {
    check('run.failedSteps', failedSteps.length === 0, '结论 success 时不许有失败步骤')
    check('verdict.waiver', (doc.verdict ?? {}).waiver === undefined, 'success 的 run 不需要豁免')
  }
  if (run.conclusion === 'failure') {
    check('run.failedSteps', failedSteps.length >= 1, '失败 run 必须写清哪一步红了')
    const waived = (doc.verdict ?? {}).waiver
    check('verdict.waiver', isObject(waived), '失败 run 必须由 admin 签字豁免（approvedBy + reason + at）')
    if (isObject(waived)) {
      check('verdict.waiver.approvedBy', str(waived.approvedBy), '必须写明谁签的')
      check('verdict.waiver.reason', str(waived.reason), '必须写豁免理由')
      check('verdict.waiver.at', typeof waived.at === 'string' && !Number.isNaN(Date.parse(waived.at)), '必须是 ISO 时间')
    }
  }
}

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
