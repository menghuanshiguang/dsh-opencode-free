// The seal script's ONLINE branch, executed for real against a stand-in API.
//
// Why this file exists: the online branch of scripts/seal-live-run.sh -- fetch
// the run, pick the artifact, download its zip, unpack it, resolve which layer
// holds the payload -- had never been run end to end. 验收员 could not run it
// (no `unzip` on that machine) and the implementation was only checked by
// reading the code and by lifting the `node -e` selector out of the file. Both
// are honest evidence about the selector and no evidence at all about the wiring
// around it.
//
// The fixture is deliberately the shape a real artifact has: the four payload
// files under a subdirectory, not flat, and not empty. 验收员's correction is
// the reason: with an empty flat fixture this test could not tell the payload
// layer apart from a missing payload -- a flat fixture and the real artifact
// both exited 2 with the same "缺 live.json", so the case stayed green while
// saying nothing. With live.json one level down, it fails when the script looks
// in the wrong place.
//
// The tail that follows the payload check (preconditions, the archive, validate)
// is not the subject here; it runs against a fake product and may refuse. What
// is asserted is which artifact the script asks for and which layer it settles
// on.

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
 * A zip holding the given relative paths, built by python3 ('zip' is not
 * installed everywhere; python3 is on every runner this repository uses).
 * A missing python3 is a failure, not a skip: a skipped case here is the same
 * silence this file was written to end.
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
  for (const entry of entries) {
    const target = join(base, entry)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `fixture ${entry}\n`)
  }
  const path = join(scratch, name)
  const built = spawnSync('python3', ['-c', py, path, base, ...entries], { encoding: 'utf8' })
  assert.equal(built.error ?? null, null, `python3 could not start: ${built.error?.message ?? ''}`)
  assert.equal(built.status, 0, `python3 could not build the fixture zip: ${built.stderr ?? ''}`)
  assert.ok(readFileSync(path).length > 0, 'the fixture zip is empty')
  return path
}

/** The four files the archive insists on, at the paths given. */
const payload = prefix => ['live.json', 'gates.flat.json', 'fields.json', 'egress.env'].map(name => `${prefix}${name}`)

/**
 * A GitHub stand-in: the API documents the script asks for, the artifact zip,
 * and a log of every request it received.
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
      return send(200, JSON.stringify({
        full_name: 'o/r', private: false, visibility: 'public', default_branch: 'main',
      }))
    }
    const single = /^\/repos\/o\/r\/actions\/artifacts\/(\d+)$/.exec(req.url ?? '')
    if (single) {
      const found = artifacts.find(a => String(a.id) === single[1])
      return found ? send(200, JSON.stringify(found)) : send(404, '{}')
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

const bothUploads = () => [artifact(ARCHIVE_ID, `archive-${RUN_ID}`), artifact(LIVE_ID, `live-${RUN_ID}`)]
const zipRequests = seen => seen.filter(url => url.startsWith('/repos/o/r/actions/artifacts/') && url.endsWith('/zip'))

test('online pick: a list holding archive- and live- fetches live-, never archive-', async () => {
  const api = await startFakeApi({ artifacts: bothUploads(), zipPath: makeZip('nested.zip', payload('_temp/')) })
  try {
    const run = seal(api.port, join(scratch, 'case-nested'))
    const inputs = run.stdout.split('\n').find(l => l.startsWith('sealed inputs:'))
    assert.ok(
      inputs,
      `the script never reached the download line.\nrc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    )
    assert.match(inputs, new RegExp(`artifact id=${LIVE_ID}`), `it bound the wrong artifact: ${inputs}`)
    assert.match(inputs, new RegExp(`name=live-${RUN_ID}`), `it bound the wrong name: ${inputs}`)
    assert.deepEqual(zipRequests(api.seen), [`/repos/o/r/actions/artifacts/${LIVE_ID}/zip`], 'exactly one zip, the live one')

    // The layer question: the payload sits one level down, and the script has to
    // find it there. Before that was fixed it reported a missing payload.
    assert.match(run.stdout, /sealed payload layer: _temp \(/, `it did not resolve the payload layer:\n${run.stdout}`)
    assert.doesNotMatch(run.stderr, /缺 live\.json/, `it still looks in the wrong place:\n${run.stderr}`)
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online pick: a flat artifact resolves to the top rather than assuming a subdirectory', async () => {
  const api = await startFakeApi({ artifacts: bothUploads(), zipPath: makeZip('flat.zip', payload('')) })
  try {
    const run = seal(api.port, join(scratch, 'case-flat'))
    assert.match(run.stdout, /sealed payload layer: \(top\)/, `a flat artifact should resolve to the top:\n${run.stdout}`)
    assert.doesNotMatch(run.stderr, /深度 ≤3 以内找不到 live\.json/, `it failed to see the flat payload:\n${run.stderr}`)
    assert.deepEqual(zipRequests(api.seen), [`/repos/o/r/actions/artifacts/${LIVE_ID}/zip`], 'still only the live zip')
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online pick: a list holding only archive- is refused, and nothing is downloaded', async () => {
  const api = await startFakeApi({
    artifacts: [artifact(ARCHIVE_ID, `archive-${RUN_ID}`)],
    zipPath: makeZip('unused.zip', payload('_temp/')),
  })
  try {
    const run = seal(api.port, join(scratch, 'case-archive-only'))
    assert.equal(run.status, 1, `expected 1, got ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, new RegExp(`live-${RUN_ID}`), 'the refusal must name the name it wanted')
    assert.deepEqual(zipRequests(api.seen), [], 'a refusal must not download anything')
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online pick: two artifacts under the same live- name are refused rather than picked', async () => {
  const api = await startFakeApi({
    artifacts: [artifact(LIVE_ID, `live-${RUN_ID}`), artifact(LIVE_ID + 1, `live-${RUN_ID}`)],
    zipPath: makeZip('dup.zip', payload('_temp/')),
  })
  try {
    const run = seal(api.port, join(scratch, 'case-two-live'))
    assert.equal(run.status, 1, `expected 1, got ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, /found 2/, 'the refusal must say how many matched')
    assert.deepEqual(zipRequests(api.seen), [], 'a multi-match must not download anything')
  } finally {
    api.server.closeAllConnections?.()
    api.server.close()
  }
})

test('online seal: it refuses a run that is not a completed success before it looks for artifacts', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    if ((req.url ?? '').endsWith('/jobs')) return res.end(JSON.stringify({ jobs: [] }))
    res.end(JSON.stringify({ id: Number(RUN_ID), status: 'in_progress', conclusion: null }))
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  try {
    const run = seal(server.address().port, join(scratch, 'case-running'))
    assert.equal(run.status, 1, `expected 1, got ${run.status}\n${run.stderr}`)
    assert.match(run.stderr, /conclusion=null/, 'the refusal must quote the conclusion it found')
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})
