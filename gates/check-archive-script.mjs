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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// 合成产物 + 夹具的四份侧输入（run / jobs / artifacts / repo 的 API JSON）。
// 这四个是「本次 run 的事实」：脚本不自己造，也不许从产物里反推——live 里它们就是
// 上传之后那三次 curl 的响应，这里用夹具顶替，只是为了让 CI 不必真派发一次。
const sidecars = ['run.json', 'jobs.json', 'artifacts.json', 'repo.json'].map(name => join(FIX, name))
const out = join(tmp, 'archive.json')
const baseArgs = [SCRIPT, '--dir', art, '--out', out,
  '--run-json', sidecars[0], '--jobs-json', sidecars[1], '--artifacts-json', sidecars[2], '--repo-json', sidecars[3]]
const sidecarArgs = baseArgs.slice(5)

// 1) 正例：全输入 → rc 0 且产物存在
const good = run(baseArgs)
const produced = existsSync(out)
const announced = /ARCHIVE-OK /.test(good.out)
if (good.code !== 0 || !produced || !announced) failures.push(`正例失败（rc=${good.code}, 产物=${produced}, ARCHIVE-OK=${announced}）: ${good.out.trim().split('\n').slice(-1)[0]}`)
say(good.code === 0 && produced && announced, 'positive', `rc=${good.code} 产物=${produced} ARCHIVE-OK=${announced}`)

// 正例还要证明一件事：P1 的 LICENSE 与 P3 的历史是**脚本自己从检出里取的**，
// 不是夹具喂进去的（参数表里根本没有 --license / --git-log 这两个口子）。
// 判法：档案里 P1 的字节数、P3 的提交数必须等于这个仓库自己的事实。
const gitOut = args => (spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '')
const licenseBytes = Buffer.byteLength(gitOut(['show', 'HEAD:LICENSE']))
const repoCommits = gitOut(['rev-list', '--all', '--count']).trim()
if (produced) {
  const archiveDoc = JSON.parse(readFileSync(out, 'utf8'))
  const p1 = archiveDoc.gates.find(g => g.id === 'P1')?.evidence ?? ''
  const p3 = archiveDoc.gates.find(g => g.id === 'P3')?.evidence ?? ''
  const fromHead = p1.includes(`bytes=${licenseBytes}`)
  const fromGit = repoCommits !== '' && p3.includes(`commits=${repoCommits}`)
  if (!fromHead) failures.push(`档案里的 P1 不是这个检出的 LICENSE（期望 bytes=${licenseBytes}，实际：${p1.slice(0, 80)}）`)
  if (!fromGit) failures.push(`档案里的 P3 不是这个检出的历史（期望 commits=${repoCommits}，实际：${p3.match(/commits=\d+/)?.[0] ?? '没有 commits=…'}）`)
  say(fromHead && fromGit, 'inputs-from-repo', `P1 bytes=${licenseBytes} P3 commits=${repoCommits}`)
}

if (produced) {
  // 2) 同一份输入两遍必须逐字节相同：档案可复现
  const again = join(tmp, 'archive-again.json')
  const second = run([SCRIPT, '--dir', art, '--out', again, ...baseArgs.slice(5)])
  const same = second.code === 0 && readFileSync(out).equals(readFileSync(again))
  if (!same) failures.push(`同一份输入两遍产出不同（rc=${second.code}）——档案不可复现`)
  say(same, 'reproducible', `rc=${second.code} 逐字节相同=${same}`)
}

// 3) 少一个输入 → 必须红
// 缺参必须是 exit 2 并且点名缺的那个：只要求「非零」会被后面任何一个失败蒙混过去。
const noRepo = run(baseArgs.filter((a, i, arr) => a !== '--repo-json' && arr[i - 1] !== '--repo-json'))
const namedInput = /--repo-json/.test(noRepo.out)
if (noRepo.code !== 2 || !namedInput) failures.push(`少 --repo-json 时 rc=${noRepo.code}、点名=${namedInput}——契约是 exit 2 且点名缺的那个`)
say(noRepo.code === 2 && namedInput, 'missing-input', `rc=${noRepo.code} 点名=${namedInput}`)

// 4) 产物目录里缺 gates.flat.json → 必须红
const noProduct = join(tmp, 'artifact-noproduct')
spawnSync('cp', ['-r', art, noProduct])
rmSync(join(noProduct, 'gates.flat.json'), { force: true })
const missing = run([SCRIPT, '--dir', noProduct, '--out', join(tmp, 'x.json'),
  '--run-json', sidecars[0], '--jobs-json', sidecars[1], '--artifacts-json', sidecars[2], '--repo-json', sidecars[3]])
const namedProduct = missing.out.includes('gates.flat.json')
if (missing.code !== 2 || !namedProduct) failures.push(`产物目录缺 gates.flat.json 时 rc=${missing.code}、点名=${namedProduct}——契约是 exit 2 且点名缺的那个文件`)
say(missing.code === 2 && namedProduct, 'missing-product', `rc=${missing.code} 点名=${namedProduct}`)

// 6) 工作树里把 LICENSE 改成别的东西、HEAD 不动：脚本必须读 HEAD，仍然归档成功，
//    且 P1 报的仍是 HEAD 那份的字节数。脚本要是改成读磁盘文件，这一档立刻红。
const wtClone = join(tmp, 'worktree')
spawnSync('git', ['clone', `file://${ROOT}`, wtClone], { encoding: 'utf8' })
if (!existsSync(join(wtClone, 'LICENSE'))) {
  failures.push('工作树那一档克隆不出来，无法判「脚本读的是 HEAD 而不是磁盘」')
} else {
  writeFileSync(join(wtClone, 'LICENSE'), 'not a license\n')
  const wtOut = join(tmp, 'worktree.json')
  const wtRun = run(['scripts/archive-live-run.sh', '--dir', art, '--out', wtOut, ...sidecarArgs], wtClone)
  let wtBytes = 'none'
  if (existsSync(wtOut)) wtBytes = (JSON.parse(readFileSync(wtOut, 'utf8')).gates.find(g => g.id === 'P1')?.evidence ?? '').match(/bytes=(\d+)/)?.[1] ?? 'none'
  const headStillUsed = wtRun.code === 0 && wtBytes === String(licenseBytes)
  if (!headStillUsed) failures.push(`工作树里的 LICENSE 被改掉后 rc=${wtRun.code}、P1 bytes=${wtBytes}（HEAD 是 ${licenseBytes}）——脚本读的不是 HEAD`)
  say(headStillUsed, 'license-from-head', `rc=${wtRun.code} P1 bytes=${wtBytes} HEAD=${licenseBytes}`)
}

// 5) 浅历史 → 必须红
//
// 真跑 `git clone --depth 1 file://<repo>`；这台机器的 git 不支持本地传输上的浅克隆，
// 那就退回同一状态的克隆（完整克隆 + .git/shallow 标记 = 浅克隆留下的那个文件），
// 并且先用 `git rev-parse --is-shallow-repository` 证明确实是浅的，再说它红了。
// 两条路断言的是同一件事：浅检出里脚本必须拒绝归档。
const shallow = join(tmp, 'shallow')
const depth1 = spawnSync('git', ['clone', '--depth', '1', `file://${ROOT}`, shallow], { encoding: 'utf8' })
let how = 'clone --depth 1'
if (!existsSync(join(shallow, '.git'))) {
  rmSync(shallow, { recursive: true, force: true })
  const full = spawnSync('git', ['clone', `file://${ROOT}`, shallow], { encoding: 'utf8' })
  if (full.status !== 0) failures.push(`浅历史这条建不出检出来：${(full.stderr ?? '').trim().split('\n').slice(-1)[0]}`)
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: shallow, encoding: 'utf8' }).stdout ?? ''
  if (existsSync(join(shallow, '.git'))) writeFileSync(join(shallow, '.git', 'shallow'), head)
  how = 'simulated (local git refuses shallow over file://)'
}
if (!existsSync(join(shallow, 'scripts/archive-live-run.sh'))) {
  failures.push('浅检出里没有脚本，无法判「浅历史必须红」——这条不许静默跳过')
} else {
  const isShallow = (spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: shallow, encoding: 'utf8' }).stdout ?? '').trim()
  if (isShallow !== 'true') failures.push(`这一份不是浅检出（is-shallow-repository=${isShallow}），判「浅历史必须红」就没有意义`)
  const shallowRun = run(['scripts/archive-live-run.sh', '--dir', art, '--out', join(tmp, 'y.json'),
    '--run-json', sidecars[0], '--jobs-json', sidecars[1], '--artifacts-json', sidecars[2], '--repo-json', sidecars[3]], shallow)
  if (shallowRun.code !== 1 || !/浅历史/.test(shallowRun.out)) failures.push(`浅历史下 rc=${shallowRun.code}：契约是 exit 1 并点名浅历史`)
  say(shallowRun.code === 1 && /浅历史/.test(shallowRun.out), 'shallow-history', `rc=${shallowRun.code} is-shallow=${isShallow} ${how}`)
}

rmSync(tmp, { recursive: true, force: true })
for (const line of failures) console.log(`FAIL ${line}`)
console.log(`ARCHIVE-SCRIPT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures.length === 0 ? 0 : 1)
