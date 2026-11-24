// @ts-check
// The stage-2 new-line policy, in machine form.
//
// The keep-list is a kept closure: the strip deletes, it does not add. But a
// commit range that is 892 deletions cannot be read by eye, and "we only deleted
// things" is exactly the sort of claim this project refuses to take on trust. So
// the ruling is written as a classification, and every path that gained a line
// has to fall into one of the allowed classes:
//
//   tool                scripts/ docs/ .github/ gates/ acceptance/ tools/ — the
//                       gates, tests, declarations and workflows themselves
//   product-metadata    package.json README.md .gitignore LICENSE — the package's
//                       own spelling of itself, never upstream code
//   declared-adaptation a file carried from upstream that docs/adaptations.json
//                       declares rewritten, with a reason. The checker
//                       (scripts/check-extraction.mjs) already refuses a
//                       declaration whose bytes did not actually change
//   new-module          a file that did not exist at the base commit, and that
//                       gates/extraction-whitelist.json lists as a shipped
//                       module — today only src/gateway.js
//
// Anything else that gained a line is a FAIL: a carried-over upstream file with
// no declaration, or a module that is on nobody's list. Deletions are never
// restricted — deleting is the point of the stage.
//
// Exit codes, same discipline as the other gates: 0 PASS, 1 FAIL (paths named),
// 2 the checker could not run (no base commit, bad arguments, no git).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const ROOT = resolve(argv.find(a => a.startsWith('--root='))?.slice('--root='.length) ?? process.cwd())
const flag = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(`--${name}=`.length)
}

const die = message => {
  console.error(`check-newline-policy: ${message}`)
  process.exit(2)
}
const readJson = path => {
  if (!existsSync(path)) die(`missing ${path}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { die(`${path} is not JSON: ${error.message}`) }
}

const WHITELIST = join(ROOT, 'gates/extraction-whitelist.json')
const ADAPTATIONS = join(ROOT, 'docs/adaptations.json')

const whitelist = existsSync(WHITELIST) ? readJson(WHITELIST) : die('missing gates/extraction-whitelist.json')
const adaptations = existsSync(ADAPTATIONS) ? readJson(ADAPTATIONS) : { adapted: [], removed: [] }

// The two path lists live in gates/extraction-whitelist.json, so the ruling has
// one source and the document quotes it rather than repeating it. A class this
// gate does not implement is a FAIL: a typo must not silently widen the allowlist.
const KNOWN_CLASSES = new Set(['tool', 'productMetadata'])
const CLASSES = whitelist.newLinePolicy?.classes
if (!CLASSES || typeof CLASSES !== 'object') {
  die('gates/extraction-whitelist.json has no newLinePolicy.classes — the paths this rule allows must be declared there')
}
for (const name of Object.keys(CLASSES)) {
  if (!KNOWN_CLASSES.has(name)) die(`newLinePolicy.classes has an unknown class ${JSON.stringify(name)}; known: ${[...KNOWN_CLASSES].join(', ')}`)
}
const TOOL_PREFIXES = CLASSES.tool ?? []
const PRODUCT_FILES = CLASSES.productMetadata ?? []
if (TOOL_PREFIXES.length === 0) die('newLinePolicy.classes.tool is empty — every path would be a violation')
if (PRODUCT_FILES.length === 0) die('newLinePolicy.classes.productMetadata is empty — package.json could never change')
const MODULE_DIRS = ['src/']

const isTool = path => TOOL_PREFIXES.some(prefix => path.startsWith(prefix))
const isProductFile = path => PRODUCT_FILES.includes(path)
const isModule = path => MODULE_DIRS.some(prefix => path.startsWith(prefix))

let git
try {
  git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' })
} catch {
  die(`${ROOT} is not a git checkout — this rule compares two commits, it cannot be judged from files alone`)
}

const base = flag('base') ?? whitelist.baselineImport?.commit
const head = flag('head') ?? 'HEAD'
if (!base) die('no base commit: pass --base=<sha> or record baselineImport.commit in the whitelist')

for (const ref of [base, head]) {
  try {
    git('rev-parse', '--verify', `${ref}^{commit}`)
  } catch {
    die(`commit ${ref} is not in this clone. A shallow checkout hides it: fetch the full history, or pass --base for a commit you have`)
  }
}

const resolvedBase = git('rev-parse', base).trim()
const resolvedHead = git('rev-parse', head).trim()

// Not `--name-only`: the git build this team runs on (libgit2 shim, 2.47.0) ignores
// the flag and still prints `mode SP type SP sha TAB path`, which silently turned every
// path into "100644 blob …" the first time this gate was written. Reading the last
// tab-separated field gives the path whether or not the flag is honoured.
const treePaths = ref => git('ls-tree', '-r', ref)
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => {
    const tab = line.indexOf('\t')
    return tab === -1 ? line : line.slice(tab + 1)
  })
const basePaths = new Set(treePaths(base))

const adaptedPaths = new Map()
for (const item of adaptations.adapted ?? []) {
  if (!item.path) die('docs/adaptations.json has an adapted entry with no path')
  adaptedPaths.set(item.path, item)
}
const removedPaths = new Set((adaptations.removed ?? []).map(item => item.path).filter(Boolean))
const whitelistedModules = new Set([
  ...(whitelist.imported?.files ?? []),
  ...(whitelist.publicExports?.entry ? [whitelist.publicExports.entry] : [])
])

// --- the diff ----------------------------------------------------------------

const raw = git('diff', '--numstat', '--no-renames', resolvedBase, resolvedHead)
const rows = []
const binary = []
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  const [addedRaw, deletedRaw, path] = line.split('\t')
  if (!path) die(`cannot parse numstat line: ${JSON.stringify(line)}`)
  if (addedRaw === '-' || deletedRaw === '-') { binary.push(path); continue }
  rows.push({ path, added: Number(addedRaw), deleted: Number(deletedRaw) })
}

const fail = []
const buckets = {
  tool: [],
  'product-metadata': [],
  'declared-adaptation': [],
  'new-module': [],
  'new-file': [],
  offending: [],
}

for (const row of rows) {
  if (row.added === 0) continue
  const { path, added } = row
  if (isTool(path)) { buckets.tool.push({ path, added }); continue }
  if (isProductFile(path)) { buckets['product-metadata'].push({ path, added }); continue }
  if (basePaths.has(path)) {
    const adapted = adaptedPaths.get(path)
    if (adapted && String(adapted.reason ?? '').trim() !== '') { buckets['declared-adaptation'].push({ path, added }); continue }
    if (adapted) { fail.push(`${path}: +${added} lines, declared adapted in docs/adaptations.json but with no reason`); continue }
    if (removedPaths.has(path)) { fail.push(`${path}: +${added} lines, but docs/adaptations.json declares it removed`); continue }
    fail.push(`${path}: +${added} lines in a file carried over from the base commit, and docs/adaptations.json declares no adaptation`)
    buckets.offending.push({ path, added, why: 'carried over, undeclared' })
    continue
  }
  if (isModule(path)) {
    if (!whitelistedModules.has(path)) {
      fail.push(`${path}: +${added} lines, a new module that gates/extraction-whitelist.json does not list`)
      buckets.offending.push({ path, added, why: 'new module off the whitelist' })
      continue
    }
    buckets['new-module'].push({ path, added })
    continue
  }
  buckets['new-file'].push({ path, added })
}

// A module on the whitelist that does not exist yet is the mirror image of an
// undeclared one: the list would be describing a product that is not here.
for (const path of whitelistedModules) {
  if (!existsSync(join(ROOT, path))) fail.push(`${path} is on the whitelist but does not exist in the working tree`)
}

const sum = list => list.reduce((total, item) => total + item.added, 0)
const summary = {
  base: resolvedBase,
  head: resolvedHead,
  classes: { tool: TOOL_PREFIXES, productMetadata: PRODUCT_FILES },
  addedTotal: rows.reduce((total, row) => total + row.added, 0),
  deletedTotal: rows.reduce((total, row) => total + row.deleted, 0),
  buckets: Object.fromEntries(Object.entries(buckets).map(([name, list]) => [name, { paths: list.length, added: sum(list), list }])),
  binarySkipped: binary,
  verdict: fail.length === 0 ? 'PASS' : 'FAIL',
  fail,
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(fail.length === 0 ? 0 : 1)
}

console.log(`base ${resolvedBase.slice(0, 7)} .. head ${resolvedHead.slice(0, 7)}`)
console.log(`lines: +${summary.addedTotal} / -${summary.deletedTotal} across ${rows.length} path(s)`)
console.log(`classes: tool [${TOOL_PREFIXES.join(' ')}]`)
console.log(`         product-metadata [${PRODUCT_FILES.join(' ')}]`)
console.log(`         declared-adaptation ${adaptedPaths.size} declared; a novel src/ module must be one of the ${whitelistedModules.size} modules on the whitelist`)
for (const [name, bucket] of Object.entries(summary.buckets)) {
  if (bucket.paths === 0) continue
  console.log(`  ${name.padEnd(19)} +${String(bucket.added).padStart(4)}  ${bucket.paths} path(s)`)
  for (const item of bucket.list) console.log(`      ${item.path} +${item.added}`)
}
if (binary.length) console.log(`  binary (not counted): ${binary.join(', ')}`)
for (const line of fail) console.log(`FAIL ${line}`)
console.log(`NEWLINE POLICY: ${summary.verdict}`)
process.exit(fail.length === 0 ? 0 : 1)
