// @ts-check
// The stage-2 extraction gate: the package keeps the free lane and a local
// OpenAI-compatible gateway, and nothing else.
//
// Judged by reading the tree, never by eye. Four independent families of check,
// because each one alone has a way to look green while being wrong:
//
//   1. import set      — every declared imported file still hashes to the blob
//                        the pin names, and imported + excluded partition the
//                        upstream file count. A tampered import is caught here.
//   2. excluded reach  — no shipped module imports an excluded path. This is
//                        the machine form of "no account channels were carried
//                        along": the excluded half contains every channel
//                        adapter, so an import into it is a hit.
//   3. public surface  — the entry exports exactly the whitelisted symbols, and
//                        the package exports only its root entry. An extra
//                        export is a FAIL even if nothing calls it.
//   4. no leftovers    — no shipped file mentions the removed surfaces (admin
//                        page, statistics routes, EAC, the ten-channel table),
//                        and no file is left unreachable inside src/.
//   5. two copies      — gates/extraction-whitelist.json's shipped lists say,
//                        file by file, which imported files are byte-identical,
//                        adapted or removed; docs/adaptations.json says the same
//                        in prose. Two copies of one verdict must agree, or the
//                        copy nobody reads is how a rewrite gets called verbatim.
//
// Exit codes: 0 PASS, 1 FAIL (hits listed), 2 the checker could not run
// (missing manifest/entry, bad arguments). A caller that treats any non-zero as
// FAIL is right; a caller that treats only 1 as FAIL will miss a broken run.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const ROOT = resolve(argv.find(a => a.startsWith('--root='))?.slice('--root='.length) ?? process.cwd())
const WHITELIST = join(ROOT, 'gates/extraction-whitelist.json')
const MANIFEST = join(ROOT, 'docs/baseline-exclusions.json')
const ADAPTATIONS = join(ROOT, 'docs/adaptations.json')
const PKG = join(ROOT, 'package.json')

/** Where the shipped code lives; documentation may describe what was removed. */
const SHIPPED_DIRS = ['src', 'scripts']
const SHIPPED_FILES = ['package.json']

const fail = [], note = []
const hits = []
const hit = (family, path, detail) => hits.push({ family, path, detail })

function die(message) {
  console.error(`check-extraction: ${message}`)
  process.exit(2)
}

const readJson = path => {
  if (!existsSync(path)) die(`missing ${relative(ROOT, path)}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { die(`${relative(ROOT, path)} is not JSON: ${error.message}`) }
}

const whitelist = readJson(WHITELIST)
const manifest = readJson(MANIFEST)

if (!existsSync(PKG)) die('missing package.json')
const pkg = readJson(PKG)
const entry = whitelist.publicExports?.entry ?? 'src/gateway.js'
if (!existsSync(join(ROOT, entry))) die(`entry ${entry} does not exist — nothing to read the exports from`)

// --- files under the shipped directories -------------------------------------

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
const shippedFiles = SHIPPED_DIRS.flatMap(dir => walk(join(ROOT, dir)))
  .concat(SHIPPED_FILES.map(f => join(ROOT, f)).filter(existsSync))
const rel = path => relative(ROOT, path).split(sep).join('/')
const readText = path => readFileSync(path, 'utf8')

/** git's own object id for a file: sha1("blob <bytes>\0" + content). */
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

// --- 1. import set ------------------------------------------------------------

const adaptations = existsSync(ADAPTATIONS) ? readJson(ADAPTATIONS) : { adapted: [], removed: [] }
const adaptedPaths = new Map((adaptations.adapted ?? []).map(item => [item.path, item]))
const removedPaths = new Map((adaptations.removed ?? []).map(item => [item.path, item]))
const imported = manifest.imported?.entries ?? die('manifest has no imported.entries')
const excluded = manifest.exclusions ?? die('manifest has no exclusions')
const upstreamFiles = manifest.upstream?.files

// Three states per imported file, and each one is declared in
// docs/adaptations.json rather than decided here:
//   untouched  the bytes are still the pinned upstream bytes
//   adapted    rewritten on purpose; the declaration says why, and an
//              unchanged file under that heading is a lie the checker catches
//   removed    the file is gone; it must not reappear
for (const item of imported) {
  if (!item.path || !item.blob || !Number.isInteger(item.bytes)) { fail.push(`manifest entry is malformed: ${JSON.stringify(item)}`); continue }
  const path = join(ROOT, item.path)
  const adapted = adaptedPaths.get(item.path)
  const removed = removedPaths.get(item.path)
  if (adapted && removed) { fail.push(`${item.path} is declared both adapted and removed`); continue }
  if (removed) {
    if (existsSync(path)) fail.push(`${item.path} is declared removed but still exists`)
    continue
  }
  if (!existsSync(path)) { fail.push(`imported file is missing and not declared removed: ${item.path}`); continue }
  const bytes = readFileSync(path)
  const blob = gitBlob(bytes)
  if (adapted) {
    if (adapted.baselineBlob !== item.blob) fail.push(`${item.path}: adaptation declares baseline ${adapted.baselineBlob}, manifest pins ${item.blob}`)
    if (!adapted.reason || String(adapted.reason).trim() === '') fail.push(`${item.path}: adapted without a reason`)
    if (blob === item.blob) fail.push(`${item.path} is declared adapted but is still byte-identical — drop the declaration`)
    continue
  }
  if (bytes.length !== item.bytes) fail.push(`${item.path}: ${bytes.length} bytes on disk, manifest declares ${item.bytes}`)
  if (blob !== item.blob) fail.push(`${item.path}: blob ${blob} != pinned ${item.blob}, and no adaptation is declared`)
}
const importedPaths = new Set(imported.map(i => i.path))
const excludedPaths = new Set(excluded.map(e => e.path))
for (const path of importedPaths) if (excludedPaths.has(path)) fail.push(`${path} is both imported and excluded`)
if (Number.isInteger(upstreamFiles) && importedPaths.size + excludedPaths.size !== upstreamFiles) {
  fail.push(`partition does not cover the upstream tree: ${importedPaths.size} imported + ${excludedPaths.size} excluded != ${upstreamFiles}`)
}
if (importedPaths.size === 0) fail.push('the manifest imports nothing — that cannot be the kept closure')

// --- 2. excluded paths must not be reached -----------------------------------

const IMPORT_RE = /(?:^|[^.\w])(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(file) {
  const text = readText(file)
  const specs = []
  let match
  IMPORT_RE.lastIndex = 0
  while ((match = IMPORT_RE.exec(text))) {
    const spec = match[1] ?? match[2]
    if (spec.startsWith('.')) specs.push(spec)
  }
  return specs
}

function resolveSpec(file, spec) {
  let target = normalize(join(dirname(file), spec))
  if (!/\.[cm]?js$/.test(target)) target += '.js'
  return target
}

const unresolved = []
const edges = new Map()
for (const file of shippedFiles.filter(f => /\.(mjs|cjs|js)$/.test(f))) {
  const out = []
  for (const spec of importsOf(file)) {
    const target = resolveSpec(file, spec)
    if (!existsSync(target)) { unresolved.push(`${rel(file)} -> ${spec}`); continue }
    out.push(target)
    const targetRel = rel(target)
    if (excludedPaths.has(targetRel)) hit('excluded-reachable', rel(file), `imports excluded path ${targetRel}`)
    if (/^src\/(accounts|providers)\//.test(targetRel) || /^src\/eac/.test(targetRel) || /^worker\//.test(targetRel)) {
      hit('forbidden-reachable', rel(file), `imports removed surface ${targetRel}`)
    }
  }
  edges.set(file, out)
}
for (const path of importedPaths) {
  if (/^src\/(accounts|providers)\//.test(path) || /^src\/eac/.test(path) || /^worker\//.test(path)) {
    hit('forbidden-import', path, 'a removed surface is on the import set')
  }
}
for (const line of unresolved) fail.push(`unresolved relative import: ${line}`)

// --- 3. reachability from real roots, and the public surface -----------------

const roots = [join(ROOT, entry)]
for (const dir of ['scripts']) {
  for (const file of walk(join(ROOT, dir))) if (/\.(mjs|cjs|js)$/.test(file)) roots.push(file)
}
const reached = new Set()
const queue = [...roots]
while (queue.length) {
  const file = queue.shift()
  if (reached.has(file) || !existsSync(file)) continue
  reached.add(file)
  for (const next of edges.get(file) ?? []) queue.push(next)
}
for (const file of shippedFiles) {
  const path = rel(file)
  if (!path.startsWith('src/')) continue
  if (!reached.has(file)) fail.push(`dead file: ${path} is not reachable from the entry or a check script — delete it instead of leaving it`)
}

const entryExports = Object.keys(await import(pathToFileURL(join(ROOT, entry)).href)).sort()
const allowed = [...(whitelist.publicExports?.symbols ?? [])].sort()
for (const name of entryExports) if (!allowed.includes(name)) fail.push(`extra public export: ${name} in ${entry}`)
for (const name of allowed) if (!entryExports.includes(name)) fail.push(`missing public export: ${name} in ${entry}`)

const declaredExports = Object.keys(pkg.exports ?? {})
if (declaredExports.join(',') !== Object.keys(whitelist.publicExports?.packageJsonExports ?? {}).join(',')) {
  fail.push(`package.json exports keys ${JSON.stringify(declaredExports)} != whitelist ${JSON.stringify(Object.keys(whitelist.publicExports?.packageJsonExports ?? {}))}`)
}
for (const [key, value] of Object.entries(whitelist.publicExports?.packageJsonExports ?? {})) {
  if (pkg.exports?.[key] !== value) fail.push(`package.json exports["${key}"] = ${JSON.stringify(pkg.exports?.[key])}, whitelist says ${JSON.stringify(value)}`)
}

// src/ may only hold the whitelisted modules: anything else is a carried-over
// file, and "清单外多一个就 FAIL" is the rule the planner froze.
const modules = new Set([...(whitelist.imported?.files ?? []), ...(whitelist.publicExports?.entry ? [whitelist.publicExports.entry] : [])])
for (const file of shippedFiles) {
  const path = rel(file)
  if (path.startsWith('src/') && !modules.has(path)) fail.push(`module outside the whitelist: ${path}`)
  if (!path.startsWith('src/')) continue
  if (path.split('/').length > 2) fail.push(`nested module not on the whitelist: ${path}`)
}

// --- 4. no leftovers ----------------------------------------------------------

// What a leftover looks like from the machine's side. Two different rules, on
// purpose:
//
//   * written files (the entry and anything this package authored) are scanned
//     for the removed surfaces: an admin or statistics route, a credential-shaped
//     config name, a channel provider, an EAC identifier;
//   * untouched imported files are NOT scanned for words. Their bytes are pinned
//     by the blob check above, and upstream prose mentioning an old subsystem is
//     not a code path. Scanning them for words would fail on a comment and pass on
//     a live route, which is exactly backwards.
const WRITTEN = new Set([
  entry,
  ...(adaptedPaths.keys()),
])
const SCANNERS = new Set(['scripts/check-extraction.mjs'])

/** @type {Array<[RegExp, string]>} */
const MARKERS = [
  [/\bsrc\/accounts\b/, 'an account-channel path'],
  [/\b(?:ADMIN_TOKEN|SIGNING_SECRETS|UPSTREAM_API_KEY)\b/, 'a credential-shaped config name'],
  [/['"`]\/(?:stats|admin|dashboard)\b/i, 'an admin or statistics route'],
  [/\b(?:cline|lobsterai|loomy|minimax|qoder|raccoon|trae|zcode)\b/, 'a channel provider'],
  [/\bprovider(?:Id|Registry)\b/, 'a provider registry'],
  [/\beac\b/i, 'EAC'],
]
// "Not deleted, just commented out" has a shape: a comment that still reads as a
// declaration or a call.
const COMMENTED_CODE = /^\s*\/\/\s*(?:import|export|const|let|var|function|return|if\s*\(|app\.|router\.|server\.)/
const DISABLED = /\bif\s*\(\s*false\s*\)/

for (const file of shippedFiles) {
  const path = rel(file)
  if (!/\.(mjs|cjs|js)$/.test(path)) continue
  if (SCANNERS.has(path) || path.startsWith('scripts/tests/')) continue
  const isWritten = WRITTEN.has(path)
  const lines = readText(file).split('\n')
  lines.forEach((line, index) => {
    if (isWritten) {
      for (const [re, label] of MARKERS) {
        if (re.test(line)) { hit('marker', path, `${label} at line ${index + 1}`); break }
      }
      if (COMMENTED_CODE.test(line)) fail.push(`${path}:${index + 1} commented-out code — delete it, do not park it behind a comment`)
    }
    if (DISABLED.test(line)) fail.push(`${path}:${index + 1} an if (false) branch is a disabled code path, not a deletion`)
  })
}

// --- 5. the shipped verdict agrees with the declarations it summarises --------
//
// `shipped` used to be a second opinion nothing read: this script consulted the
// whitelist only for the entry path and the export names, so `src/o2a.js` could
// sit under `verbatim` there while docs/adaptations.json called it adapted and
// both scripts still exited 0. The lists are now compared with the declarations
// they summarise, in both directions. The overlap test needs no second edit to
// bite: one path under "byte-identical" and under "adapted" is a contradiction
// on its own — which is exactly how this drift appeared.
let shippedCompared = false

function judgeShipped(input) {
  shippedCompared = true
  const problems = []
  const { shippedBlock, adaptedList, removedList, importedSet, entryPath, baselineList } = input
  const lists = {}
  for (const key of ['verbatim', 'adapted', 'removed', 'added']) {
    const value = shippedBlock[key]
    if (!Array.isArray(value)) { problems.push(`shipped.${key} is not a list of paths`); lists[key] = null; continue }
    const bad = value.filter(item => typeof item !== 'string')
    if (bad.length) problems.push(`shipped.${key} holds entries that are not paths: ${JSON.stringify(bad)}`)
    lists[key] = new Set(value.filter(item => typeof item === 'string'))
  }
  if (!lists.verbatim || !lists.adapted || !lists.removed) return problems
  const adapted = new Set(adaptedList)
  const removed = new Set(removedList)
  const compare = (label, listed, declared) => {
    for (const path of listed) if (!declared.has(path)) problems.push(`${label}: ${path} is listed there but docs/adaptations.json does not declare it`)
    for (const path of declared) if (!listed.has(path)) problems.push(`${label}: ${path} is declared in docs/adaptations.json but not listed there`)
  }
  compare('shipped.adapted', lists.adapted, adapted)
  compare('shipped.removed', lists.removed, removed)
  for (const path of lists.verbatim) {
    if (adapted.has(path)) problems.push(`shipped.verbatim: ${path} is called byte-identical there and adapted in docs/adaptations.json — one of the two is wrong`)
    else if (removed.has(path)) problems.push(`shipped.verbatim: ${path} is called byte-identical there and removed in docs/adaptations.json`)
  }
  const untouched = new Set([...importedSet].filter(path => !adapted.has(path) && !removed.has(path)))
  for (const path of lists.verbatim) {
    if (adapted.has(path) || removed.has(path)) continue
    if (!untouched.has(path)) problems.push(`shipped.verbatim: ${path} is not an imported file that stayed byte-identical`)
  }
  for (const path of untouched) if (!lists.verbatim.has(path)) problems.push(`shipped.verbatim: ${path} is imported and declared neither adapted nor removed, but the list leaves it out`)
  const baselineSet = new Set(baselineList)
  if (lists.added) {
    const expectedAdded = new Set([...importedSet, ...(entryPath ? [entryPath] : [])].filter(path => !baselineSet.has(path)))
    for (const path of lists.added) if (!expectedAdded.has(path)) problems.push(`shipped.added: ${path} is listed as a new module but is not one the baseline lacks`)
    for (const path of expectedAdded) if (!lists.added.has(path)) problems.push(`shipped.added: ${path} exists in the product and is not on the baseline, but the list leaves it out`)
  }
  for (const path of baselineList) if (!importedSet.has(path)) problems.push(`baselineImport: ${path} is not an imported entry in docs/baseline-exclusions.json`)
  for (const path of importedSet) if (!baselineSet.has(path)) problems.push(`baselineImport: ${path} is imported in docs/baseline-exclusions.json but not listed there`)
  return problems
}

if (whitelist.shipped === undefined || whitelist.shipped === null || typeof whitelist.shipped !== 'object') {
  die('gates/extraction-whitelist.json has no shipped block — the three-state verdict must be declared there, not only in docs/adaptations.json')
}
if (!Array.isArray(whitelist.baselineImport?.entries) || whitelist.baselineImport.entries.some(item => typeof item?.path !== 'string')) {
  die('gates/extraction-whitelist.json has no baselineImport.entries paths — the import set has no second copy to check')
}
const baselineList = whitelist.baselineImport.entries.map(item => item.path)
const shippedProblems = judgeShipped({
  shippedBlock: whitelist.shipped,
  adaptedList: [...adaptedPaths.keys()],
  removedList: [...removedPaths.keys()],
  importedSet: importedPaths,
  entryPath: entry,
  baselineList,
})
for (const problem of shippedProblems) fail.push(problem)
if (!shippedCompared) fail.push('the shipped block was never compared with docs/adaptations.json — the comparison was removed')

// The comparison carries its own tripwire: five cases on synthetic sets, run
// every time this script runs. Deleting the call above leaves `shippedCompared`
// false and the named FAIL right above fires; deleting one direction of the
// comparison leaves its case here red. Neither can go quiet.
{
  const base = {
    shippedBlock: { verbatim: ['a.js'], adapted: ['b.js'], removed: ['c.js'], added: ['d.js'] },
    adaptedList: ['b.js'],
    removedList: ['c.js'],
    importedSet: new Set(['a.js', 'b.js', 'c.js']),
    entryPath: 'd.js',
    baselineList: ['a.js', 'b.js', 'c.js'],
  }
  const cases = [
    { name: 'agreeing lists pass', input: base, want: [] },
    { name: 'a path called byte-identical and adapted is named', input: { ...base, shippedBlock: { ...base.shippedBlock, verbatim: ['a.js', 'b.js'] } }, want: ['b.js'] },
    { name: 'an adaptation the whitelist leaves out is named', input: { ...base, adaptedList: ['b.js', 'x.js'] }, want: ['x.js'] },
    { name: 'an untouched import the whitelist leaves out is named', input: { ...base, importedSet: new Set(['a.js', 'b.js', 'c.js', 'y.js']) }, want: ['y.js'] },
    { name: 'a removal the whitelist leaves out is named', input: { ...base, shippedBlock: { ...base.shippedBlock, removed: [] } }, want: ['c.js'] },
  ]
  for (const test of cases) {
    const got = judgeShipped(test.input)
    const ok = test.want.length
      ? test.want.every(path => got.some(problem => problem.includes(path)))
      : got.length === 0
    if (ok) note.push(`self-case ok: ${test.name}`)
    else fail.push(`self-case ${test.name}: expected ${test.want.length ? `a problem naming ${test.want.join(', ')}` : 'no problem'}, got ${got.length ? JSON.stringify(got) : 'none'}`)
  }
}

// --- report -------------------------------------------------------------------

const result = {
  ok: fail.length === 0 && hits.length === 0,
  importSet: { files: importedPaths.size, excluded: excludedPaths.size, upstreamFiles: upstreamFiles ?? null },
  entry, exports: entryExports, whitelistExportCount: allowed.length,
  adapted: [...adaptedPaths.keys()], removed: [...removedPaths.keys()],
  shipped: {
    verbatim: whitelist.shipped.verbatim.length,
    adapted: whitelist.shipped.adapted.length,
    removed: whitelist.shipped.removed.length,
    comparedWithDeclarations: shippedCompared,
    problems: shippedProblems.length,
  },
  reachableFromEntry: reached.size,
  hits, failures: fail,
}
if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`import set:      ${importedPaths.size} files (blob-verified), ${excludedPaths.size} excluded, upstream ${upstreamFiles ?? '?'}`)
  console.log(`shipped:         ${whitelist.shipped.verbatim.length} verbatim, ${whitelist.shipped.adapted.length} adapted, ${whitelist.shipped.removed.length} removed — compared with docs/adaptations.json, ${shippedProblems.length} problem(s)`)
  console.log(`entry:           ${entry} exports ${entryExports.length} symbol(s): ${entryExports.join(', ')}`)
  console.log(`reachability:    ${reached.size} files reached from the entry and the check scripts`)
  // The artifact the gate wants: every shipped path with the whitelist's verdict
  // on it, one line each, so the comparison is reviewable rather than asserted.
  console.log('tree vs whitelist:')
  for (const file of shippedFiles) {
    const path = rel(file)
    const verdict = path === entry ? 'entry' : modules.has(path) ? 'whitelisted-module' : 'tool'
    console.log(`  ${verdict.padEnd(20)} ${path}`)
  }
  for (const h of hits) console.log(`HIT  ${h.family.padEnd(20)} ${h.path} — ${h.detail}`)
  for (const f of fail) console.log(`FAIL ${f}`)
  if (note.length) for (const n of note) console.log(`note ${n}`)
  console.log(result.ok ? '\nEXTRACTION: PASS' : `\nEXTRACTION: FAIL (${fail.length + hits.length})`)
}
process.exit(result.ok ? 0 : 1)
