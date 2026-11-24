#!/usr/bin/env node
// Anonymous `gh` stand-in for the asset refresh.
//
// `scripts/fetch-opencode-assets.mjs` reads its 15 source files through `gh api`,
// which needs a token. The lane carries no credentials, so CI must not mint one.
// Installing this file as `gh` on PATH keeps the pinned fetcher running
// unmodified while every read goes out anonymously to raw.githubusercontent.com,
// and the git blob SHA in the answer is computed here from the bytes that were
// received — the same value GitHub's API would report.
//
// Only the one subcommand the fetcher uses is implemented; anything else exits
// non-zero instead of pretending to be gh.
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.OFM_ASSET_LOG

const blobSha = bytes => {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}
const record = entry => { if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`) }
const fail = message => { console.error(`gh-anon-shim: ${message}`); process.exit(1) }

if (args[0] !== 'api' || typeof args[1] !== 'string') {
  fail(`unsupported invocation: gh ${args.join(' ')} — this shim only serves "gh api repos/<repo>/contents/<path>"`)
}

const match = /^repos\/([^/]+\/[^/]+)\/contents\/(.+?)(?:\?ref=(.+))?$/.exec(args[1])
if (!match) fail(`unsupported endpoint: ${args[1]}`)
const [, repo, encodedPath, ref = 'HEAD'] = match
const path = encodedPath.split('/').map(decodeURIComponent).join('/')
const url = `https://raw.githubusercontent.com/${repo}/${ref}/${encodedPath}`

const response = await fetch(url, { headers: { accept: '*/*' }, redirect: 'follow' })
if (!response.ok) {
  record({ path, ref, url, status: response.status, ok: false })
  fail(`GET ${url} -> HTTP ${response.status}`)
}
const bytes = Buffer.from(await response.arrayBuffer())
const sha = blobSha(bytes)
record({ path, ref, url, status: response.status, ok: true, sha, size: bytes.length })

// The shape `gh api repos/:owner/:repo/contents/:path` prints for a file.
process.stdout.write(JSON.stringify({
  type: 'file',
  encoding: 'base64',
  size: bytes.length,
  name: path.split('/').pop(),
  path,
  sha,
  content: bytes.toString('base64').replace(/(.{60})/g, '$1\n'),
}, null, 2))
