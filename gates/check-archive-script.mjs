// @ts-check
// 归档那串命令只能有一处定义：scripts/archive-live-run.sh。CI 用合成输入调同一个脚本，
// 证明它在三种坏情况下会红——这样「只在真派发时才红」的序列就不再存在。
//
// 脚本契约（由闸门这一侧定，实现照此写）：
//   scripts/archive-live-run.sh --dir <artifact 目录> --out <archive.json>
//                               [--repo-json <p>] [--license <p>] [--git-log <p>]
//   输入：<dir>/live.json、<dir>/gates.flat.json、<dir>/fields.json
//   exit 0 产出 <archive.json>，并打印 `ARCHIVE-OK <path>`
//   exit 2 缺参数或产物目录里缺必需文件
//   exit 1 P1–P3 没全过（check-preconditions 的 pass 不是 true）
//   exit 1 浅历史（git rev-parse --is-shallow-repository = true）——浅历史下 P3 等于拿一个提交充数
//
// 脚本还不存在时本检查 exit 2：失败关闭，不许因为「还没实现」而静默通过。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const SCRIPT = join(ROOT, 'scripts/archive-live-run.sh')
const FIX = join(ROOT, 'gates/fixtures/live-product')

const say = (ok, tag, detail) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${tag.padEnd(22)} ${detail}`)
const run = (args, cwd = ROOT) => {
  const r = spawnSync('bash', args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const failures = []
if (!existsSync(SCRIPT)) {
  console.log('FAIL scripts/archive-live-run.sh 不存在——归档序列还没有唯一一份定义；本检查失败关闭（exit 2）')
  console.log('ARCHIVE-SCRIPT: FAIL (missing scripts/archive-live-run.sh)')
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'archive-'))
const art = join(tmp, 'artifact')
const pre = join(tmp, 'preconditions.json')
const lic = join(tmp, 'LICENSE')
const gitlog = join(tmp, 'gitlog.txt')
writeFileSync(lic, readFileSync(join(ROOT, 'LICENSE')))
writeFileSync(gitlog, spawnSync('git', ['log', '-p', '--all'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout ?? '')

// 合成产物：直接用夹具里的四件
spawnSync('cp', ['-r', join(FIX, 'artifact'), art])
writeFileSync(pre, JSON.stringify({ pass: true, results: [{ id: 'P1', pass: true, detail: 'synthetic' }, { id: 'P2', pass: true, detail: 'synthetic' }, { id: 'P3', pass: true, detail: 'synthetic' }] }))

const out = join(tmp, 'archive.json')
const baseArgs = [SCRIPT, '--dir', art, '--out', out, '--repo-json', join(FIX, 'repo.json'), '--license', lic, '--git-log', gitlog]

// 1) 正例：全输入 → rc 0 且产物存在
const good = run(baseArgs)
const produced = existsSync(out)
if (good.code !== 0 || !produced) failures.push(`正例失败（rc=${good.code}, 产物=${produced}）: ${good.out.trim().split('\n').slice(-1)[0]}`)
say(good.code === 0 && produced, 'positive', `rc=${good.code} 产物=${produced}`)

// 2) 少一个输入 → 必须红
const noRepo = run(baseArgs.filter((a, i, arr) => a !== '--repo-json' && arr[i - 1] !== '--repo-json'))
if (noRepo.code === 0) failures.push('少 --repo-json 仍然 rc=0：缺参不许降级')
say(noRepo.code !== 0, 'missing-input', `rc=${noRepo.code}`)

// 3) 产物目录里缺 gates.flat.json → 必须红
const noProduct = join(tmp, 'artifact-noproduct')
spawnSync('cp', ['-r', art, noProduct])
rmSync(join(noProduct, 'gates.flat.json'), { force: true })
const missing = run([SCRIPT, '--dir', noProduct, '--out', join(tmp, 'x.json'), '--repo-json', join(FIX, 'repo.json'), '--license', lic, '--git-log', gitlog])
if (missing.code === 0) failures.push('产物目录缺 gates.flat.json 仍然 rc=0：产物存在性没有断言')
say(missing.code !== 0, 'missing-product', `rc=${missing.code}`)

// 4) 浅历史 → 必须红（深度 1 的克隆里跑同一个脚本）
const shallow = join(tmp, 'shallow')
spawnSync('git', ['clone', '--depth', '1', `file://${ROOT}`, shallow], { encoding: 'utf8' })
if (!existsSync(join(shallow, 'scripts/archive-live-run.sh'))) {
  failures.push('浅克隆里没有脚本，无法判「浅历史必须红」——这条不许静默跳过')
} else {
  const shallowRun = run(['scripts/archive-live-run.sh', '--dir', art, '--out', join(tmp, 'y.json'), '--repo-json', join(FIX, 'repo.json'), '--license', lic, '--git-log', gitlog], shallow)
  if (shallowRun.code === 0) failures.push('浅历史（--depth 1）下仍然 rc=0：P3 等于拿一个提交充数')
  say(shallowRun.code !== 0, 'shallow-history', `rc=${shallowRun.code}`)
}

rmSync(tmp, { recursive: true, force: true })
for (const line of failures) console.log(`FAIL ${line}`)
console.log(`ARCHIVE-SCRIPT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures.length === 0 ? 0 : 1)
