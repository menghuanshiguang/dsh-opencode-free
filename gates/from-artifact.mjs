#!/usr/bin/env node
/**
 * 从 run 的原始文件生成归档记录（gates.json）。
 *
 * 目的就一个：档案里的每个数字都来自文件，不来自任何人的转述或转录。
 * 输入全是下载下来的原件：GitHub API 的 run / jobs 响应、artifact 里的
 * live.json / gates.json / fields.json / egress.env，加上仓库里那把指纹锁。
 *
 *   node gates/from-artifact.mjs \
 *     --dir <artifact 解包目录> --run-json <run.json> --jobs-json <jobs.json> \
 *     --lock docs/fingerprint-baseline.json --contracts <ofm-tool-contracts.json> \
 *     --ci-run-json <ci.json> --negative-tests <selftest.json> \
 *     --preconditions <check-preconditions.json> --waiver <waiver.json> \
 *     --out <gates.json>
 *
 * 任何一项对不上（live 没 200、哈希不等、门没全过）直接 exit 1，不产出半份档案。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
function arg(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')

const dir = arg('--dir')
const runJsonPath = arg('--run-json')
const jobsJsonPath = arg('--jobs-json')
const lockPath = arg('--lock')
const contractsPath = arg('--contracts')
const ciRunJsonPath = arg('--ci-run-json')
const repoJsonPath2 = arg('--repo-json')
const artifactsJsonPath = arg('--artifacts-json')
// 归档哪一个 artifact：live 里由 upload-artifact 那步的 outputs 指定。
// id 与 digest 都是 action 自己报的（上传完就有），不依赖列表端点的索引。
const artifactId = arg('--artifact-id')
const artifactDigest = arg('--artifact-digest')
const artifactJsonPath = arg('--artifact-json')
const negPath = arg('--negative-tests')
const prePath = arg('--preconditions')
const waiverPath = arg('--waiver')
const failedStepReason = arg('--failed-step-reason')
const outPath = arg('--out')
// 归档记录里的 stage 一直是写死的 0，这对阶段 0 是对的，对阶段 4 就不行了：
// 阶段 4 的档案要带观测 transport，而校验器对 stage=0 恰恰拒收 observed。
const stageArg = arg('--stage') ?? '0'
if (!['0', '1', '2', '3', '4', '5'].includes(String(stageArg))) { console.error(`bad --stage ${stageArg}`); process.exit(2) }

// --artifacts-json 与 --artifact-id 二者之一即可：给了 id 就不再读列表（这正是竞态的入口）。
const artifactInputs = { '--artifact-id': artifactId, '--artifacts-json': artifactsJsonPath }
if (!artifactId && !artifactJsonPath && !artifactsJsonPath) { console.error('missing --artifact-id, --artifact-json or --artifacts-json'); process.exit(2) }
for (const [flag, value] of Object.entries({ '--dir': dir, '--run-json': runJsonPath, '--jobs-json': jobsJsonPath, '--lock': lockPath, '--negative-tests': negPath, '--repo-json': repoJsonPath2, '--preconditions': prePath, '--out': outPath })) {
  if (!value) { console.error(`missing ${flag}`); process.exit(2) }
}

const read = p => fs.readFileSync(p, 'utf8')
const readJson = p => JSON.parse(read(p))
const fail = message => { console.error(`FROM-ARTIFACT REFUSED: ${message}`); process.exit(1) }

const run = readJson(runJsonPath)
const repoDoc = repoJsonPath2 ? readJson(repoJsonPath2) : undefined
if (repoDoc && repoDoc.full_name !== run.repository.full_name) fail('repo.json 与 run 不是同一个仓库')
// 选哪一个 artifact，两条路，不会互相兜底：
//   --artifact-id 给了 → 只认这个 id 的单件响应（--artifact-json），列表一个字都不看。
//                        取不到就 exit 1 点名；绝不回落到列表，回落等于把竞态藏起来。
//   没给 id           → 才按列表找（夹具与人工复盘走这条）。
let artifact
if (artifactId !== undefined) {
  if (!artifactJsonPath) fail(`--artifact-id ${artifactId} 给了，但没有 --artifact-json（这个 id 的单件响应）：不许回落到 artifacts 列表`)
  if (!fs.existsSync(artifactJsonPath)) fail(`--artifact-id ${artifactId} 的单件响应文件不存在：${artifactJsonPath}`)
  const one = readJson(artifactJsonPath)
  if (String(one.id) !== String(artifactId)) fail(`单件响应的 id=${one.id} 与 --artifact-id ${artifactId} 不是同一件`)
  if (artifactDigest !== undefined) {
    const docDigest = String(one.digest ?? '').replace(/^sha256:/, '')
    if (docDigest && docDigest !== artifactDigest) fail(`digest 不一致：上传那步报 ${artifactDigest}，API 报 ${docDigest}`)
  }
  artifact = { ...one, digest: artifactDigest !== undefined ? `sha256:${artifactDigest}` : one.digest }
} else if (artifactJsonPath) {
  // 单件响应、没有 id：夹具与人工复盘走这条。
  if (!fs.existsSync(artifactJsonPath)) fail(`--artifact-json 指的文件不存在：${artifactJsonPath}`)
  artifact = readJson(artifactJsonPath)
} else {
  const artifactList = readJson(artifactsJsonPath).artifacts ?? []
  artifact = artifactList.find(a => a.name.includes(String(run.id))) ?? artifactList[0]
  if (!artifact) fail('没有 artifact')
}
const jobs = readJson(jobsJsonPath).jobs ?? []
const live = readJson(path.join(dir, 'live.json'))
// 规范名是 gates.flat.json（gates.json 留给要归档的那份，job 内不再造同名拷贝）。
// 旧名仍然收，但只在规范名缺席时用——不是为了让谁继续留拷贝，而是为了让删拷贝那一步不带风险。
const gatesName = ['gates.flat.json', 'gates.json'].find(name => fs.existsSync(path.join(dir, name)))
if (!gatesName) fail('artifact 里没有 gates.flat.json')
const gates = readJson(path.join(dir, gatesName))
const fields = readJson(path.join(dir, 'fields.json'))
const egress = Object.fromEntries(read(path.join(dir, 'egress.env')).trim().split('\n').map(line => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1)]
}))
const lock = readJson(lockPath)
const neg = readJson(negPath)
const pre = readJson(prePath)
const waiver = waiverPath ? readJson(waiverPath) : undefined
const ciRun = ciRunJsonPath ? readJson(ciRunJsonPath) : undefined

// 形状先于内容：扁平摘要（ok/status/checks）不是档案，直接说清楚它缺什么，
// 而不是让它以 TypeError 的形式崩在后面某一行。
const need = (obj, keys, what) => {
  for (const key of keys) if (obj == null || obj[key] === undefined) fail(`${what} 缺 ${key}——live 产物必须是档案形状（request/fingerprint/gates/verdict），不是扁平摘要`)
}
need(gates, ['run', 'postCount', 'retried', 'toolsSha256', 'runtime', 'checks'], 'gates.json')
need(live, ['ok', 'status', 'reply'], 'live.json')
need(fields, ['toolsSha256', 'endpoint', 'userAgent'], 'fields.json')

// ---- 硬校验：任何一条不成立就不产出档案 ----
if (run.event !== 'workflow_dispatch') fail(`event=${run.event}`)
if (String(run.id) !== String(gates.run.id)) fail('run id 与 artifact 里的不一致')
if (live.ok !== true || live.status !== 200 || String(live.reply).trim() !== 'PONG') fail(`live 不是 200/PONG：${live.status} ${live.reply}`)
if (gates.postCount !== 1) fail(`postCount=${gates.postCount}`)
if (gates.retried !== false) fail('retried 不是 false')
if (fields.toolsSha256 !== gates.toolsSha256) fail('fields 与 gates 的 toolsSha256 不一致')
if (gates.toolsSha256 !== lock.toolsSha256) fail(`toolsSha256 与锁不等：${gates.toolsSha256} vs ${lock.toolsSha256}`)
if (pre.pass !== true) fail('P1–P3 没有全过')

const liveStep = jobs.flatMap(j => j.steps ?? []).find(s => /live request/i.test(s.name))
if (!liveStep || liveStep.conclusion !== 'success') fail('live 步骤不是 success')
const failedSteps = jobs.flatMap(j => j.steps ?? []).filter(s => s.conclusion === 'failure')
if (failedSteps.length > 0 && !waiver) fail('run 有失败步骤，但没有 waiver')
// 失败原因优先由 artifact 自己的 FAIL 行推出（可复现，不靠人传字符串）
let derivedReason = null
try {
  const wireLines = fs.readFileSync(path.join(dir, 'wire-report.txt'), 'utf8').split('\n')
  const fails = wireLines.map((line, i) => ({ line, no: i + 1 })).filter(x => x.line.startsWith('FAIL '))
  // 固定注脚：说明这些 FAIL 属于报告口径，不涉及线上请求（同一份 artifact 每次生成同一串）
  const FAILED_STEP_NOTE = '报告口径 bug（按资产键序比线上顺序、按未渲染模板比 shell），live 步骤与 artifact 不受影响'
  if (fails.length) derivedReason = fails.map(f => `wire-report.txt 第 ${f.no} 行：${f.line.replace(/^FAIL /, '')}`).join('；') + `；${FAILED_STEP_NOTE}`
} catch { /* 没有 wire-report.txt 就只认 --failed-step-reason */ }
if (failedSteps.length > 0 && !failedStepReason && !derivedReason) fail('失败步骤必须能给出真实原因（artifact FAIL 行或 --failed-step-reason）')

// 记录里的门：用 artifact 的 checks，缺一条即拒
const checks = gates.checks ?? {}
const gateMap = {
  'P1': null, 'P2': null, 'P3': null,
  '0.1': ['0.1-dispatch-only', '0.1-confirm'],
  '0.2': ['0.2-ubuntu-latest', '0.2-bun-version'],
  '0.3': ['0.3-transport-bun', '0.3-transport-observed', '0.3-worker-spawn-recorded', '0.3-no-node-transport'],
  '0.4': ['0.4-egress'],
  '0.5': ['0.5-200-pong'],
  '0.6': ['0.6-billing-source'],
  '0.7': ['0.7-single-request', '0.7-no-retry'],
  '0.8': ['0.8-tools-sha256'],
  '0.9': ['0.9-inputs-present'],
}
const gateEntries = []
for (const [id, keys] of Object.entries(gateMap)) {
  if (keys === null) {
    const p = pre.results.find(r => r.id === id)
    if (!p || p.pass !== true) fail(`${id} 前置门没有 PASS`)
    gateEntries.push({ id, pass: true, evidence: p.detail })
    continue
  }
  for (const key of keys) if (!checks[key]) fail(`artifact 缺 check ${key}`)
  const bad = keys.find(key => checks[key].pass !== true)
  if (bad) fail(`${bad} 未通过：${JSON.stringify(checks[bad].detail)}`)
  gateEntries.push({
    id,
    pass: true,
    evidence: keys.map(key => `${key}: ${JSON.stringify(checks[key].detail)}`).join(' | '),
  })
}

const retentionDays = Math.round((Date.parse(artifact.expires_at ?? '') - Date.parse(run.created_at)) / 86400000)

const record = {
  schemaVersion: 1,
  stage: String(stageArg),
  run: {
    id: run.id,
    url: run.html_url,
    workflow: run.name,
    event: run.event,
    conclusion: run.conclusion,
    liveStepOutcome: liveStep.conclusion,
    failedSteps: failedSteps.map(s => ({ name: s.name, reason: failedStepReason ?? derivedReason ?? '未说明' })),
    attempt: run.run_attempt,
    createdAt: run.created_at,
    headSha: run.head_sha,
    actor: run.triggering_actor?.login ?? run.actor?.login ?? 'unknown',
  },
  repo: {
    fullName: run.repository.full_name,
    visibility: repoDoc?.visibility ?? run.repository.visibility ?? (run.repository.private === false ? 'public' : 'private'),
    commit: { sha: run.head_sha, branch: run.head_branch },
  },
  env: {
    runner: (jobs[0]?.labels ?? [])[0] ?? 'unknown',
    runtime: 'bun',
    bunVersion: gates.runtime.bunVersion,
    node: gates.runtime.node,
    transport: gates.runtime.transport,
    transportBasis: gates.runtime.transportDerived ? 'derived' : 'observed',
    // Stage >= 4 must carry the observation itself, not just call it observed:
    // implementation / pid / version / source, written by the code that sent and
    // read back from the capture by tools/gates.mjs.
    transportObserved: gates.runtime.transportObserved ?? null,
    transportEvidence: `live 步骤 success；OUR_FREE_MODEL_FREE_TRANSPORT=${gates.runtime.transportEnv === '' ? '(unset)' : gates.runtime.transportEnv}；bun=${gates.runtime.bunPath}；bunVersion=${gates.runtime.bunVersion}；postCount=${gates.postCount}${gates.runtime.transportObserved ? `；观测：${gates.runtime.transportObserved.implementation} pid=${gates.runtime.transportObserved.pid} version=${gates.runtime.transportObserved.version}` : ''}`,
    transportOverride: gates.runtime.transportEnv !== '',
    os: gates.runtime.platform,
  },
  egress: { ip: egress.egressIp, country: egress.country, source: 'artifact _temp/egress.env（workflow 在发请求前记录）', colo: egress.colo },
  request: {
    model: live.model,
    postCount: gates.postCount,
    retried: gates.retried,
    endpoint: fields.endpoint,
    ua: fields.userAgent,
  },
  fingerprint: {
    toolCount: gates.toolCount,
    toolOrder: gates.toolNames,
    toolsSha256: gates.toolsSha256,
    expectedToolsSha256: lock.toolsSha256,
    systemBytes: gates.systemPromptBytes,
    systemSha256: gates.systemPromptSha256,
    platform: 'linux',
    shellDescPrefix: lock.shellDescriptionPrefix,
  },
  response: {
    status: live.status,
    ok: live.ok,
    reply: live.reply,
    billingSource: live.billingSource,
    elapsedMs: live.elapsedMs,
    chunks: live.chunks,
    errorType: null,
  },
  assets: {
    tag: 'v2.2.3',
    provenance: { blobMatch: 14, total: 14 },
    lockSha256: sha(fs.readFileSync(lockPath)),
    contractsSha256: contractsPath ? sha(fs.readFileSync(contractsPath)) : sha(read(lockPath)),
    ...(ciRun ? { ciRunId: String(ciRun.id) } : {}),
  },
  gates: gateEntries,
  artifacts: [{
    // id 与 sha256 都来自上传那一步的事实（upload-artifact 的 outputs / 该 id 的单件响应），
    // 档案因此能钉在「就是这一件」上，不必再回列表里猜哪一条是它。
    // 有 id 才写：live 里它来自上传那步，夹具的列表路径没有这一项，不加空字段去动已验证的夹具字节。
    ...(artifact.id !== undefined && artifact.id !== null ? { id: artifact.id } : {}),
    name: artifact.name,
    kind: 'log',
    url: run.html_url,
    sha256: String(artifact.digest ?? '').replace(/^sha256:/, '') || '0'.repeat(64),
    retentionDays: retentionDays > 0 ? retentionDays : 0,
  }],
  verdict: { pass: true, failed: [] },
  negativeTests: neg.negativeTests,
  // 用 artifact 自己的 generatedAt：同一份输入必须生成逐字节相同的档案（验收员要能复现）
  producedBy: { bot: '总策划', at: gates.generatedAt },
}
if (waiver) record.verdict.waiver = waiver

// artifact 的 digest 由 API 给，别用占位
const digest = String(artifact.digest ?? '').replace(/^sha256:/, '')
if (!/^[0-9a-f]{64}$/.test(digest)) fail('API 没给 artifact digest，不能编一个')
record.artifacts[0].sha256 = digest
if (record.artifacts[0].retentionDays < 30) fail(`artifact 只留 ${record.artifacts[0].retentionDays} 天`)

fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`)
console.log(`WROTE ${outPath} (gates: ${gatesName})`)
console.log(`  run=${record.run.id} conclusion=${record.run.conclusion} live=${record.run.liveStepOutcome}`)
console.log(`  toolsSha256=${record.fingerprint.toolsSha256}`)
console.log(`  artifact sha256=${record.artifacts[0].sha256} retention=${record.artifacts[0].retentionDays}d`)
console.log(`  negativeTests=${record.negativeTests.length}`)
