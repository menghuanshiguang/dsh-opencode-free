// @ts-check
// The gateway's surface, clause by clause from docs/GATEWAY-CONTRACT.md.
//
// The lane is injected, so nothing here reaches the network or spends quota. The
// assertions are about the contract the file already published: routes, status
// codes, the shape of a streamed chunk, and the tool-name round trip. The bytes
// that reach the upstream are asserted separately, in standin.test.mjs (I1),
// against a server that records them.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'opencode-free-test-'))
const { startGateway } = await import(new URL('../../src/gateway.js', import.meta.url).href)
const { V2_OFFICIAL_TOOL_ORDER } = await import(new URL('../../src/o2a.js', import.meta.url).href)

const FREE = 'nemotron-3.5-lightning-free'
const OFFICIAL = new Set(V2_OFFICIAL_TOOL_ORDER)

/** A lane that records the request and replays a scripted SSE answer. */
function fakeLane({ chunks = [], fail = undefined, models = undefined } = {}) {
  const calls = []
  return {
    calls,
    stream: async args => {
      calls.push({ path: args.path, body: args.body, session: args.session })
      if (fail) throw fail
      for (const chunk of chunks) args.onData(typeof chunk === 'string' ? chunk : JSON.stringify(chunk))
      args.onData('[DONE]')
      return { status: 200 }
    },
    models: async () => models ?? ({
      object: 'list',
      data: [{ id: FREE }, { id: 'someone-elses-free' }, { id: 'paid-model' }],
    }),
  }
}

const PONG = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } },
]

/**
 * A caller tool the lane renames on the way out.
 *
 * The caller spells it `read`; because it does not carry the verbatim official
 * definition, `shapeToolSurface` issues it a derived wire name (`mcp_<digest>`)
 * and the official `read` is injected beside it. C20's own example writes the
 * direction the other way round (`my_read` → wire `read`), which cannot happen:
 * the 13 official names are reserved and are never issued to a caller tool, so
 * the achievable direction is the one asserted here and in 验收员's bench —
 * caller `read` → wire `mcp_…` → response `mcp_…` → caller `read`.
 */
const MY_READ = { type: 'function', function: { name: 'read', description: 'read a file the way a host CLI does', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }

async function withGateway(options, run) {
  const gateway = await startGateway({ port: 0, host: '127.0.0.1', ...options })
  try { return await run(gateway) } finally { await gateway.close() }
}

const post = (gateway, path, value, headers = {}) => fetch(`${gateway.url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof value === 'string' ? value : JSON.stringify(value),
})

test('C2/C3/C4 models: only free ids, entry fields filled, count observed at request time', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const response = await fetch(`${gateway.url}/models/`)
    assert.equal(response.status, 200)
    const listing = await response.json()
    assert.equal(listing.object, 'list')
    assert.deepEqual(listing.data.map(row => row.id), [FREE, 'someone-elses-free'])
    for (const row of listing.data) {
      assert.equal(typeof row.id, 'string')
      assert.equal(row.object, 'model')
      assert.equal(Number.isInteger(row.created), true)
      assert.equal(typeof row.owned_by, 'string')
    }
    assert.equal(response.headers.get('x-free-lane-models'), '2')
  })
  assert.equal(lane.calls.length, 0, 'the listing is a GET, not a chat turn')
})

test('C4 the count follows the listing, never a constant', async () => {
  for (const [rows, expected] of [
    [[{ id: 'a-free' }, { id: 'b-free' }, { id: 'c-free' }], 3],
    [[{ id: 'a-free' }, { id: 'paid' }], 1],
    [[{ id: 'paid-only' }], 0],
  ]) {
    const lane = fakeLane({ models: { object: 'list', data: rows } })
    await withGateway({ lane }, async gateway => {
      const response = await fetch(`${gateway.url}/models`)
      const listing = await response.json()
      assert.equal(listing.data.length, expected)
      assert.equal(response.headers.get('x-free-lane-models'), String(expected))
    })
  }
})

test('C1/C16 a wrong method answers 405 with allow, and carries no upstream code', async () => {
  await withGateway({ lane: fakeLane() }, async gateway => {
    const models = await fetch(`${gateway.url}/models`, { method: 'DELETE' })
    assert.equal(models.status, 405)
    assert.equal(models.headers.get('allow'), 'GET')
    const chat = await fetch(`${gateway.url}/chat/completions`)
    assert.equal(chat.status, 405)
    assert.equal(chat.headers.get('allow'), 'POST')
    for (const response of [models, chat]) {
      assert.equal(response.headers.get('x-free-lane-code'), null)
      const body = await response.json()
      assert.equal(body.error.type, 'method_not_allowed')
      assert.equal(body.error.code, 'method_not_allowed')
    }
  })
})

test('§7 the non-target surface does not exist', async () => {
  await withGateway({ lane: fakeLane() }, async gateway => {
    for (const path of ['/stats', '/stats.json', '/admin', '/dashboard', '/healthz', '/', '/v1/embeddings', '/v1/completions', '/v1/responses', '/v1/models/gpt-4']) {
      const response = await fetch(`${gateway.url}${path}`)
      assert.equal(response.status, 404, `${path} must not be served`)
    }
  })
})

test('C6 a paid model id is refused locally and the lane is never called', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: 'nemotron-3.5-lightning', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /ends in -free/)
    assert.equal(lane.calls.length, 0)
  })
})

test('C5 a body over 8 MiB is 413, not 400', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const big = { model: FREE, messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024 + 16) }] }
    const response = await post(gateway, '/chat/completions', big)
    assert.equal(response.status, 413)
    assert.equal(lane.calls.length, 0)
  })
})

test('§3.2 empty and malformed bodies are 400 with the local error shape', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const empty = await post(gateway, '/chat/completions', '')
    assert.equal(empty.status, 400)
    const broken = await post(gateway, '/chat/completions', '{not json')
    assert.equal(broken.status, 400)
    const noMessages = await post(gateway, '/chat/completions', { model: FREE, messages: [] })
    assert.equal(noMessages.status, 400)
    for (const response of [empty, broken, noMessages]) {
      assert.equal(response.headers.get('x-free-lane-code'), null)
      assert.equal((await response.json()).error.code, 'invalid_request_error')
    }
    assert.equal(lane.calls.length, 0)
  })
})

test('I5 an Authorization header is ignored — never a local 401', async () => {
  await withGateway({ lane: fakeLane({ chunks: PONG }) }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer nothing' })
    assert.equal(response.status, 200)
  })
})

test('C7/C9/C10 non-streaming: content concatenated, caller model echoed, usage defaults to zeros', async () => {
  const lane = fakeLane({ chunks: [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'PO' } }] }, { choices: [{ index: 0, delta: { content: 'NG' }, finish_reason: 'stop' }] }] })
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] })
    const result = await response.json()
    assert.equal(result.object, 'chat.completion')
    assert.equal(result.model, FREE)
    assert.equal(result.choices[0].message.content, 'PONG')
    assert.equal(result.choices[0].finish_reason, 'stop')
    assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
    assert.equal('tool_calls' in result.choices[0].message, false)
  })
})

test('C8/C20 non-streaming: tool_calls aggregated by index and the caller name restored', async () => {
  const lane = fakeLane({
    chunks: [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x.md"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
  })
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'read x' }], tools: [MY_READ] })
    const result = await response.json()
    const call = result.choices[0].message.tool_calls[0]
    assert.equal(call.id, 'call_1')
    assert.equal(call.type, 'function')
    assert.equal(call.function.name, 'read', 'the caller spelling comes back')
    assert.equal(call.function.arguments, '{"path":"x.md"}', 'arguments are concatenated, not re-serialised')
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(result.choices[0].message.content, '', 'C7 keeps content a string')
  })
})

test('C11/C12/C13/C14 streaming: chunk shape, role first, usage only when asked, [DONE] last', async () => {
  const lane = fakeLane({
    chunks: [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } },
    ],
  })
  await withGateway({ lane }, async gateway => {
    const plain = await post(gateway, '/chat/completions', { model: FREE, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(plain.status, 200)
    assert.match(plain.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.equal(plain.headers.get('cache-control'), 'no-store')
    const text = await plain.text()
    assert.ok(text.endsWith('data: [DONE]\n\n'), 'the stream ends with [DONE] and nothing after it')
    const frames = text.split('\n\n').filter(Boolean).filter(part => part.startsWith('data: ')).map(part => part.slice(6))
    const parsed = frames.filter(part => part !== '[DONE]').map(part => JSON.parse(part))
    assert.ok(parsed.length >= 2)
    const ids = new Set(parsed.map(chunk => chunk.id))
    assert.equal(ids.size, 1, 'one id for the whole stream')
    for (const chunk of parsed) {
      assert.equal(chunk.object, 'chat.completion.chunk')
      assert.equal(chunk.model, FREE)
      assert.equal(Number.isInteger(chunk.created), true)
    }
    assert.equal(parsed[0].choices[0].delta.role, 'assistant', 'the first frame declares the role')
    for (const chunk of parsed) assert.equal(chunk.usage, undefined, 'no usage frame unless include_usage was asked for')
  })
})

test('C14 include_usage adds the usage frame before [DONE]', async () => {
  const lane = fakeLane({
    chunks: [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } },
    ],
  })
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', {
      model: FREE, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }],
    })
    const text = await response.text()
    const frames = text.split('\n\n').filter(Boolean).map(part => part.replace(/^data: /, '')).filter(part => part !== '[DONE]')
    const usageFrame = frames.map(part => JSON.parse(part)).at(-1)
    assert.deepEqual(usageFrame.choices, [])
    assert.equal(usageFrame.usage.total_tokens, 12)
  })
})

test('C13 streaming tool deltas keep their index and carry the restored name', async () => {
  const lane = fakeLane({
    chunks: [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'mcp_3316348dbadf', arguments: '{"path":"README.md"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
  })
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, stream: true, messages: [{ role: 'user', content: 'read' }], tools: [MY_READ] })
    const text = await response.text()
    assert.match(text, /"name":"read"/)
    assert.match(text, /"index":0/)
    assert.doesNotMatch(text, /"name":"mcp_/, 'the wire name must not reach the caller')
  })
})

test('C16/C17 upstream refusals keep their class; retry-after only when the upstream named it', async () => {
  for (const [code, status] of [['RATE_LIMIT', 429], ['LANE_LOCKED', 403], ['TRANSPORT', 502], ['TIMEOUT', 504]]) {
    const lane = fakeLane({ fail: Object.assign(new Error(`refused: ${code}`), { code }) })
    await withGateway({ lane }, async gateway => {
      const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(response.status, status, `${code} must answer ${status}`)
      assert.equal(response.headers.get('x-free-lane-code'), code)
      assert.equal(response.headers.get('retry-after'), null, 'nothing to retry against was named')
      assert.equal((await response.json()).error.type, 'upstream_error')
      assert.equal(lane.calls.length, 1, 'one request, no retry')
    })
  }
  const lane = fakeLane({ fail: Object.assign(new Error('window open'), { code: 'RATE_LIMIT', providerRetryAfterMs: 90_000 }) })
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '90')
  })
})

test('C15 a failure after the headers became an error frame and [DONE], never a retry', async () => {
  /** A lane that lets one chunk through and then fails. */
  const failAfterFirst = {
    calls: [],
    stream: async args => {
      args.onData(JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'PO' } }] }))
      throw Object.assign(new Error('upstream died mid-stream'), { code: 'TRANSPORT' })
    },
    models: async () => ({ data: [] }),
  }
  await withGateway({ lane: failAfterFirst }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200, 'status is decided before the failure')
    const text = await response.text()
    assert.match(text, /"error":\{"message":"upstream died mid-stream"/)
    assert.ok(text.endsWith('data: [DONE]\n\n'))
  })
})

test('C20 a name that was never renamed is passed through unchanged', async () => {
  const lane = fakeLane({
    chunks: [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_z', type: 'function', function: { name: 'totally_unknown_tool', arguments: '{}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
  })
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'x' }], tools: [MY_READ] })
    const result = await response.json()
    assert.equal(result.choices[0].message.tool_calls[0].function.name, 'totally_unknown_tool')
  })
})

test('I2 one inbound request is one upstream request, with the 13 official tools on the wire', async () => {
  const lane = fakeLane({ chunks: PONG })
  await withGateway({ lane }, async gateway => {
    await (await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }], tools: [MY_READ] })).json()
    assert.equal(lane.calls.length, 1)
    const sent = lane.calls[0]
    assert.equal(sent.path, '/inference/openai/v1/chat/completions')
    assert.equal(sent.body.stream, true)
    const names = sent.body.tools.map(tool => tool.function.name)
    assert.deepEqual(names.filter(name => OFFICIAL.has(name)), [...V2_OFFICIAL_TOOL_ORDER])
    assert.equal(names.length > 13, true, 'the caller tool travelled beside the official set')
    const system = sent.body.messages.find(message => message.role === 'system')
    assert.match(String(system.content), /^You are an AI agent running in OpenCode/)
    assert.match(sent.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })
})

test('I3 the conversation header picks the upstream session', async () => {
  const lane = fakeLane({ chunks: PONG })
  await withGateway({ lane }, async gateway => {
    await (await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] }, { 'x-free-lane-conversation': 'conversation-a' })).json()
    await (await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] }, { 'x-free-lane-conversation': 'conversation-b' })).json()
    const [a, b] = lane.calls.map(call => call.session)
    assert.match(a, /^ses_/)
    assert.match(b, /^ses_/)
    assert.notEqual(a, b, 'two conversations must not share one session')
  })
})
