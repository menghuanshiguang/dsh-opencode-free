// @ts-check
// Contract tests against a stand-in upstream.
//
// The stand-in is a loopback HTTP server that speaks the upstream's wire: it
// records the body it was given and answers with SSE. That makes the assertions
// about the *outbound* bytes — the thing the free tier judges — testable without
// spending quota, without Bun, and without the network.
//
// Three properties this file exists for:
//   1. the gateway adds nothing to the body `applyFingerprint` already shaped
//      (same sha256, computed twice from the same input);
//   2. the advertised model count is the runtime observation of the listing, not
//      a number written in the source;
//   3. a tool call comes back under the caller's own spelling.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'opencode-free-standin-'))

const SHA = value => createHash('sha256').update(value).digest('hex')
const FREE = 'nemotron-3.5-lightning-free'

/** Bodies the stand-in was handed, in order. */
const seen = []
/** What the stand-in should stream for the next chat turn. */
let scenario = () => []
/** Tool names the stand-in saw declared on the last chat turn. */
let declared = []
/** The wire name the stand-in answered a caller tool under, per turn. */
const answeredAs = []

const standIn = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://stand-in')
  let raw = ''
  for await (const chunk of req) raw += chunk
  seen.push({ method: req.method, path: url.pathname, body: raw })
  if (url.pathname === '/inference/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: FREE }, { id: 'zzz-second-free' }, { id: 'paid-model' }] }))
    return
  }
  const body = raw === '' ? {} : JSON.parse(raw)
  declared = (body.tools ?? []).map(tool => tool?.function?.name).filter(name => typeof name === 'string')
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  for (const chunk of scenario()) res.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
})

await new Promise(resolve => standIn.listen(0, '127.0.0.1', () => resolve(undefined)))
const address = standIn.address()
assert.ok(address && typeof address === 'object', 'the stand-in bound a port')
// The gateway reads this at import time, so it is set before the import below.
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${address.port}`

const { startGateway } = await import('../../src/gateway.js')
const { applyFingerprint } = await import('../../src/upstream.js')
const { V2_OFFICIAL_TOOL_ORDER } = await import('../../src/o2a.js')

test.after(() => new Promise(resolve => standIn.close(() => resolve())))

const withGateway = async (run) => {
  const gateway = await startGateway({ port: 0, host: '127.0.0.1' })
  try { return await run(gateway) } finally { await gateway.close() }
}

const PONG = () => [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } },
]

test('the outbound body is exactly what applyFingerprint renders, byte for byte', async () => {
  scenario = PONG
  const caller = { model: FREE, messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 }
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(caller),
    })
    assert.equal(response.status, 200)
    await response.json()
  })
  const sent = seen.find(entry => entry.path === '/inference/openai/v1/chat/completions')
  assert.ok(sent, 'the stand-in received the chat turn')

  // The same input shaped on its own, with no gateway involved.
  const expected = { ...caller, stream: true }
  applyFingerprint(expected, false)
  assert.equal(SHA(sent.body), SHA(JSON.stringify(expected)), 'the gateway must not add, drop or reorder a field')
  assert.deepEqual(JSON.parse(sent.body).tools.map(tool => tool.function.name), [...V2_OFFICIAL_TOOL_ORDER])
})

test('the advertised model count is the runtime observation, not a constant', async () => {
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.url}/models`)
    const listing = await response.json()
    const observed = listing.data.filter(row => /-free$/.test(row.id)).length
    assert.equal(listing.data.length, observed)
    assert.equal(response.headers.get('x-free-lane-models'), String(observed))
    assert.equal(observed, 2, 'the stand-in lists two free ids')
    // And the gateway asked the upstream for it rather than answering from memory.
    assert.ok(seen.some(entry => entry.path === '/inference/v1/models'))
  })
})

test('a streaming tool call comes back under the caller’s own tool name', async () => {
  scenario = () => {
    // The name the caller's tool was renamed to on the way out — read off the
    // request the stand-in actually received, never guessed here.
    const wireName = declared.find(name => !V2_OFFICIAL_TOOL_ORDER.includes(name)) ?? 'read'
    answeredAs.push(wireName)
    return [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: wireName, arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
  }
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: FREE,
        stream: true,
        messages: [{ role: 'user', content: 'read the readme' }],
        tools: [{ type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    // The name the caller declared must be what it sees back.
    assert.match(text, /"name":"Read"/)
    assert.ok(!text.includes(`"name":"${answeredAs.at(-1)}"`), 'the wire name must not reach the caller')
  })
  // The stand-in could only answer with a wire name it read off the request.
  const chat = seen.filter(entry => entry.path === '/inference/openai/v1/chat/completions').at(-1)
  assert.ok(chat)
  const names = JSON.parse(chat.body).tools.map(tool => tool.function.name)
  const callerWire = names.filter(name => !V2_OFFICIAL_TOOL_ORDER.includes(name))
  assert.equal(callerWire.length, 1, 'the caller tool was renamed on the way out')
})

test('an aggregated tool call is returned with its name restored and finish_reason tool_calls', async () => {
  scenario = () => {
    const wireName = declared.find(name => !V2_OFFICIAL_TOOL_ORDER.includes(name)) ?? 'read'
    answeredAs.push(wireName)
    return [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: wireName, arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x.md"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
  }
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: FREE,
        messages: [{ role: 'user', content: 'read x' }],
        tools: [{ type: 'function', function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      }),
    })
    const result = await response.json()
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(result.choices[0].message.tool_calls[0].function.name, 'Read')
    assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"path":"x.md"}')
    assert.equal(result.choices[0].message.content, null)
  })
})

test('the stand-in saw exactly one request per turn — no retry, no probe', async () => {
  seen.length = 0
  scenario = PONG
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: FREE, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.json()
    const chats = seen.filter(entry => entry.path === '/inference/openai/v1/chat/completions')
    assert.equal(chats.length, 1)
    assert.equal(declared.length >= 13, true, 'the 13 official tools were on the wire')
  })
})
