// @ts-check
// Live 产物必须能被机械归档，且归档出来的档案要能过校验器。这两件事任何一条不成立，
// 「阶段 4 的 run 有一份可复核的档案」就是空话。
//
// 本检查用一份夹具（gates/fixtures/live-product）走两遍 --stage 4：
//   1. 连跑两次，输出必须逐字节相同（pins 了 producedBy.at 用 artifact 的 generatedAt）
//   2. 产出必须能过 gates/validate.mjs --stage 4（观测 transport 四键齐备）
// 反向：把产物换成那次 real live 真实产出的扁平形状（ok/status/checks，没有 request/fingerprint），
// 归档必须明确拒绝，而不是写出半份档案。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const FIX = join(ROOT, 'gates/fixtures/live-product')
const tmp = mkdtempSync(join(tmpdir(), 'live-artifact-'))
const out1 = join(tmp, 'a.json')
const out2 = join(tmp, 'b.json')

const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

const archiveArgs = (dir, out) => [
  'gates/from-artifact.mjs',
  '--dir', dir,
  '--run-json', join(FIX, 'run.json'),
  '--jobs-json', join(FIX, 'jobs.json'),
  '--artifacts-json', join(FIX, 'artifacts.json'),
  '--repo-json', join(FIX, 'repo.json'),
  '--preconditions', join(FIX, 'preconditions.json'),
  '--negative-tests', join(FIX, 'negative-tests.json'),
  '--lock', join(ROOT, 'docs/fingerprint-baseline.json'),
  '--stage', '4',
  '--out', out,
]

const failures = []
const first = run(archiveArgs(join(FIX, 'artifact'), out1))
if (first.code !== 0) failures.push(`conforming product was refused (exit ${first.code}): ${first.stderr.trim().split('\n').slice(-1)[0]}`)
const second = run(archiveArgs(join(FIX, 'artifact'), out2))
if (second.code !== 0) failures.push(`the second archive run failed (exit ${second.code})`)

let identical = false
if (failures.length === 0) {
  identical = readFileSync(out1).equals(readFileSync(out2))
  if (!identical) failures.push('two runs on the same inputs produced different bytes — the record is not reproducible')
}

if (failures.length === 0) {
  const v = run(['gates/validate.mjs', out1, '--stage', '4', '--lock', join(ROOT, 'docs/fingerprint-baseline.json')])
  if (v.code !== 0) failures.push(`the produced record does not validate at stage 4 (exit ${v.code}): ${v.stdout.trim().split('\n').slice(-1)[0]}`)
}

// 反向：扁平产物（那次 live 的真实形状）必须被拒
const flatDir = join(tmp, 'flat')
cpSync(join(FIX, 'artifact'), flatDir, { recursive: true })
writeFileSync(join(flatDir, 'gates.json'), readFileSync(join(FIX, 'flat-gates.json')))
const flat = run(archiveArgs(flatDir, join(tmp, 'flat.json')))
if (flat.code !== 1) failures.push(`a flat product was not refused (exit ${flat.code}) — from-artifact must not archive a product without request/fingerprint sections`)
else if (!/FROM-ARTIFACT REFUSED/.test(flat.stderr + flat.stdout)) failures.push(`the refusal did not say why: ${(flat.stderr + flat.stdout).trim().split('\n').slice(-1)[0]}`)

rmSync(tmp, { recursive: true, force: true })

for (const line of failures) console.log(`FAIL ${line}`)
console.log(`checked: conforming product archived twice (${identical ? 'byte-identical' : 'not compared'}), validated at stage 4; flat product refused`)
console.log(`LIVE-ARTIFACT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures.length === 0 ? 0 : 1)
