// The seal script's ONLINE branch, executed for real against a stand-in API.
//
// Why this file exists: the online branch of scripts/seal-live-run.sh — fetch
// the run, pick the artifact, download its zip, unpack it — had never been run
// end to end by anyone. 验收员 could not run it (no `unzip` on that machine) and
// the implementation was only checked two weaker ways: reading the code, and
// lifting the `node -e` selector out of the file and feeding it five lists. Both
// are honest evidence about the selector and no evidence at all about the wiring
// around it: which artifact the script actually asks the API for, and whether a
// list holding both `archive-<id>` and `live-<id>` still gets through.
//
// So this test starts a real local HTTP server that plays GitHub, points the
// script at it with GITHUB_API_URL, and asserts on what the script *requested*,
// not on what a helper function returned. The zip in the fixture is deliberately
// incomplete (no live.json), so the archive tail that follows exits 2 at its
// payload check: the subject here is the selection, and the archive itself is
// covered by gates/check-archive-script.mjs.
//
// The zip is built with python3's zipfile because `zip` is not installed
// everywhere, while python3 is on every runner this repository uses. A missing
// python3 is a failure, not a skip: a skipped case here is the same silence this
// file was written to end.

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts/seal-live-run.sh')
const RUN_ID = '45406791349'
const LIVE_ID = 14925976888
const ARCHIVE_ID = 14926406510

/** One throwaway directory for this file; the seal script writes into a subdir of it. */
const scratch = mkdtempSync(join(tmpdir(), 'seal-online-'))

/**
 * A zip holding one file, built by python3. The content does not matter: the
 * archive tail refuses a payload without live.json, and this test is about which
 * artifact was fetched.
 */
function makeZip(name, entries) {
  const py = [
    'import sys, zipfile',
    'path, base = sys.argv[1], sys.argv[2]',
    'names = sys.argv[3:]',
    'with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:',
    '    for n in names:',
    '        z.write(base + "/" + n, n)',
  ].join('\n')
  const base = mkdtempSync(join(scratch, 'payload-'))
  for (const entry of entries) writeFileSync(join(base, entry), `fixture ${entry}\n`)
  const path = join(scratch, name)
  const built = spawnSync('python3', ['-c', py, path, base, ...entries], { encoding: 'utf8' })
  assert.equal(built.error ?? null, null, `python3 could not start: ${built.error?.message ?? ''}`)
  assert.equal(built.status, 0, `python3 could not build the fixture zip: ${built.stderr ?? ''}`)
  assert.ok(readFileSync(path).length > 0, 'the fixture zip is empty')
  return path
}

/**
 * A GitHub stand-in: the three API documents the script asks for, the artifact
 * zip, and a log of every request it received.
 */
function startFakeApi({ artifacts, zipPath }) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    const send = (code, body, type = 'application/json') => {
      // connection: close keeps a lingering keep-alive socket from holding the
      // test process open after the assertions are done.
      res.writeHead(code, { 'content-type': type, connection: 'close' })
      res.end(body)
    }
    if (req.url === `/repos/o/r/actions/runs/${RUN_ID}`) {
      return send(200, JSON.stringify({ id: Number(RUN_ID), status: 'completed', conclusion: 'success' }))
    }
    if (req.url === `/repos/o/r/actions/runs/${RUN_ID}/jobs`) {
      return send(200, JSON.stringify({ jobs: [] }))
    }
    if (req.url === `/repos/o/r/actions/runs/${RUN_ID}/artifacts`) {
      return send(200, JSON.stringify({ artifacts }))
    }
    if (req.url === '/repos/o/r') {
      return send(200, JSON.stringify({ private: false, visibility: 'public', default_branch: 'main' }))
    }
    const zip = /^\/repos\/o\/r\/actions\/artifacts\/(\d+)\/zip$/.exec(req.url ?? '')
    if (zip) {
      if (Number(zip[1]) === LIVE_ID) return send(200, readFileSync(zipPath), 'application/zip')
      return send(404, '{}')
    }
    return send(404, '{}')
  })
  return new Promise(resolvePromise => {
    server.listen(0, '127.0.0.1', () => {
      // unref: a server nobody closes must not be able to hang the runner.
      server.unref()
      resolvePromise({ server, seen, port: server.address().port })
    })
  })
}

/**
 * Run the seal script through one `sh -c` string.
 *
 * Not a style choice: on some platforms spawnSync hands a child only its first
 * two arguments (`bash -c 'echo $#' a b c` prints 0 there), so an argv array
 * silently loses the run id and the output directory. A single command string
 * with quoted paths behaves the same everywhere.
 */
function seal(port, out) {
  const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`
  const command = [
    `export GITHUB_API_URL=${q(`http://127.0.0.1:${port}`)}`,
    `export GITHUB_TOKEN=${q('test-fixture-not-a-credential')}`,
    `export GITHUB_REPOSITORY=${q('o/r')}`,
    `exec bash ${q(SCRIPT)} ${q(RUN_ID)} --out ${q(out)}`,
  ].join('; ')
  const result = spawnSync('sh', ['-c', command], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const artifact = (id, name) => ({
  id,
  name,
  digest: `sha256:${String(id).padStart(8, '0')}`,
  size_in_bytes: 1,
  expired: false,
  retention_days: name.startsWith('archive-') ? 90 : 30,
})

const zipPath = makeZip('artifact.zip', ['placeholder.txt'])

test('online pick: a list holding archive- and live- fetches live-, never archive-', async () => {
  const api = await startFakeApi({
    artifacts: [artifact(ARCHIVE_ID, `archive-${RUN_ID}`), artifact(LIVE_ID, `live-${RUN_ID}`)],
    zipPath,
  })
  try {
    const out = join(scratch, 'case-both')
    const run = seal(api.port, out)
    const line = run.stdout.split('\n').find(l => l.startsWith('sealed inputs:'))
    assert.ok(
      line,
      `the script never reached the download line.\nrc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    )
    assert.match(line, new RegExp(`artifact id=${LIVE_ID}`), `it bound the wrong artifact: ${line}`)
    assert.match(line, new RegExp(`name=live-${RUN_ID}`), `it bound the wrong name: ${line}`)

    const zipRequests = api.seen.filter(url => url.startsWith('/repos/o/r/actions/artifacts/'))
    assert.deepEqual(
      zipRequests,
      [`/repos/o/r/actions/artifacts/${LIVE_ID}/zip`],
      'it must ask for exactly one zip, the live one',
    )
    // The tail refuses a payload without live.json; getting there proves the
    // selection and the unpack both succeeded rather than short-circuiting.
    assert.equal(run.status, 2, `expected the payload refusal (2), got ${run.status}:\n${run.stderr}`)
    assert.match(run.stderr, /缺/, 'the tail should name what the payload is missing')
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online pick: a list holding only archive- is refused, and nothing is downloaded', async () => {
  const api = await startFakeApi({
    artifacts: [artifact(ARCHIVE_ID, `archive-${RUN_ID}`)],
    zipPath,
  })
  try {
    const run = seal(api.port, join(scratch, 'case-archive-only'))
    assert.equal(run.status, 1, `expected 1, got ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, new RegExp(`live-${RUN_ID}`), 'the refusal must name the name it wanted')
    assert.deepEqual(
      api.seen.filter(url => url.startsWith('/repos/o/r/actions/artifacts/')), [],
      'a refusal must not download anything',
    )
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online pick: two artifacts under the same live- name are refused rather than picked', async () => {
  const api = await startFakeApi({
    artifacts: [artifact(LIVE_ID, `live-${RUN_ID}`), artifact(LIVE_ID + 1, `live-${RUN_ID}`)],
    zipPath,
  })
  try {
    const run = seal(api.port, join(scratch, 'case-two-live'))
    assert.equal(run.status, 1, `expected 1, got ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, /found 2/, 'the refusal must say how many matched')
    assert.deepEqual(
      api.seen.filter(url => url.startsWith('/repos/o/r/actions/artifacts/')), [],
      'a multi-match must not download anything',
    )
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online seal: it refuses a run that is not a completed success before it looks for artifacts', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if ((req.url ?? '').endsWith('/jobs')) return res.end(JSON.stringify({ jobs: [] }))
    res.end(JSON.stringify({ id: Number(RUN_ID), status: 'in_progress', conclusion: null }))
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  try {
    const run = seal(server.address().port, join(scratch, 'case-running'))
    assert.equal(run.status, 1, `expected 1, got ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, /conclusion=null/, 'the refusal must quote the conclusion it found')
  } finally {
    server.close()
  }
})
