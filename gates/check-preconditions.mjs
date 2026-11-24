#!/usr/bin/env node
/**
 * P1–P3 前置门的判定器 + 反向测试入口。
 *
 * 为什么单独一个文件：这三条不在 run 的 artifact 里，是"仓库与历史"层面的事实。
 * 归档案要求它们也有反向证据（督查 2026-11-24 裁定：每条闸门都要喂过坏输入）。
 * 所以这里把三个输入都做成文件参数，测试就能喂假文件，而不必伪造一个真仓库。
 *
 *   --license <path>    LICENSE 文本（真跑：git show HEAD:LICENSE > /tmp/LICENSE）
 *   --repo-json <file>  仓库 API JSON（真跑：gh api repos/{o}/{r} > /tmp/repo.json）
 *   --git-log <file>    git log -p --all 的输出（真跑：git log -p --all > /tmp/log.txt）
 *
 * 每条给了就判，没给就记 skipped（不当作通过）。任何一条判 FAIL → exit 1。
 *   --json  输出机器可读结果，便于写进 gates.json 的 evidence
 */
import fs from 'node:fs'

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const asJson = argv.includes('--json')
const licensePath = arg('--license')
const repoJsonPath = arg('--repo-json')
const gitLogPath = arg('--git-log')

const results = []
function check(id, ok, detail) { results.push({ id, pass: Boolean(ok), detail }) }

// P1：LICENSE 必须同时带 MIT 正文与派生前的原版权行
if (licensePath) {
  const text = fs.readFileSync(licensePath, 'utf8')
  check('P1', text.includes('MIT License') && text.includes('Ebony-Vinyl'), `MIT=${text.includes('MIT License')} Ebony-Vinyl=${text.includes('Ebony-Vinyl')} bytes=${Buffer.byteLength(text)}`)
}

// P2：只认 API 的 private:false（404/403/推断都不算，见 §P1–P3 判法限制）
if (repoJsonPath) {
  let repo
  try {
    repo = JSON.parse(fs.readFileSync(repoJsonPath, 'utf8'))
  } catch (error) {
    check('P2', false, `repo JSON 读不了：${error.message}`)
  }
  if (repo) check('P2', repo.private === false && repo.visibility === 'public', `private=${repo.private} visibility=${repo.visibility}`)
}

// P3：历史里不能有 token 形态与带密码的 remote URL
if (gitLogPath) {
  const log = fs.readFileSync(gitLogPath, 'utf8')
  const tokens = log.match(/ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}/g) ?? []
  const creds = log.match(/https:\/\/[^/\s]+:[^@\s]+@/g) ?? []
  check('P3', tokens.length === 0 && creds.length === 0, `tokenHits=${tokens.length} credUrlHits=${creds.length}`)
}

const skipped = [
  !licensePath && 'P1',
  !repoJsonPath && 'P2',
  !gitLogPath && 'P3',
].filter(Boolean)

const fail = results.filter(r => !r.pass)
if (asJson) {
  console.log(JSON.stringify({ results, skipped, pass: fail.length === 0 && results.length === 3 }, null, 2))
} else {
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}  ${r.detail}`)
  if (skipped.length) console.log(`SKIPPED ${skipped.join(', ')}（没给输入，不算通过）`)
  console.log(fail.length === 0 && results.length === 3 ? 'PRECONDITIONS: PASS' : 'PRECONDITIONS: FAIL')
}
process.exit(fail.length === 0 && results.length === 3 ? 0 : 1)
