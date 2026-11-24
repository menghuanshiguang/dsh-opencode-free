// @ts-check
// dry_run（rehearsal）的判据：零请求的 run 里，只有该失败的那几条在失败。靠解析产物判，不靠 grep。
//
// 两种形状，断言同一套，不给任何一边放宽：
//   --shape archive（默认）档案形状：request.postCount / gates[] / verdict
//   --shape flat    rehearsal 的真实产物（gates.mjs 在 job 内、upload 之前拿不到 run/jobs/artifacts，
//                   造不出完整档案，所以它的形状是扁平的：postCount / retried / checks{} / passed）
// 默认形状不变：一份扁平产物不带 --shape flat 照样被拒。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXPECT_DEFAULT = '0.3,0.5,0.6,0.7,0.9'
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const SHAPE = String(arg('--shape', 'archive'))
if (!['archive', 'flat'].includes(SHAPE)) { console.error(`bad --shape ${SHAPE}`); process.exit(2) }

/** 同一组断言：postCount 是数字 0、没重试、失败集合恰好、且没说这一跑算过。 */
function judge(doc, expect, shape) {
  const fail = []
  if (!doc || typeof doc !== 'object') return ['产物不是对象']
  const postCount = shape === 'flat' ? doc.postCount : doc?.request?.postCount
  const retried = shape === 'flat' ? doc.retried : doc?.request?.retried
  if (shape === 'archive' && (!doc.request || typeof doc.request !== 'object')) {
    fail.push('缺 request 段——扁平产物要带 --shape flat，别拿它当档案证据')
  }
  if (postCount !== 0) fail.push(`postCount = ${JSON.stringify(postCount)}，rehearsal 必须是数字 0（不是字符串、不是别处的 0）`)
  if (retried !== false) fail.push(`retried = ${JSON.stringify(retried)}，rehearsal 不许重试`)

  let failing
  if (shape === 'flat') {
    const checks = doc.checks
    if (!checks || typeof checks !== 'object') return fail.concat('缺 checks 对象——没有逐条判定就没有「只有该失败的在失败」这句话')
    // `0.3-transport-bun` → 闸门 `0.3`；一门多条时任一失败即该门失败。
    failing = [...new Set(Object.entries(checks)
      .filter(([, value]) => value && typeof value === 'object' && value.pass === false)
      .map(([key]) => String(key).split('-')[0]))].sort()
  } else {
    const gates = Array.isArray(doc.gates) ? doc.gates : null
    if (!gates) return fail.concat('缺 gates 数组——没有逐条判定就没有「只有该失败的在失败」这句话')
    failing = gates.filter(g => g && g.pass !== true).map(g => String(g.id)).sort()
  }

  const wanted = [...expect].sort()
  if (failing.join(',') !== wanted.join(',')) fail.push(`失败的闸门是 [${failing.join(',')}]，应当是 [${wanted.join(',')}]`)

  const verdictPass = shape === 'flat' ? (doc.verdict?.pass ?? doc.passed) : doc?.verdict?.pass
  if (verdictPass !== false) fail.push('verdict.pass（扁平产物为 passed）必须是 false：零请求的 run 不许判过')
  return fail
}

const selfTest = argv.includes('--self-test')
const expect = String(arg('--expect', EXPECT_DEFAULT)).split(',').map(s => s.trim()).filter(Boolean)

if (!selfTest) {
  // 逐个跳过「旗标 + 它的值」，剩下的第一个位置参数才是产物路径。
  const takesValue = new Set(['--shape', '--expect'])
  let file
  for (let i = 0; i < argv.length; i++) {
    if (takesValue.has(argv[i])) { i++; continue }
    if (argv[i].startsWith('--')) continue
    file = argv[i]
    break
  }
  if (!file) { console.error('usage: check-rehearsal.mjs <gates.json> [--shape archive|flat] [--expect a,b,c] | --self-test'); process.exit(2) }
  const failures = judge(JSON.parse(readFileSync(file, 'utf8')), expect, SHAPE)
  for (const line of failures) console.log(`FAIL ${line}`)
  console.log(`REHEARSAL: ${failures.length === 0 ? 'PASS' : 'FAIL'} (shape=${SHAPE}; expected failing: ${expect.join(',')})`)
  process.exit(failures.length === 0 ? 0 : 1)
}

// ---- self-test：正例必须 PASS，每个负例必须各自 FAIL ----
const fixtureFile = join(import.meta.dirname, SHAPE === 'flat' ? 'fixtures/rehearsal/gates.flat.json' : 'fixtures/rehearsal/gates.json')
const base = JSON.parse(readFileSync(fixtureFile, 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'rehearsal-'))
const scratch = join(tmp, 'g.json')
const cases = []
const add = (id, why, mutate) => cases.push({ id, why, mutate })

if (SHAPE === 'flat') {
  const flip = (d, gate, pass) => { for (const k of Object.keys(d.checks)) if (k.startsWith(`${gate}-`)) d.checks[k].pass = pass }
  add('fixture-flat', '夹具本身必须 PASS（真的零请求产物）', d => d)
  add('postCount-one', '把 postCount 写成数字 1', d => { d.postCount = 1 })
  add('postCount-string', '把 postCount 写成字符串 "0"', d => { d.postCount = '0' })
  add('extra-failure', '多一条不该失败的闸门（0.8）', d => { flip(d, '0.8', false) })
  add('missing-failure', '少一条该失败的闸门（0.9 被写成通过）', d => { flip(d, '0.9', true) })
} else {
  add('fixture', '夹具本身必须 PASS', d => d)
  add('postCount-one', '把 postCount 写成数字 1', d => { d.request.postCount = 1 })
  add('postCount-string', '把 postCount 写成字符串 "0"', d => { d.request.postCount = '0' })
  add('extra-failure', '多一条不该失败的闸门（0.8）', d => { d.gates.find(g => g.id === '0.8').pass = false })
  add('missing-failure', '少一条该失败的闸门（0.9 被写成通过）', d => { d.gates.find(g => g.id === '0.9').pass = true })
  add('flat-product', '扁平产物不带 --shape flat（默认形状不许放宽）', () => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/rehearsal/gates.flat.json'), 'utf8')))
}

let bad = 0
for (const c of cases) {
  const input = structuredClone(base)
  const returned = c.mutate(input)
  const doc = returned === undefined ? input : returned
  writeFileSync(scratch, JSON.stringify(doc, null, 2))
  const wantPass = c.id.startsWith('fixture')
  const child = spawnSync(process.execPath, [import.meta.filename, scratch, '--shape', SHAPE, '--expect', EXPECT_DEFAULT], { encoding: 'utf8' })
  const gotPass = child.status === 0
  const ok = gotPass === wantPass
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(18)} ${c.why} → ${gotPass ? 'PASS' : 'FAIL'}`)
}
rmSync(tmp, { recursive: true, force: true })
console.log(`REHEARSAL-SELFTEST: ${bad === 0 ? 'PASS' : 'FAIL'} (shape=${SHAPE}; ${cases.length - 1} negative, 1 positive)`)
process.exit(bad === 0 ? 0 : 1)
