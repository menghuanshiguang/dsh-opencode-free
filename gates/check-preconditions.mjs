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

// P3：历史里不能有真 token，也不能有带密码的 remote URL。
//
// 两档判据（督查 2026-11-24 裁定）：
//   必零：带长度限定的真 token 形态 0 命中（ghp_36 / github_pat_22+ / gho_36 / ghs_36 / ghu_36 / sk-20+）
//   参考：裸前缀照数，但每一处必须给 文件:行 与归类；出现 unclassified（=可能是真值）即 FAIL。
// 为什么要分档：裸前缀会把扫描器自己的正则和喂给它的合成负样例判成泄漏——那是门红错对象。
const TOKEN_SHAPES = /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}/g
// 词边界：mask-blur、task-queue、disk-io 里的 sk- 不是前缀
const BARE_PREFIX = /(?<![A-Za-z0-9])(?:ghp_|github_pat_|gho_|ghs_|ghu_|sk-)/g

function classify(line, matchText) {
  // 文档/注释里列举前缀：必零档已经保证没有真形态，这里只作参考档归类
  if (/^\s*(?:\/\/|#|\*|--)/.test(line)) return 'doc-reference'
  // 合成样例：源码里拼出来的假值，例如 'ghp_' + 'A'.repeat(36) 或 ${'A'.repeat(36)}
  const at = line.indexOf(matchText)
  const after = line.slice(at + matchText.length, at + matchText.length + 3)
  // 本仓库/上游自己的 key 前缀与占位：sk-magpie-key-… / sk-… / sk-* / sk-${…}
  const rest = line.slice(at + matchText.length)
  if (matchText === 'sk-' && /^(magpie-key-|…|\.\.\.|\*|\$\{)/.test(rest)) {
    return rest.startsWith('magpie-key-') ? 'internal-key-prefix' : 'placeholder'
  }
  if (after.startsWith('${') || /\.repeat\(/.test(line) || /'[A-Z]'\s*\+/.test(line)) return 'synthetic-sample'
  // 扫描器自身：正则字面量或 grep 表达式
  if (/log\.match\(|grep\s+-|new RegExp|[A-Za-z_]\s*=\s*\/[^/]*ghp_|matchText ===|BARE_PREFIX|TOKEN_SHAPES/.test(line)) return 'scanner-source'
  return 'unclassified'
}

function scanHistory(log) {
  const findings = []
  let file = '(unknown)'
  let lineNo = 0
  for (const raw of log.split('\n')) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue }
    if (raw.startsWith('+++ ')) { file = raw.slice(4); continue }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { lineNo = Number(hunk[1]); continue }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      for (const shape of raw.match(TOKEN_SHAPES) ?? []) findings.push({ kind: 'token-shape', file, line: lineNo, shape })
      const added = raw.slice(1) // 去掉 diff 的前导 '+'，注释行才认得出
      for (const bare of added.match(BARE_PREFIX) ?? []) findings.push({ kind: 'bare-prefix', file, line: lineNo, bare, class: classify(added, bare) })
      lineNo++
    } else if (!raw.startsWith('-')) {
      lineNo++
    }
  }
  return findings
}

if (gitLogPath) {
  const log = fs.readFileSync(gitLogPath, 'utf8')
  const findings = scanHistory(log)
  const tokenShapes = findings.filter(f => f.kind === 'token-shape')
  const creds = log.match(/https:\/\/[^/\s]+:[^@\s]+@/g) ?? []
  const bare = findings.filter(f => f.kind === 'bare-prefix')
  const ALLOWED_CLASSES = new Set(['scanner-source', 'synthetic-sample', 'doc-reference', 'internal-key-prefix', 'placeholder'])
  const unclassified = bare.filter(f => !ALLOWED_CLASSES.has(f.class))
  const classified = bare.map(f => `${f.file}:${f.line} ${f.bare} ${f.class}`)
  const hardOk = tokenShapes.length === 0 && creds.length === 0 && unclassified.length === 0
  const detail = [
    `tokenShapes=${tokenShapes.length}`,
    `credUrlHits=${creds.length}`,
    `barePrefix=${bare.length}`,
    `unclassified=${unclassified.length}`,
    ...(unclassified.length ? ['UNCLASSIFIED: ' + unclassified.map(f => `${f.file}:${f.line} ${f.bare}`).join(', ')] : []),
    ...(classified.length ? ['(' + classified.join(' | ') + ')'] : []),
    `commits=${(log.match(/^commit [0-9a-f]{40}$/gm) ?? []).length}`,
  ].join(' ')
  check('P3', hardOk, detail)
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
