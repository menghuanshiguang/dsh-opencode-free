// @ts-check
// Live 产物必须能被机械归档，且归档出来的档案要能过校验器。这两件事任何一条不成立，
// 「阶段 4 的 run 有一份可复核的档案」就是空话。
//
// 本检查用一份夹具（gates/fixtures/live-product）走两遍 --stage 4：
//   1. 连跑两次，输出必须逐字节相同（pins 了 producedBy.at 用 artifact 的 generatedAt）
//   2. 产出必须能过 gates/validate.mjs --stage 4（观测 transport 四键齐备）
// 自归档（第四次 live 的根因）：run 还没结束时 conclusion 只能是 null，而闸门要的正是那一刻
// 不存在的事实。放宽必须带边界——运行中形态要能归档且过 validate，null + completed 必须红，
// 运行中产出的档案也不许声称 failedSteps: []（失败步那时还没发生）。
// 反向：把产物换成那次 real live 真实产出的扁平形状（ok/status/checks，没有 request/fingerprint），
// 归档必须明确拒绝，而不是写出半份档案。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const PRINT = process.argv.includes('--print-command')
const FIX = join(ROOT, 'gates/fixtures/live-product')
const tmp = mkdtempSync(join(tmpdir(), 'live-artifact-'))
const out1 = join(tmp, 'a.json')
const out2 = join(tmp, 'b.json')

const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

// 把真正要跑的归档命令原样打出来：路径、七个必填输入、--stage 4。谁要接进 live 就照抄，
// 不再靠转述。产物目录是解包后的 artifact；artifacts-json 只有在 upload-artifact 之后才存在，
// 所以这一步在 run 里的位置只能在上传之后。
if (PRINT) {
  const cmd = [
    'node gates/from-artifact.mjs',
    `--dir <解包后的 artifact 目录>`,
    `--run-json <本次 run 的 API JSON>`,
    `--jobs-json <本次 run 的 jobs API JSON>`,
    `--artifacts-json <本次 run 的 artifacts API JSON>`,
    `--repo-json <仓库 API JSON>`,
    `--preconditions <gates/check-preconditions.mjs 的输出>`,
    `--negative-tests <gates/selftest.mjs 的输出>`,
    `--lock docs/fingerprint-baseline.json`,
    `--stage 4`,
    `--out <archive.json>`,
  ].join('\\\n  ')
  console.log(`# 真实跑法（夹具里跑通的同一条命令）：\n${cmd}`)
  console.log('# 产出后必须过：node gates/validate.mjs <archive.json> --stage 4 --lock docs/fingerprint-baseline.json')
  process.exit(0)
}

const archiveArgs = (dir, out, extra = {}) => [
  'gates/from-artifact.mjs',
  '--dir', dir,
  '--run-json', extra.runJson ?? join(FIX, 'run.json'),
  '--jobs-json', join(FIX, 'jobs.json'),
  '--artifacts-json', extra.list ?? join(FIX, 'artifacts.json'),
  ...(extra.id ? ['--artifact-id', extra.id] : []),
  ...(extra.byId ? ['--artifact-json', extra.byId] : []),
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

// 正例：artifacts 列表是空的（上传刚结束那一秒的真实形状），但给了 upload-artifact 自己的
// artifact-id 与按 id 取回的单件响应——必须照样产出，并且仍然过 stage 4 的 validate。
// 这一条就是第三发红掉的那个 15 毫秒：判据不许是「等列表追上」，只能是「用上传给的 id」。
let byIdCase = 'not run'
{
  const emptyList = join(tmp, 'artifacts-empty.json')
  writeFileSync(emptyList, JSON.stringify({ total_count: 0, artifacts: [] }, null, 2))
  const fixtureArtifact = JSON.parse(readFileSync(join(FIX, 'artifacts.json'), 'utf8')).artifacts[0]
  const byIdPath = join(tmp, 'artifact-by-id.json')
  writeFileSync(byIdPath, JSON.stringify({ ...fixtureArtifact, id: 14917330510 }, null, 2))
  const viaIdOut = join(tmp, 'by-id.json')
  const viaId = run(archiveArgs(join(FIX, 'artifact'), viaIdOut, { list: emptyList, id: '14917330510', byId: byIdPath }))
  if (viaId.code !== 0) {
    failures.push(`an empty artifacts list with an artifact-id was refused (exit ${viaId.code}) — the id is the fact; waiting for the list is the 15 ms race: ${(viaId.stderr + viaId.stdout).trim().split('\n').slice(-1)[0]}`)
    byIdCase = `refused (exit ${viaId.code})`
  } else {
    const digest = String(fixtureArtifact.digest).replace(/^sha256:/, '')
    const doc = JSON.parse(readFileSync(viaIdOut, 'utf8'))
    const shaOk = String(doc.artifacts?.[0]?.sha256 ?? '') === digest
    const v = run(['gates/validate.mjs', viaIdOut, '--stage', '4', '--lock', join(ROOT, 'docs/fingerprint-baseline.json')])
    if (!shaOk) failures.push(`the by-id archive carries artifact sha256 ${JSON.stringify(doc.artifacts?.[0]?.sha256)}, the by-id response says ${digest}`)
    if (v.code !== 0) failures.push(`the by-id archive does not validate at stage 4 (exit ${v.code}): ${v.stdout.trim().split('\n').slice(-1)[0]}`)
    byIdCase = `archived from the id alone, sha256=${shaOk ? 'match' : 'MISMATCH'}, validate=${v.code === 0 ? 'pass' : 'FAIL'}`
  }
}

// 自归档死锁（第四次 live 的根因）：归档跑在自己这条 run 里，那一刻 conclusion 只能是 null，
// 而 validate 原来只认 success|failure。放宽必须带边界，所以一档一档判：
//   in-progress     null + status=in_progress → 必须归档成功，且过 stage 4 validate
//   null-completed  null + status=completed   → 必须红（没有这一档，放宽就是后门）
//   failed-steps    run 还没结束时产出的档案不许写 failedSteps: []——失败步那时还没发生，
//                   [] 是「这条 run 没有失败步」的断言，而它此刻不可观测（第五层的同一句话）
const inProgressRun = join(FIX, 'run-in-progress.json')
let inProgressCase = 'not run'
let nullCase = 'not run'
{
  const inProgressArchived = join(tmp, 'in-progress.json')
  const arch = run(archiveArgs(join(FIX, 'artifact'), inProgressArchived, { runJson: inProgressRun }))
  if (arch.code !== 0) {
    failures.push(`an in-progress run (conclusion null) was refused (exit ${arch.code}) — self-archiving can never learn its own conclusion: ${(arch.stderr + arch.stdout).trim().split('\n').slice(-1)[0]}`)
    inProgressCase = `refused (exit ${arch.code})`
  } else {
    const v = run(['gates/validate.mjs', inProgressArchived, '--stage', '4', '--lock', join(ROOT, 'docs/fingerprint-baseline.json')])
    if (v.code !== 0) failures.push(`the in-progress archive does not validate at stage 4 (exit ${v.code}): ${v.stdout.trim().split('\n').slice(-1)[0]}`)
    const doc = JSON.parse(readFileSync(inProgressArchived, 'utf8'))
    const claimsNoFailures = Array.isArray(doc.run?.failedSteps) && doc.run.failedSteps.length === 0
    if (claimsNoFailures) failures.push('the in-progress archive says failedSteps: [] — a failing step later in this same run has not happened yet, so an empty list is a claim nobody could observe; it must be null or marked pending')
    inProgressCase = `archived, validate=${v.code === 0 ? 'pass' : 'FAIL'}, failedSteps=${claimsNoFailures ? 'claims [] (lie)' : 'pending'}`
  }
}
{
  const completedRun = join(tmp, 'run-null-completed.json')
  writeFileSync(completedRun, JSON.stringify({ ...JSON.parse(readFileSync(inProgressRun, 'utf8')), status: 'completed' }, null, 2))
  const nullOut = join(tmp, 'null-completed.json')
  const arch = run(archiveArgs(join(FIX, 'artifact'), nullOut, { runJson: completedRun }))
  let refused = arch.code !== 0
  let why = arch.stderr + arch.stdout
  if (!refused) {
    const v = run(['gates/validate.mjs', nullOut, '--stage', '4', '--lock', join(ROOT, 'docs/fingerprint-baseline.json')])
    refused = v.code !== 0
    why = v.stdout + v.stderr
  }
  const named = /conclusion|status/.test(why)
  if (!refused || !named) failures.push(`conclusion null with status=completed was not refused with the field named (refused=${refused}, named=${named}) — that is the back door the relaxation must not open`)
  nullCase = refused ? `refused${named ? ', field named' : ', no field named'}` : 'archived and validated (back door)'
}

// 反向：扁平产物（那次 live 的真实形状）必须被拒
const flatDir = join(tmp, 'flat')
cpSync(join(FIX, 'artifact'), flatDir, { recursive: true })
writeFileSync(join(flatDir, 'gates.flat.json'), readFileSync(join(FIX, 'flat-gates.json')))
const flat = run(archiveArgs(flatDir, join(tmp, 'flat.json')))
if (flat.code !== 1) failures.push(`a flat product was not refused (exit ${flat.code}) — from-artifact must not archive a product without request/fingerprint sections`)
else if (!/FROM-ARTIFACT REFUSED/.test(flat.stderr + flat.stdout)) failures.push(`the refusal did not say why: ${(flat.stderr + flat.stdout).trim().split('\n').slice(-1)[0]}`)

rmSync(tmp, { recursive: true, force: true })

for (const line of failures) console.log(`FAIL ${line}`)
console.log(`checked: conforming product archived twice (${identical ? 'byte-identical' : 'not compared'}), validated at stage 4; empty artifacts list + artifact-id: ${byIdCase}; in-progress run: ${inProgressCase}; null+completed: ${nullCase}; flat product refused`)
console.log(`LIVE-ARTIFACT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures.length === 0 ? 0 : 1)
