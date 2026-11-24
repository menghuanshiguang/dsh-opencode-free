// Checks the anonymously fetched upstream sources against the documented blob SHAs.
//
// The provenance table in `upstream/docs/opencode-assets.md` is the lock: its 14
// rows are the files whose bytes decide the fingerprint (the system prompt and
// the 13 tool definitions). Every row must match the SHA the fetch produced. The
// tool also writes the full lock (all 23 files) as an artifact, because the 9
// files not in the table get confirmed by a human once and pinned after that.
//
//   OFM_ASSET_LOG=<jsonl> node tools/asset-lock.mjs [--write docs/opencode-assets.lock.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { upstreamBase } from './upstream.mjs'

const args = process.argv.slice(2)
const writeAt = args.indexOf('--write') >= 0 ? args[args.indexOf('--write') + 1] : undefined
const logPath = process.env.OFM_ASSET_LOG
if (!logPath || !existsSync(logPath)) {
  console.error(`ASSET-LOCK: FAIL — no fetch log at ${logPath}`)
  process.exit(1)
}

const entries = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const fetched = new Map(entries.filter(entry => entry.ok).map(entry => [entry.path, entry.sha]))
console.log(`fetched files: ${fetched.size} (log lines ${entries.length})`)

// Parse the provenance table: `| \`path\` | \`sha\` |`.
const doc = readFileSync(new URL('docs/opencode-assets.md', upstreamBase), 'utf8')
const rows = [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{40})`\s*\|/gm)].map(match => ({ path: match[1], sha: match[2] }))
console.log(`documented rows: ${rows.length}`)

const failures = []
for (const row of rows) {
  const got = fetched.get(row.path)
  if (!got) { failures.push(`${row.path}: not fetched`); console.log(`FAIL ${row.path} — not fetched`); continue }
  const ok = got === row.sha
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${row.path} ${got}`)
  if (!ok) failures.push(`${row.path}: ${got} != ${row.sha}`)
}

if (writeAt) {
  const lock = {
    repo: 'sst/opencode',
    ref: entries[0]?.ref ?? 'unknown',
    note: 'Blob SHAs of every source the asset builder reads, computed from the bytes received anonymously.',
    files: Object.fromEntries([...fetched].sort(([a], [b]) => a.localeCompare(b))),
  }
  writeFileSync(writeAt, `${JSON.stringify(lock, null, 2)}\n`)
  console.log(`wrote ${writeAt} (${Object.keys(lock.files).length} files)`)
}

if (failures.length) {
  console.error(`\nASSET-LOCK: FAIL (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nASSET-LOCK: PASS (${rows.length}/${rows.length} documented sources match)`)
