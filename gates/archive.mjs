#!/usr/bin/env node
/**
 * gates.json 归档器 —— 每阶段一份，写进仓库的固定路径，成为数字的唯一源。
 *
 *   gates/stage<N>/<runId>-<attempt>.json     不可变档案（写入后置为只读）
 *   gates/stage<N>/index.json                 该阶段的索引（按 runId 升序）
 *
 * 归档前必须先过 gates/validate.mjs：不合规的记录进不了档案。
 * 同一 run 已有不同内容的档案时拒绝覆盖 —— 改数字不能靠再归档一次。
 *
 * 用法：
 *   node gates/archive.mjs --file <gates.json> [--root .] [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const file = arg('--file')
const root = path.resolve(arg('--root') ?? process.cwd())
const dryRun = argv.includes('--dry-run')
const allowSynthetic = argv.includes('--allow-synthetic')
const lockPath = arg('--lock') ?? path.join(root, 'docs', 'fingerprint-baseline.json')
if (!fs.existsSync(lockPath)) {
  console.error(`ARCHIVE REFUSED: 找不到指纹锁 ${lockPath}；0.8 的传递相等链没有锚，不许归档`)
  process.exit(1)
}
const self = fileURLToPath(import.meta.url)
const validator = path.join(path.dirname(self), 'validate.mjs')

if (!file) {
  console.error('usage: node gates/archive.mjs --file <gates.json> [--root .] [--dry-run] [--allow-synthetic]')
  process.exit(2)
}

// 1) 先过校验器（子进程，真实退出码，不复制它的规则）
try {
  execFileSync(process.execPath, [validator, file, '--require-negative-coverage', '--lock', lockPath, ...(allowSynthetic ? ['--allow-synthetic'] : [])], { stdio: 'inherit' })
} catch {
  console.error('ARCHIVE REFUSED: 校验未通过，未写入任何文件')
  process.exit(1)
}

const raw = fs.readFileSync(file, 'utf8')
const doc = JSON.parse(raw)
const fileSha = crypto.createHash('sha256').update(raw).digest('hex')
const stage = String(doc.stage)
const stageDir = path.join(root, 'gates', `stage${stage}`)
const target = path.join(stageDir, `${doc.run.id}-${doc.run.attempt}.json`)
const indexFile = path.join(stageDir, 'index.json')

if (fs.existsSync(target)) {
  const existing = fs.readFileSync(target, 'utf8')
  const existingSha = crypto.createHash('sha256').update(existing).digest('hex')
  if (existingSha === fileSha) {
    console.log(`ALREADY ARCHIVED ${path.relative(root, target)} (${fileSha})`)
    process.exit(0)
  }
  console.error(`ARCHIVE REFUSED: ${path.relative(root, target)} 已存在且内容不同（existing ${existingSha} vs incoming ${fileSha}）`)
  console.error('  档案不可变：要修正数字，重新拿一个 run 的证据，不改旧档案。')
  process.exit(1)
}

if (dryRun) {
  console.log(`DRY-RUN would archive ${path.relative(root, target)} (${fileSha})`)
  process.exit(0)
}

fs.mkdirSync(stageDir, { recursive: true })
fs.writeFileSync(target, raw)
fs.chmodSync(target, 0o444)

let index = { schemaVersion: 1, stage, entries: [] }
if (fs.existsSync(indexFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    if (Array.isArray(parsed?.entries)) index = parsed
  } catch (error) {
    console.error(`ARCHIVE REFUSED: 索引已损坏，不覆盖：${error.message}`)
    process.exit(1)
  }
}

const entry = {
  file: path.relative(root, target),
  runId: doc.run.id,
  attempt: doc.run.attempt,
  archivedAt: new Date().toISOString(),
  sha256: fileSha,
  model: doc.request.model,
  toolsSha256: doc.fingerprint.toolsSha256,
  systemSha256: doc.fingerprint.systemSha256,
  billingSource: doc.response.billingSource,
}
index.entries = index.entries.filter(e => !(e.runId === entry.runId && e.attempt === entry.attempt))
index.entries.push(entry)
index.entries.sort((a, b) => (a.runId - b.runId) || (a.attempt - b.attempt))
fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`)

console.log(`ARCHIVED ${path.relative(root, target)}`)
console.log(`  sha256=${fileSha}`)
console.log(`  index=${path.relative(root, indexFile)} entries=${index.entries.length}`)
