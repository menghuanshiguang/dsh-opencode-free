// @ts-check
// dry_run（rehearsal）的判据：零请求的 run 里，只有该失败的那几条在失败，而且这件事要靠解析产物来断，
// 不靠 grep 字符串。产物形状换成档案形状之后，`grep '"postCount": 0'` 既不区分别处的 0，也可能匹配不到。
//
// 用法：
//   node gates/check-rehearsal.mjs <gates.json> [--expect 0.3,0.5,0.6,0.7,0.9]
//   node gates/check-rehearsal.mjs --self-test        （用夹具 + 三个变异体，证明它会红）
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

/** @param {any} doc @param {string[]} expect @returns {string[]} */
function judge(doc, expect) {
  const fail = []
  if (!doc || typeof doc !== 'object') return ['产物不是对象']
  const req = doc.request
  if (!req || typeof req !== 'object') fail.push('缺 request 段——扁平产物不能当作 rehearsal 证据')
  else {
    if (req.postCount !== 0) fail.push(`request.postCount = ${JSON.stringify(req.postCount)}，rehearsal 必须是数字 0（不是字符串、不是别处的 0）`)
    if (req.retried !== false) fail.push(`request.retried = ${JSON.stringify(req.retried)}，rehearsal 不许重试`)
  }
  const gates = Array.isArray(doc.gates) ? doc.gates : null
  if (!gates) return fail.concat('缺 gates 数组——没有逐条判定就没有「只有该失败的在失败」这句话')
  const failing = gates.filter(g => g && g.pass !== true).map(g => String(g.id)).sort()
  const wanted = [...expect].sort()
  if (failing.join(',') !== wanted.join(',')) {
    fail.push(`失败的闸门是 [${failing.join(',')}]，应当是 [${wanted.join(',')}]`)
  }
  if (!doc.verdict || doc.verdict.pass !== false) fail.push('verdict.pass 必须是 false：零请求的 run 不许判过')
  return fail
}

const selfTest = argv.includes('--self-test')

if (!selfTest) {
  const file = argv.find(a => !a.startsWith('--') && a !== arg('--expect', undefined))
  if (!file) { console.error('usage: check-rehearsal.mjs <gates.json> [--expect a,b,c] | --self-test'); process.exit(2) }
  const expect = String(arg('--expect', EXPECT_DEFAULT)).split(',').map(s => s.trim()).filter(Boolean)
  const failures = judge(JSON.parse(readFileSync(file, 'utf8')), expect)
  for (const line of failures) console.log(`FAIL ${line}`)
  console.log(`REHEARSAL: ${failures.length === 0 ? 'PASS' : 'FAIL'} (expected failing: ${expect.join(',')})`)
  process.exit(failures.length === 0 ? 0 : 1)
}

// ---- self-test：夹具必须 PASS，三个变异体必须各自 FAIL ----
const fixture = join(import.meta.dirname, 'fixtures/rehearsal/gates.json')
const expected = EXPECT_DEFAULT.split(',')
const base = JSON.parse(readFileSync(fixture, 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'rehearsal-'))
const scratch = join(tmp, 'g.json')
writeFileSync(scratch, JSON.stringify(base, null, 2))

const cases = []
const add = (id, why, mutate) => cases.push({ id, why, mutate })
add('fixture', '夹具本身必须 PASS（否则反向测试没有意义）', d => d)
add('postCount-one', '把 postCount 写成数字 1', d => { d.request.postCount = 1 })
add('postCount-string', '把 postCount 写成字符串 "0"（文本匹配会放过的形态）', d => { d.request.postCount = '0' })
add('extra-failure', '多一条不该失败的闸门（0.8）', d => { d.gates.find(g => g.id === '0.8').pass = false })
add('missing-failure', '少一条该失败的闸门（0.9 被写成通过）', d => { d.gates.find(g => g.id === '0.9').pass = true })
add('flat-product', '扁平产物（缺 request/gates 段）', d => ({ ok: true, status: 0, checks: {} }))

let bad = 0
for (const c of cases) {
  const input = structuredClone(base)
  const returned = c.mutate(input)
  const doc = returned === undefined ? input : returned
  writeFileSync(scratch, JSON.stringify(doc, null, 2))
  const wantPass = c.id === 'fixture'
  const r = spawnSync(process.execPath, [import.meta.filename, scratch, '--expect', EXPECT_DEFAULT], { encoding: 'utf8' })
  const gotPass = r.status === 0
  const ok = gotPass === wantPass
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(18)} ${c.why} → ${gotPass ? 'PASS' : 'FAIL'}`)
}
rmSync(tmp, { recursive: true, force: true })
console.log(`REHEARSAL-SELFTEST: ${bad === 0 ? 'PASS' : 'FAIL'} (${cases.length - 1} negative, 1 positive)`)
process.exit(bad === 0 ? 0 : 1)
