#!/usr/bin/env node
/**
 * 生成 / 校验 docs/opencode-assets.lock.json：23 个官方 v2.2.3 源文件的 blob sha 锁。
 *
 *   node gates/asset-lock-23.mjs            # 匿名取回 23 个文件，重算并写锁
 *   node gates/asset-lock-23.mjs --check    # 只重算比对，不写；不一致 exit 1
 *
 * 零凭据：走 raw.githubusercontent.com，不带 token、不用 gh CLI。
 * blob sha = sha1("blob <size>\0" + bytes)，即 git 对象 id；docs/opencode-assets.md
 * 里已记录的 14 行必须逐条命中，否则 exit 1（不允许"更新锁了事"）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const docs = path.join(repoRoot, 'docs')
const lockPath = path.join(docs, 'opencode-assets.lock.json')
const TAG = 'v2.2.3'
const REPO = 'sst/opencode'
const check = process.argv.includes('--check')

const upstreamDir = [
  process.env.UPSTREAM_DIR,
  path.join(repoRoot, 'upstream'),
  path.resolve(repoRoot, '..', 'upstream'),
].filter(Boolean).find(dir => fs.existsSync(path.join(dir, 'scripts', 'fetch-opencode-assets.mjs')))
if (!upstreamDir) {
  console.error('找不到 upstream 检出：设 UPSTREAM_DIR，或让仓库根/上一级存在 upstream/')
  process.exit(2)
}
const fetchScript = path.join(upstreamDir, 'scripts', 'fetch-opencode-assets.mjs')
if (!fs.existsSync(fetchScript)) {
  console.error(`缺 ${fetchScript}（需要只读的 upstream 检出）`)
  process.exit(2)
}
const source = fs.readFileSync(fetchScript, 'utf8')
const files = [...source.match(/const FILES = \[([\s\S]*?)\]/, 's')?.[1]?.matchAll(/'([^']+)'/g) ?? []].map(m => m[1])
if (files.length !== 23) { console.error(`FILES 解析出 ${files.length} 个，期望 23`); process.exit(2) }

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'asset-lock-'))
const gitBlob = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

const filesOut = {}
for (const rel of files) {
  const target = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const url = `https://raw.githubusercontent.com/${REPO}/${TAG}/${rel}`
  execFileSync('curl', ['-s', '-f', '-L', '-o', target, url], { stdio: ['ignore', 'ignore', 'pipe'] })
  const bytes = fs.readFileSync(target)
  filesOut[rel] = {
    blobSha: gitBlob(bytes),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}

const documented = new Map()
for (const m of fs.readFileSync(path.join(upstreamDir, 'docs', 'opencode-assets.md'), 'utf8').matchAll(/^\| `([^`]+)` \| `([0-9a-f]{40})` \|$/gm)) documented.set(m[1], m[2])
let match = 0
const mismatch = []
for (const [rel, sha] of documented) {
  if (filesOut[rel]?.blobSha === sha) match++
  else mismatch.push({ rel, documented: sha, recomputed: filesOut[rel]?.blobSha ?? null })
}

const lock = {
  schemaVersion: 1,
  repo: REPO,
  tag: TAG,
  source: `anonymous https://raw.githubusercontent.com/${REPO}/${TAG}/<path> (no token, no gh CLI)`,
  blobShaAlgorithm: 'sha1("blob <size>\\0" + bytes) — the git object id',
  files: filesOut,
}

console.log(`files=${files.length} documented=${documented.size} match=${match} mismatch=${mismatch.length}`)
if (mismatch.length) { console.log(JSON.stringify(mismatch, null, 2)); process.exit(1) }

if (check) {
  const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const same = JSON.stringify(existing.files) === JSON.stringify(lock.files)
  console.log(same ? `LOCK: unchanged (${path.relative(repoRoot, lockPath)})` : 'LOCK: DIFFERS — 锁与官方源不一致')
  process.exit(same ? 0 : 1)
}

fs.mkdirSync(docs, { recursive: true })
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
console.log(`WROTE ${path.relative(repoRoot, lockPath)}`)
