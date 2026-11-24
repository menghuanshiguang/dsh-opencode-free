// Wire tap for the live run: records what the lane ACTUALLY sent and received.
//
// A preload, not a probe. It does not build a request, choose a model, or touch
// the lane's code path — it observes the two places any transport must pass
// through: `JSON.stringify(body)` in `src/http.js` (the exact request bytes, for
// both the Bun worker and the node fallback) and `Response.prototype.text` (the
// raw body the lane reads off a non-2xx answer, where the error envelope lives).
//
// Everything lands under $OFM_WIRE_DIR as one JSON line per record, so the log
// artifact is machine-readable and the numbers in the report are computed.
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const dir = process.env.OFM_WIRE_DIR
const sha = value => createHash('sha256').update(value).digest('hex')
let requests = 0
let responses = 0

if (dir) {
  mkdirSync(dir, { recursive: true })
  const record = (kind, payload) => appendFileSync(join(dir, 'wire.jsonl'), `${JSON.stringify({ kind, at: new Date().toISOString(), ...payload })}\n`)

  // Request bytes: the lane serialises the finished body exactly once per turn.
  const originalStringify = JSON.stringify
  JSON.stringify = function tappedStringify(...args) {
    const text = originalStringify.apply(this, args)
    try {
      if (typeof text === 'string' && text.length > 2000 && text.includes('"tools"') && text.includes('"messages"')) {
        requests += 1
        record('request', { bytes: Buffer.byteLength(text), sha256: sha(text), body: text })
      }
    } catch { /* the tap must never disturb the request it observes */ }
    return text
  }

  // Response body: the lane reads a non-2xx answer as text before classifying it.
  const originalText = Response.prototype.text
  Response.prototype.text = async function tappedText() {
    const text = await originalText.call(this)
    try {
      responses += 1
      record('response', {
        status: this.status,
        headers: Object.fromEntries(this.headers.entries()),
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
        body: text,
      })
    } catch { /* same rule as above */ }
    return text
  }

  process.on('exit', () => {
    console.error(`[capture-wire] requests=${requests} responses=${responses} dir=${dir}`)
  })
}
