// @ts-check
// 归档那串命令只能有一处定义：scripts/archive-live-run.sh。CI 用合成输入调同一个脚本，
// 证明它在三种坏情况下会红——这样「只在真派发时才红」的序列就不再存在。
//
// 脚本契约（由闸门这一侧定，实现照此写）：
//   scripts/archive-live-run.sh --dir <产物目录> --out <archive.json> \
//     --run-json <p> --jobs-json <p> --artifacts-json <p> --repo-json <p> [--product <name>]
//   输入：<dir>/live.json、<dir>/<product>（默认 gates.flat.json）、<dir>/fields.json、<dir>/egress.env
//   三个前置门的输入由脚本自己取（git show HEAD:LICENSE、git log -p --all、--repo-json 指的那份），
//   调用方不给，也不许各写一遍。
//   exit 0 产出 <archive.json>，并打印 `ARCHIVE-OK <path>`
//   exit 2 缺参数或产物目录里缺必需文件
//   exit 1 P1–P3 没全过（check-preconditions 的 pass 不是 true）、from-artifact 拒绝、validate 不过
//   exit 1 浅历史（git rev-parse --is-shallow-repository = true）——浅历史下 P3 等于拿一个提交充数
//
// 脚本还不存在时本检查 exit 2：失败关闭，不许因为「还没实现」而静默通过。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const SCRIPT = join(ROOT, 'scripts/archive-live-run.sh')
const FIX = join(ROOT, 'gates/fixtures/live-product')
const LIVE_WORKFLOW = join(ROOT, '.github/workflows/free-lane-live.yml')

const say = (ok, tag, detail) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${tag.padEnd(22)} ${detail}`)
// `env bash` 而不是直接 `bash`：本机那层 shell 包装会把脚本后面的参数吞掉，
// 在这里就等于永远测「缺参数」的分支。env 是同一个解释器，runner 上无差别。
const run = (args, cwd = ROOT) => {
  const r = spawnSync('env', ['bash', ...args], { cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const failures = []
if (!existsSync(SCRIPT)) {
  console.log('FAIL scripts/archive-live-run.sh 不存在——归档序列还没有唯一一份定义；本检查失败关闭（exit 2）')
  console.log('ARCHIVE-SCRIPT: FAIL (missing scripts/archive-live-run.sh)')
  process.exit(2)
}

// 「一处定义」不只是脚本存在：live workflow 自己不许再把 from-artifact / validate 那串命令抄一遍。
const workflowText = readFileSync(LIVE_WORKFLOW, 'utf8')
for (const twice of ['gates/from-artifact.mjs', 'gates/check-preconditions.mjs', 'gates/validate.mjs']) {
  if (workflowText.includes(twice)) failures.push(`free-lane-live.yml 里仍然直接调用 ${twice}——归档序列有两处定义了`)
}
say(!failures.length, 'one-definition', failures.length ? 'free-lane-live.yml 里还有第二份' : 'free-lane-live.yml 只调脚本')

const tmp = mkdtempSync(join(tmpdir(), 'archive-'))
const art = join(tmp, 'artifact')
spawnSync('cp', ['-r', join(FIX, 'artifact'), art])

// 合成产物 + 夹具的四个 run 侧输入，形状与 live 里 upload 之后的那一份相同
const sidecars = ['run.json', 'jobs.json', 'artifacts.json', 'repo.json'].map(name => join(FIX, name))
const out = join(tmp, 'archive.json')
const baseArgs = [SCRIPT, '--dir', art, '--out', out,
  '--run-json', sidecars[0], '--jobs-json', sidecars[1], '--artifacts-json', sidecars[2], '--repo-json', sidecars[3]]

// 1) 正例：全输入 → rc 0 且产物存在
const good = run(baseArgs)
const produced = existsSync(out)
if (good.code !== 0 || !produced) failures.push(`正例失败（rc=${good.code}, 产物=${produced}）: ${good.out.trim().split('\n').slice(-1)[0]}`)
say(good.code === 0 && produced, 'positive', `rc=${good.code} 产物=${produced}`)

if (produced) {
  // 2) 同一份输入两遍必须逐字节相同：档案可复现
  const again = join(tmp, 'archive-again.json')
  const second = run([SCRIPT, '--dir', art, '--out', again, ...baseArgs.slice(5)])
  const same = second.code === 0 && readFileSync(out).equals(readFileSync(again))
  if (!same) failures.push(`同一份输入两遍产出不同（rc=${second.code}）——档案不可复现`)
  say(same, 'reproducible', `rc=${second.code} 逐字节相同=${same}`)
}

// 3) 少一个输入 → 必须红
const noRepo = run(baseArgs.filter((a, i, arr) => a !== '--repo-json' && arr[i - 1] !== '--repo-json'))
if (noRepo.code === 0) failures.push('少 --repo-json 仍然 rc=0：缺参不许降级')
say(noRepo.code !== 0, 'missing-input', `rc=${noRepo.code}`)

// 4) 产物目录里缺 gates.flat.json → 必须红
const noProduct = join(tmp, 'artifact-noproduct')
spawnSync('cp', ['-r', art, noProduct])
rmSync(join(noProduct, 'gates.flat.json'), { force: true })
const missing = run([SCRIPT, '--dir', noProduct, '--out', join(tmp, 'x.json'),
  '--run-json', sidecars[0], '--jobs-json', sidecars[1], '--artifacts-json', sidecars[2], '--repo-json', sidecars[3]])
if (missing.code === 0) failures.push('产物目录缺 gates.flat.json 仍然 rc=0：产物存在性没有断言')
say(missing.code !== 0, 'missing-product', `rc=${missing.code}`)

// 5) 浅历史 → 必须红（深度 1 的克隆里跑同一个脚本）
const shallow = join(tmp, 'shallow')
spawnSync('git', ['clone', '--depth', '1', `file://${ROOT}`, shallow], { encoding: 'utf8' })
if (!existsSync(join(shallow, 'scripts/archive-live-run.sh'))) {
  failures.push('浅克隆里没有脚本，无法判「浅历史必须红」——这条不许静默跳过')
} else {
  const shallowRun = run(['scripts/archive-live-run.sh', '--dir', art, '--out', join(tmp, 'y.json'),
    '--run-json', sidecars[0], '--jobs-json', sidecars[1], '--artifacts-json', sidecars[2], '--repo-json', sidecars[3]], shallow)
  if (shallowRun.code === 0) failures.push('浅历史（--depth 1）下仍然 rc=0：P3 等于拿一个提交充数')
  say(shallowRun.code !== 0, 'shallow-history', `rc=${shallowRun.code}`)
}

rmSync(tmp, { recursive: true, force: true })
for (const line of failures) console.log(`FAIL ${line}`)
console.log(`ARCHIVE-SCRIPT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures.length === 0 ? 0 : 1)
