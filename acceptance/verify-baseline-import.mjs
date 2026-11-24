#!/usr/bin/env node
// Independent import check for the kept-closure baseline (acceptance, stage 2).
//
// Judges the declaration, not the implementer's claim:
//   upstream files - docs/baseline-exclusions.json = import set     (set equality)
//   every import member is byte-identical to upstream at the baseline commit
//   at HEAD each import member is verbatim, declared adapted (baselineBlob = upstream), or declared removed
//   no excluded upstream file is reachable from the exported entry, and none is smuggled in byte-identically
//   the public surface is exactly the two kept groups
//
// rc: 0 pass, 1 fail (each failure named), 2 the check itself could not run.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, normalize } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const repoDir = arg('repo', process.cwd());
const upDir = arg('upstream');
const upRef = arg('upstream-ref', 'f29116ba');
const baseRef = arg('baseline');
const headRef = arg('head', 'HEAD');
if (!upDir || !baseRef) {
  console.error('usage: verify-baseline-import.mjs --repo <dir> --upstream <gitdir> --baseline <ref> [--head <ref>] [--upstream-ref <ref>]');
  process.exit(2);
}

let upstream, baselineTree, headTree, readBlobAt;
try {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const treeOf = (cwd, ref) => {
    const m = new Map();
    for (const line of git(cwd, ['ls-tree', '-r', '-l', ref]).split('\n')) {
      if (!line) continue;
      const [meta, path] = line.split('\t');
      const [, , sha, size] = meta.trim().split(/\s+/);
      m.set(path, { sha, size: Number(size) });
    }
    return m;
  };
  upstream = treeOf(upDir, upRef);
  baselineTree = treeOf(repoDir, baseRef);
  headTree = treeOf(repoDir, headRef);
  readBlobAt = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: repoDir, maxBuffer: 1 << 28 });
  if (upstream.size === 0 || headTree.size === 0) throw new Error('empty tree');
} catch (e) {
  console.error(`verify-baseline-import: cannot read the trees: ${e.message}`);
  process.exit(2);
}

const failures = [];
const fail = (m) => failures.push(m);

let exDoc, adapt, pkg;
try {
  exDoc = JSON.parse(readFileSync(join(repoDir, 'docs/baseline-exclusions.json'), 'utf8'));
  adapt = JSON.parse(readFileSync(join(repoDir, 'docs/adaptations.json'), 'utf8'));
  pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
} catch (e) {
  console.error(`verify-baseline-import: cannot read the declarations: ${e.message}`);
  process.exit(2);
}

const exList = exDoc.files ?? exDoc.excluded ?? exDoc.exclusions;
if (!Array.isArray(exList)) { console.error('verify-baseline-import: no exclusion list'); process.exit(2); }

// A. the exclusion declaration itself
const exMap = new Map();
for (const e of exList) {
  const path = e.path ?? e.upstreamPath;
  if (exMap.has(path)) fail(`duplicate exclusion: ${path}`);
  else exMap.set(path, e);
  const up = upstream.get(path);
  if (!up) { fail(`declared exclusion not in upstream: ${path}`); continue; }
  if ((e.blob ?? e.sha ?? e.blobSha) !== up.sha) fail(`exclusion blob != upstream: ${path}`);
  if (Number(e.bytes ?? e.size) !== up.size) fail(`exclusion bytes != upstream: ${path} ${e.bytes ?? e.size} != ${up.size}`);
  if (!String(e.reason ?? '').trim()) fail(`exclusion without a reason: ${path}`);
}

// B. set equality: upstream - excluded = import set
const importSet = [...upstream.keys()].filter((p) => !exMap.has(p));
if (importSet.length + exMap.size !== upstream.size) {
  fail(`set arithmetic broken: ${importSet.length} imported + ${exMap.size} excluded != ${upstream.size} upstream`);
}

// C. the baseline commit holds exactly the import set, byte-identical to upstream
const shadowedBase = [];
for (const p of importSet) {
  const b = baselineTree.get(p);
  if (!b) { fail(`import member missing from baseline ${baseRef}: ${p}`); continue; }
  if (b.sha !== upstream.get(p).sha) fail(`import member not verbatim at baseline: ${p} ${b.sha.slice(0, 8)} != ${upstream.get(p).sha.slice(0, 8)}`);
}
for (const p of baselineTree.keys()) {
  const up = upstream.get(p);
  if (!up || importSet.includes(p)) continue;
  if (baselineTree.get(p).sha === up.sha) fail(`excluded upstream file imported verbatim at baseline: ${p}`);
  else shadowedBase.push(p);
}

// D. at HEAD: verbatim, declared adapted, or declared removed
const adapted = new Map((adapt.adapted ?? []).map((a) => [a.path, a]));
const removed = new Map((adapt.removed ?? []).map((a) => [a.path, a]));
const verbatim = [], changed = [], gone = [];
for (const p of importSet) {
  const up = upstream.get(p);
  const h = headTree.get(p);
  if (!h) {
    if (!removed.has(p)) fail(`import member vanished without a declaration: ${p}`);
    else gone.push(p);
    continue;
  }
  if (h.sha === up.sha) { verbatim.push(p); continue; }
  const a = adapted.get(p);
  if (!a) { fail(`import member changed without a declaration: ${p}`); continue; }
  if (a.baselineBlob !== up.sha) fail(`adaptation baselineBlob != upstream: ${p}`);
  if (!String(a.reason ?? '').trim()) fail(`adaptation without a reason: ${p}`);
  changed.push(p);
}
for (const [p, a] of removed) {
  if (headTree.has(p)) fail(`declared removed but shipped: ${p}`);
  if (!upstream.has(p)) fail(`declared removed but not in upstream: ${p}`);
  if (!String(a.reason ?? '').trim()) fail(`removal without a reason: ${p}`);
}
for (const [p] of adapted) if (!upstream.has(p)) fail(`adaptation is not an upstream file: ${p}`);

// E. no undeclared verbatim import: a HEAD file equal to upstream must be in the import set
for (const [p, h] of headTree) {
  const up = upstream.get(p);
  if (up && h.sha === up.sha && !importSet.includes(p)) fail(`head carries an undeclared verbatim upstream file: ${p}`);
}

// F. reachability from the exported entry; nothing excluded may be reached
const entry = String(pkg.exports?.['.'] ?? pkg.main ?? '').replace(/^\.\//, '');
if (!entry || !headTree.has(entry)) fail(`entry not shipped: ${entry || '(none)'}`);
const reached = new Set(), excludedHits = [], unresolved = [], dynamic = [];
const resolveSpec = (from, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec));
  for (const cand of [base, `${base}.js`, join(base, 'index.js')]) {
    if (headTree.has(cand)) return { path: cand };
    if (exMap.has(cand)) return { excluded: cand };
  }
  return { missing: base };
};
if (entry && headTree.has(entry)) {
  (function walk(p) {
    if (reached.has(p)) return;
    reached.add(p);
    const src = readBlobAt(headRef, p).toString('utf8');
    const specs = [
      ...[...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ];
    for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) dynamic.push(`${p} -> ${m[1]}`);
    for (const spec of specs) {
      const r = resolveSpec(p, spec);
      if (!r) continue;
      if (r.excluded) excludedHits.push(`${p} -> ${r.excluded}`);
      else if (r.missing) unresolved.push(`${p} -> ${r.missing}`);
      else walk(r.path);
    }
  })(entry);
}
for (const m of excludedHits) fail(`excluded file reachable from the entry: ${m}`);
for (const m of unresolved) fail(`unresolved relative import: ${m}`);
for (const m of dynamic) fail(`dynamic import needs a human look: ${m}`);

// G. the public surface is the two kept groups and nothing else
let gw = '';
try { gw = readBlobAt(headRef, entry).toString('utf8'); } catch { /* already failed above */ }
const exportNames = [...gw.matchAll(/(?:^|\n)export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
if (/\nexport\s+default\b/.test(gw)) fail('default export present');
const allowed = new Set(['createGateway', 'startGateway']);
for (const n of exportNames) if (!allowed.has(n)) fail(`extra public export: ${n}`);
const routes = [...gw.matchAll(/(?:pathname|path)\s*===\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
for (const r of routes) if (/stats|admin|dashboard|accounts|eac/i.test(r)) fail(`management route present: ${r}`);

const verdict = failures.length === 0;
console.log(JSON.stringify({
  refs: { upstream: upRef, baseline: baseRef, head: headRef },
  upstreamFiles: upstream.size,
  set: { imported: importSet.length, excluded: exMap.size, sum: importSet.length + exMap.size },
  baseline: { upstreamPaths: [...baselineTree.keys()].filter((p) => upstream.has(p)).length, shadowed: shadowedBase },
  head: { verbatim, adapted: changed, removed: gone },
  reachability: { entry, reached: [...reached].sort(), excludedHits, unresolved, dynamic },
  exports: exportNames,
  routes,
  failures,
  VERDICT: verdict ? 'PASS' : 'FAIL',
}, null, 2));
console.log(verdict
  ? `BASELINE-IMPORT: PASS (${importSet.length} imported + ${exMap.size} declared excluded = ${upstream.size} upstream files)`
  : `BASELINE-IMPORT: FAIL (${failures.length})`);
process.exit(verdict ? 0 : 1);
