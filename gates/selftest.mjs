#!/usr/bin/env node
/**
 * 反向测试：自己喂坏输入，看校验器会不会真的挡下来。
 *
 * 每条闸门都必须有一次这样的证据（督查 2026-11-24 的裁定）——没有反向测试的门，
 * 你不知道它是挡住了，还是根本没接线。典型反例：PyYAML 把裸 `on:` 读成布尔键，
 * 解析器拿到 `on=[]` 仍然判 OK，那种门会静默放行一切。
 *
 * 用法：
 *   node gates/selftest.mjs                 # 跑全部用例，输出可粘进 gates.json 的 negativeTests
 *   node gates/selftest.mjs --case <id>     # 单独跑一个用例（gates.json 里的 command 就是这个形状）
 *   node gates/selftest.mjs --json          # 只输出 JSON
 *
 * 判定：每个用例都必须让 gates/validate.mjs 以 exit 1 退出。本脚本自身 exit 0
 * 表示「这些门全都挡住了」；任何一条没挡住就 exit 1。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const validator = path.join(here, 'validate.mjs')
const base = path.join(here, 'fixtures', 'stage0.synthetic.json')
const repoRoot = path.resolve(here, '..')
const lock = path.join(repoRoot, 'docs', 'fingerprint-baseline.json')

const argv = process.argv.slice(2)
const onlyCase = (() => { const i = argv.indexOf('--case'); return i >= 0 ? argv[i + 1] : undefined })()
const asJson = argv.includes('--json')

const clone = () => JSON.parse(fs.readFileSync(base, 'utf8'))

const CASES = [
  {
    id: 'transport-basis-missing',
    gate: '0.3',
    case: 'transport 没有观测/推导依据（transportBasis 缺失）',
    mutate(d) { delete d.env.transportBasis },
  },
  {
    id: 'transport-node',
    gate: '0.3',
    case: '退回 node 传输（OUR_FREE_MODEL_FREE_TRANSPORT 被设置）',
    mutate(d) { d.env.transport = 'node'; d.env.transportOverride = true },
  },
  {
    id: 'bun-version-null',
    gate: '0.2',
    case: 'bunVersion 为空',
    mutate(d) { d.env.bunVersion = '' },
  },
  {
    id: 'post-twice',
    gate: '0.7',
    case: 'postCount=2（第二发没被拦）',
    mutate(d) { d.request.postCount = 2 },
  },
  {
    id: 'post-zero',
    gate: '0.3',
    case: '零请求（postCount=0）仍把 transport 记成 bun，0.3 靠推断通过',
    mutate(d) { d.request.postCount = 0 },
  },
  {
    id: 'reply-not-pong',
    gate: '0.5',
    case: '上游回复不是 PONG（把拒答当成功）',
    mutate(d) { d.response.reply = 'Free usage limit reached' },
  },
  {
    id: 'billing-empty',
    gate: '0.6',
    case: 'billingSource 为空（没有计费来源也判过）',
    mutate(d) { d.response.billingSource = '' },
  },
  {
    id: 'retried',
    gate: '0.7',
    case: 'retried=true',
    mutate(d) { d.request.retried = true },
  },
  {
    id: 'tools-hash-mismatch',
    gate: '0.8',
    case: 'live toolsSha256 与 CI 期望值不等',
    mutate(d) { d.fingerprint.expectedToolsSha256 = 'f'.repeat(64) },
  },
  {
    id: 'egress-missing',
    gate: '0.4',
    case: '出口国家缺失（日志没打 country 却判 0.4 过）',
    mutate(d) { delete d.egress.country },
  },
  {
    id: 'tool-order-swapped',
    gate: '0.8',
    case: '工具顺序换成资产键序（线上是字母序，键序只是取源顺序）',
    mutate(d) { const t = d.fingerprint.toolOrder; [t[0], t[1]] = [t[1], t[0]] },
  },
  {
    id: 'failure-no-waiver',
    gate: '0.1',
    case: 'job 红了却不签豁免（red run 直接当证据）',
    mutate(d) {
      d.run.conclusion = 'failure'
      d.run.failedSteps = [{ name: '13_report the wire capture', reason: 'reporter bug' }]
    },
  },
  {
    id: 'lock-tampered',
    gate: '0.8',
    case: '锁文件里改一个 hex（0.8 只认格式、不认锁就会放行）',
    mutate() {},
    extra(tmpDir) {
      const src = JSON.parse(fs.readFileSync(lock, 'utf8'))
      src.toolsSha256 = (src.toolsSha256[0] === '0' ? '1' : '0') + src.toolsSha256.slice(1)
      const badLock = path.join(tmpDir, 'lock-tampered.json')
      fs.writeFileSync(badLock, JSON.stringify(src, null, 2))
      return ['--lock', badLock]
    },
  },
  {
    id: 'missing-gate',
    gate: '0.8',
    case: '阶段 0 漏掉 0.8 这条闸门',
    mutate(d) { d.gates = d.gates.filter(g => g.id !== '0.8') },
  },
  {
    id: 'platform-ios',
    gate: '0.2',
    case: 'platform=ios（官方客户端不会发的平台串）',
    mutate(d) { d.fingerprint.platform = 'ios' },
  },
  {
    id: 'retention-short',
    gate: '0.9',
    case: 'artifact 只留 7 天',
    mutate(d) { d.artifacts[0].retentionDays = 7 },
  },
  {
    id: 'event-push',
    gate: '0.1',
    case: 'run 由 push 触发',
    mutate(d) { d.run.event = 'push' },
  },
  {
    id: 'commit-mismatch',
    gate: '0.1',
    case: 'repo.commit.sha 与 run.headSha 不一致（拿错 run 的日志）',
    mutate(d) { d.repo.commit.sha = 'f'.repeat(40) },
  },
  {
    id: 'negative-exitcode-zero',
    gate: '0.3',
    case: '反向测试自己写着 exitCode=0（门没挡住也算证据）',
    mutate(d) { d.negativeTests[0].exitCode = 0 },
  },
]

const BASE_PASSES = { gate: '0.1', case: '基线样例本身必须 exit 0（否则反向测试没有意义）' }

function runValidator(file, extra = []) {
  try {
    const out = execFileSync(process.execPath, [validator, file, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-selftest-'))
const results = []

// 0) 基线必须 PASS（带 --allow-synthetic），否则其余用例全无意义
const baseResult = runValidator(base, ['--allow-synthetic', '--lock', lock])
const baseOk = baseResult.code === 0
if (!baseOk) {
  results.push({ id: 'base', ok: false, detail: `基线样例本应 PASS，实际 exit ${baseResult.code}`, output: baseResult.out.trim().split('\n').slice(0, 5) })
}

// 1) 每个坏输入都必须被挡下
const cases = onlyCase ? CASES.filter(c => c.id === onlyCase) : CASES
if (onlyCase && cases.length === 0) {
  console.error(`unknown case: ${onlyCase}\nknown: ${CASES.map(c => c.id).join(', ')}`)
  process.exit(2)
}

for (const c of cases) {
  const doc = clone()
  c.mutate(doc)
  const file = path.join(tmpDir, `${c.id}.json`)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  // 合成样例需要 --allow-synthetic 才能走到后面的规则；这正是要测的规则本身。
  const allow = doc.synthetic === true ? ['--allow-synthetic'] : []
  if (typeof c.extra === 'function') allow.push(...c.extra(tmpDir))
  const r = runValidator(file, allow)
  const blocked = r.code === 1
  results.push({
    id: c.id,
    gate: c.gate,
    case: c.case,
    command: `node gates/selftest.mjs --case ${c.id}`,
    exitCode: r.code,
    ok: blocked,
    detail: blocked ? 'BLOCKED (exit 1)' : `NOT BLOCKED (exit ${r.code})`,
    output: r.out.trim().split('\n').slice(0, 3),
  })
}

// 2) 外部判定器（P1–P3）的反向用例：输入是文件，必须真的让 check-preconditions 退出 1
const checker = path.join(here, 'check-preconditions.mjs')

function runChecker(args) {
  try {
    const out = execFileSync(process.execPath, [checker, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const EXT_CASES = [
  {
    id: 'p1-fake-license',
    gate: 'P1',
    case: '许可证没有 Ebony-Vinyl 原版权行',
    build(dir) {
      const file = path.join(dir, 'LICENSE.bad')
      fs.writeFileSync(file, 'MIT License\n\nCopyright (c) 2026 Someone Else\n')
      return ['--license', file]
    },
  },
  {
    id: 'p2-private-repo',
    gate: 'P2',
    case: 'API 返回 private:true（拿私库冒充公开）',
    build(dir) {
      const file = path.join(dir, 'repo.bad.json')
      fs.writeFileSync(file, JSON.stringify({ private: true, visibility: 'private' }))
      return ['--repo-json', file]
    },
  },
  {
    id: 'p3-token-in-history',
    gate: 'P3',
    case: '历史里出现 token 形态（grep 数不该放过）',
    build(dir) {
      const file = path.join(dir, 'log.bad.txt')
      // 运行时拼出来，不把任何真 token 形态落进仓库
      fs.writeFileSync(file, `commit abc\n+const token = 'ghp_${'A'.repeat(36)}'\n`)
      return ['--git-log', file]
    },
  },
]

for (const c of (onlyCase ? EXT_CASES.filter(x => x.id === onlyCase) : EXT_CASES)) {
  const args = c.build(tmpDir)
  const r = runChecker(args)
  results.push({
    id: c.id,
    gate: c.gate,
    case: c.case,
    command: `node gates/selftest.mjs --case ${c.id}`,
    exitCode: r.code,
    ok: r.code === 1,
    detail: r.code === 1 ? 'BLOCKED (exit 1)' : `NOT BLOCKED (exit ${r.code})`,
    output: r.out.trim().split('\n').slice(0, 3),
  })
}

const payload = {
  base: { exitCode: baseResult.code, ok: baseOk },
  cases: results,
  negativeTests: results.filter(r => r.ok).map(r => ({ gate: r.gate, case: r.case, command: r.command, exitCode: r.exitCode })),
}
const allOk = baseOk && results.every(r => r.ok)

if (asJson) {
  console.log(JSON.stringify({ ...payload, allOk }, null, 2))
} else {
  console.log(`base: ${baseOk ? 'PASS (exit 0)' : `FAIL (exit ${baseResult.code})`}`)
  for (const r of results) console.log(`${r.ok ? 'BLOCKED ' : 'NOT-BLOCKED'} ${String(r.gate ?? '-').padEnd(3)} ${r.id.padEnd(20)} ${r.case ?? r.detail}`)
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} 个坏输入被挡下；整体 ${allOk ? 'OK' : 'FAIL'}`)
  console.log(`\n可直接粘进 gates.json 的 negativeTests：`)
  console.log(JSON.stringify(payload.negativeTests, null, 2))
}

fs.rmSync(tmpDir, { recursive: true, force: true })
process.exit(allOk ? 0 : 1)
