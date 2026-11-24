// @ts-check
// 「这份档案绑的是哪一件 artifact」——必须绑在这一条 run 的 live 产物上。
//
// 2026-11-24 那份封存档案（run 45406791349）的内容全对、名字全对，只有 artifacts[0] 绑到了
// archive-45406791349（run 自己那个封存 zip，列表第 0 个），而不是 live-45406791349。
// validate 只查字段齐备，rc 仍是 0。这个病根在两处，本检查两处都判：
//   ① scripts/seal-live-run.sh 在线挑件：`.find(name.includes(runId))` —— 两个名字都含
//      run id，取列表第 0 个；
//   ② gates/from-artifact.mjs 的列表分支：`.find(name.includes(runId)) ?? 列表[0]` ——
//      离线封存（--inputs，不给 --artifact-id）走的正是这一支，验收员那份就是这么来的。
// 契约：只认逐字等于 `live-<runid>` 的那一件，唯一命中才用；只剩 archive-<runid> 必须拒，
// 两件同名 live-<runid> 也必须拒（挑哪一件都是猜）。
//
// 在线那两档用 PATH 上的 curl shim 扮 HTTP（本机起不了 HTTP 服务，这个办法在 check-archive-script
// 里已经用过）：应答是假的，被测的挑件与退出码是真的。zip 解包要 unzip，ubuntu runner 自带；
// 这台机器没有，就退到 PATH 末尾一个 python3 zipfile 垫片（真 unzip 在就先用真的，垫片排在后面）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const FIX = join(ROOT, 'gates/fixtures/live-product')
const SEAL = join(ROOT, 'scripts/seal-live-run.sh')
const LOCK = join(ROOT, 'docs/fingerprint-baseline.json')
const RUN_ID = 45348584364
const LIVE_ID = 14925976888 // 这一条 run 的 live 产物
const ARCHIVE_ID = 14926406510 // 同一 run 的封存 zip——名字也含 run id，正是它把人骗了
const LIVE_NAME = `live-${RUN_ID}`
const ARCHIVE_NAME = `archive-${RUN_ID}`

const say = (ok, tag, detail) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${tag.padEnd(22)} ${detail}`)
const tail = text => (String(text).trim().split('\n').at(-1) ?? '')
// 封存那条链里任何一环都可能拒，只看最后一行会看成「它没说明原因」；失败时留最后六行。
const tail6 = text => String(text).trim().split('\n').slice(-6).join(' ⏎ ')

if (!existsSync(SEAL)) {
  console.log('FAIL scripts/seal-live-run.sh 不存在——封存那一步没有唯一一份定义；本检查失败关闭（exit 2）')
  console.log('ARTIFACT-BINDING: FAIL (missing scripts/seal-live-run.sh)')
  process.exit(2)
}

// 本机 PATH 里的 bash/env 是包装器：`env bash …` 与 `bash -c "…"` 两种都丢调用方给的 env，
// 位置参数也会被吞。唯一实测能同时保住变量与参数的形状是 /bin/bash -c "export …; exec bash …"。
const quote = value => `'${String(value).split("'").join(`'\\''`)}'`
const runWithEnv = (args, env, cwd = ROOT) => {
  const assigns = Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('; ')
  const command = `${assigns}; exec bash ${args.map(quote).join(' ')}`
  const r = spawnSync('/bin/bash', ['-c', command], { cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const node = args => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const tmp = mkdtempSync(join(tmpdir(), 'artifact-binding-'))
const failures = []
let unjudged = null
const expiresAt = '2026-12-24T07:31:00Z'
const entry = (id, name, digestChar) => ({
  id, name, size_in_bytes: 4096, digest: `sha256:${digestChar.repeat(64)}`, expires_at: expiresAt,
})
const both = join(tmp, 'list-both.json') // 封存 zip 排在前面：这正是出事那次的顺序
writeFileSync(both, JSON.stringify({ total_count: 2, artifacts: [entry(ARCHIVE_ID, ARCHIVE_NAME, 'b'), entry(LIVE_ID, LIVE_NAME, 'a')] }, null, 2))
const onlyArchive = join(tmp, 'list-archive-only.json')
writeFileSync(onlyArchive, JSON.stringify({ total_count: 1, artifacts: [entry(ARCHIVE_ID, ARCHIVE_NAME, 'b')] }, null, 2))
const duplicateLive = join(tmp, 'list-duplicate-live.json')
writeFileSync(duplicateLive, JSON.stringify({ total_count: 2, artifacts: [entry(LIVE_ID, LIVE_NAME, 'a'), entry(ARCHIVE_ID, LIVE_NAME, 'b')] }, null, 2))

// ---- ①②③ from-artifact 的列表分支（离线封存走的就是这一支）----
const archiveArgs = (list, out) => [
  'gates/from-artifact.mjs',
  '--dir', join(FIX, 'artifact'),
  '--run-json', join(FIX, 'run.json'),
  '--jobs-json', join(FIX, 'jobs.json'),
  '--artifacts-json', list,
  '--repo-json', join(FIX, 'repo.json'),
  '--preconditions', join(FIX, 'preconditions.json'),
  '--negative-tests', join(FIX, 'negative-tests.json'),
  '--lock', LOCK,
  '--stage', '4',
  '--out', out,
]

// ① 两件都含 run id、封存 zip 在前 → 必须绑 live，且产出的档案要过 stage 4
{
  const out = join(tmp, 'pick-live.json')
  const r = node(archiveArgs(both, out))
  let bound = 'none'
  let validated = false
  if (r.code === 0 && existsSync(out)) {
    const doc = JSON.parse(readFileSync(out, 'utf8'))
    const first = doc.artifacts?.[0] ?? {}
    bound = `${first.name} id=${first.id}`
    const v = node(['gates/validate.mjs', out, '--stage', '4', '--lock', LOCK])
    validated = v.code === 0
    const ok = first.name === LIVE_NAME && String(first.id) === String(LIVE_ID)
    if (!ok) failures.push(`列表里 [${ARCHIVE_NAME}, ${LIVE_NAME}] 时档案绑的是 ${bound}——必须绑 ${LIVE_NAME} id=${LIVE_ID}（按名字选，不按顺序挑第 0 个）`)
    if (!validated) failures.push(`绑对 live 之后仍过不了 stage 4 validate：${tail(v.out)}`)
    say(ok && validated, 'list-picks-live', `rc=${r.code} 绑定=${bound} validate=${validated ? 'pass' : 'FAIL'}`)
  } else {
    failures.push(`列表里 [${ARCHIVE_NAME}, ${LIVE_NAME}] 时 rc=${r.code} 没产出档案：${tail(r.out)}`)
    say(false, 'list-picks-live', `rc=${r.code} 产物=${existsSync(out)}`)
  }
}

// ② 只剩 archive-<runid> → 必须拒，并点名它等的那个名字
{
  const out = join(tmp, 'archive-only.json')
  const r = node(archiveArgs(onlyArchive, out))
  const named = r.out.includes(LIVE_NAME)
  const refused = r.code === 1 && !existsSync(out)
  if (!refused || !named) failures.push(`列表里只剩 ${ARCHIVE_NAME} 时 rc=${r.code} 点名${LIVE_NAME}=${named} 产物=${existsSync(out)}——契约是 exit 1 且点名它要的那一件，不许拿封存 zip 充数`)
  say(refused && named, 'rejects-archive-only', `rc=${r.code} 点名=${named} 产物=${existsSync(out)}`)
}

// ③ 两件都叫 live-<runid> → 命名撞了，必须拒（挑哪一件都是猜）
{
  const out = join(tmp, 'duplicate-live.json')
  const r = node(archiveArgs(duplicateLive, out))
  const refused = r.code === 1 && !existsSync(out)
  const explains = /2 件都叫|命名撞了/.test(r.out)
  if (!refused || !explains) failures.push(`列表里有两件都叫 ${LIVE_NAME} 时 rc=${r.code} 说明=${explains}——契约是 exit 1 并说明命名撞了，不许默默挑第一件`)
  say(refused && explains, 'rejects-duplicate-live', `rc=${r.code} 说明=${explains}`)
}

// ---- ④⑤ 封存在线挑件（scripts/seal-live-run.sh）----
const shimDir = join(tmp, 'bin')
const fbDir = join(tmp, 'fallback')
mkdirSync(shimDir, { recursive: true })
mkdirSync(fbDir, { recursive: true })
writeFileSync(join(shimDir, 'curl'), [
  '#!/usr/bin/env bash',
  '# 只扮 GitHub API：run / jobs / artifacts 列表 / 仓库 / 按 id 取件 / 按 id 取 zip。',
  '# 每次调用把 URL 追加进 $SHIM_STATE/urls.log——「它到底取了哪一件」是这一档的判据。',
  'set -u',
  'state=${SHIM_STATE:?}',
  'printf "ARGC=%s" "$#" >> "$state/args.log"; for a in "$@"; do printf " [%s]" "$a" >> "$state/args.log"; done; printf "\\n" >> "$state/args.log"',
  'url=\'\'; out=\'\'',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -o) out=${2:-}; shift 2 ;;',
  '    -w | -H | -m | --max-time) shift 2 ;;',
  '    -*) shift 1 ;;',
  '    *) url=$1; shift 1 ;;',
  '  esac',
  'done',
  'printf "%s\\n" "$url" >> "$state/urls.log"',
  'case "$url" in',
  '  */actions/runs/*/jobs) body=$SHIM_JOBS ;;',
  '  */actions/runs/*/artifacts) body=$SHIM_LIST ;;',
  '  */actions/runs/*) body=$SHIM_RUN ;;',
  '  */actions/artifacts/*/zip) cp "$SHIM_ZIP" "$out" 2>/dev/null || true; printf 200; exit 0 ;;',
  '  */actions/artifacts/*) body=$SHIM_ONE ;;',
  '  *) body=$SHIM_REPO ;;',
  'esac',
  'printf "%s -> %s\n" "$url" "$body" >> "$state/served.log"',
  '[ -n "$out" ] && cp "$body" "$out"',
  'printf 200',
  '',
].join('\n'), { mode: 0o755 })
// 本机没有 unzip；ubuntu runner 有。真 unzip 在就先用真的（垫片排在 PATH 末尾）。
const unzipShim = join(fbDir, 'unzip')
writeFileSync(unzipShim, [
  '#!/usr/bin/env bash',
  '# 只在这台机器没有真 unzip 时兜底：用 python3 的 zipfile 解到当前目录。',
  'set -u',
  'zip=\'\'',
  'for a in "$@"; do case "$a" in -*) ;; *) zip=$a ;; esac; done',
  'exec python3 -c \'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(".")\' "$zip"',
  '',
].join('\n'), { mode: 0o755 })

// 夹具的 artifact 目录打成真 zip：归档脚本解出来的就是 gates/fixtures/live-product/artifact 那一份
const zipPath = join(tmp, 'live.zip')
const zipBuild = spawnSync('python3', ['-c', [
  'import os,sys,zipfile',
  'src,dst=sys.argv[1],sys.argv[2]',
  'z=zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED)',
  'for root,_,files in os.walk(src):',
  '    for name in files:',
  '        p=os.path.join(root,name)',
  '        z.write(p, os.path.join("_temp", os.path.relpath(p,src)))',
  'z.close()',
].join('\n'), join(FIX, 'artifact'), zipPath], { encoding: 'utf8' })
if (zipBuild.status !== 0 || !existsSync(zipPath)) {
  console.log(`FAIL 打不出夹 zip：${(zipBuild.stderr ?? '').trim().split('\n').at(-1)}`)
  console.log('ARTIFACT-BINDING: FAIL (fixture zip)')
  process.exit(2)
}

// 封存在线那两档要先过「run 已结束」这一关：夹具的 run.json 没有 status 字段（它在
// from-artifact 那里按「已结束」处理，因为没 status 就等于不是运行中）。封存要的是真的
// `status=completed`，所以这一档自己补上，不去改共用夹具的字节——改了会让从它推出的
// 那两份夹具档案变字节，凭空的变动比补一个字段更贵。
const sealRun = join(tmp, 'run-seal.json')
writeFileSync(sealRun, JSON.stringify({ ...JSON.parse(readFileSync(join(FIX, 'run.json'), 'utf8')), status: 'completed' }, null, 2))

const realPath = process.env.PATH ?? ''
const sealEnv = (state, extra) => ({
  PATH: `${shimDir}:${realPath}:${fbDir}`,
  GITHUB_TOKEN: 'fixture-token',
  GITHUB_REPOSITORY: 'fixture/repo',
  GITHUB_API_URL: 'https://api.github.com',
  SHIM_STATE: state,
  SHIM_RUN: sealRun,
  SHIM_JOBS: join(FIX, 'jobs.json'),
  SHIM_REPO: join(FIX, 'repo.json'),
  SHIM_ZIP: zipPath,
  ...extra,
})
const freshState = name => {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const zipRequests = state => {
  const log = join(state, 'urls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line.includes('/artifacts/') && line.includes('/zip'))
}

// ④ 列表里 [archive, live] → zip 必须下 live 的那一件，且产出档案绑 live
{
  const state = freshState('state-seal-both')
  const out = join(tmp, 'sealed-both')
  const one = join(tmp, 'one-live.json')
  writeFileSync(one, JSON.stringify(entry(LIVE_ID, LIVE_NAME, 'a'), null, 2))
  const r = runWithEnv([SEAL, String(RUN_ID), '--out', out], sealEnv(state, { SHIM_LIST: both, SHIM_ONE: one }))
  const zips = zipRequests(state)
  const gotLive = zips.length === 1 && zips[0].includes(`/artifacts/${LIVE_ID}/zip`)
  const gotArchive = zips.some(url => url.includes(`/artifacts/${ARCHIVE_ID}/zip`))
  let bound = 'none'
  let validated = false
  if (r.code === 0 && existsSync(join(out, 'gates.json'))) {
    const doc = JSON.parse(readFileSync(join(out, 'gates.json'), 'utf8'))
    const first = doc.artifacts?.[0] ?? {}
    bound = `${first.name} id=${first.id}`
    validated = node(['gates/validate.mjs', join(out, 'gates.json'), '--stage', '4', '--lock', LOCK]).code === 0
  }
  // 本机那层 bash 替身在「-o 与 -w 同时出现」时会把其后的 URL 截成空串（矩阵见 README 附注），
  // 于是「按 id 取单件响应」这一句发出去的是一个空 URL。那不是脚本的错，是这台机器判不了这一档：
  // 按规矩不许静默跳过，也不许把环境问题记成脚本的失败——整份检查以 exit 2 收尾，写明本机不可判。
  const servedTxt = existsSync(join(state, 'served.log')) ? readFileSync(join(state, 'served.log'), 'utf8') : ''
  const mangled = /^ -> /m.test(servedTxt)
  const ok = r.code === 0 && gotLive && !gotArchive && bound === `${LIVE_NAME} id=${LIVE_ID}` && validated
  if (mangled && !ok) {
    unjudged = 'seal 在线档：本机 bash 替身把 `-o`+`-w` 之后的位置参数截成空串（URL 变空），这一档本机不可判；CI 上按真 bash 判'
  } else if (!ok) failures.push(`封存（列表 [${ARCHIVE_NAME}, ${LIVE_NAME}]）rc=${r.code} zip请求=${JSON.stringify(zips)} 绑定=${bound} validate=${validated}——必须只下 live 那一件、只绑 live 那一件：${tail6(r.out)}\nserved:\n${existsSync(join(state, 'served.log')) ? readFileSync(join(state, 'served.log'), 'utf8') : '(none)'}\nargv:\n${existsSync(join(state, 'args.log')) ? readFileSync(join(state, 'args.log'), 'utf8') : '(none)'}`)
  say(ok, 'seal-picks-live', mangled && !ok
    ? `UNJUDGED rc=${r.code}：本机 shell 截断 curl 参数（URL 空），不是脚本的判据`
    : `rc=${r.code} zip=${zips.map(u => u.split('/').slice(-2)[0]).join(',') || 'none'} 绑定=${bound} validate=${validated ? 'pass' : 'FAIL'}`)
}

// ⑤ 列表里只剩 archive-<runid> → 必须拒，点名 live-<runid>，且一个 zip 都不许下
{
  const state = freshState('state-seal-archive-only')
  const out = join(tmp, 'sealed-archive-only')
  const r = runWithEnv([SEAL, String(RUN_ID), '--out', out], sealEnv(state, {
    SHIM_LIST: onlyArchive,
    SHIM_ONE: join(tmp, 'one-live.json'),
  }))
  const zips = zipRequests(state)
  const named = r.out.includes(LIVE_NAME)
  const refused = r.code === 1 && !existsSync(join(out, 'gates.json'))
  if (!refused || !named || zips.length !== 0) failures.push(`封存遇到只剩 ${ARCHIVE_NAME} 时 rc=${r.code} 点名${LIVE_NAME}=${named} zip请求=${zips.length}——契约是 exit 1、点名它要的那一件、且不许下封存 zip：${tail(r.out)}`)
  say(refused && named && zips.length === 0, 'seal-rejects-archive-only', `rc=${r.code} 点名=${named} zip请求=${zips.length}`)
}

rmSync(tmp, { recursive: true, force: true })
for (const line of failures) console.log(`FAIL ${line}`)
if (failures.length > 0) {
  console.log('ARTIFACT-BINDING: FAIL')
  process.exit(1)
}
// 不可判 ≠ 通过：写给 CI 与读日志的人看，退出码走 2（缺前置/判不了），不伪装成绿。
if (unjudged) {
  console.log(`ARTIFACT-BINDING: UNJUDGED — ${unjudged}`)
  process.exit(2)
}
console.log('ARTIFACT-BINDING: PASS')
process.exit(0)
