// The gateway's whole surface: two routes, no admin, no statistics, no paid request.
//
// The lane is injected, so nothing here reaches the network or spends quota. The
// assertions are about what the gateway would send — the body the upstream would
// judge — not about an upstream answer.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'opencode-free-test-'))
const { startGateway } = await import(new URL('../../src/gateway.js', import.meta.url).href)
const { V2_OFFICIAL_TOOL_ORDER } = await import(new URL('../../src/o2a.js', import.meta.url).href)

const FREE = 'nemotron-3.5-lightning-free'

/** A lane that records the request and answers PONG, in the upstream's own SSE framing. */
function fakeLane(overrides = {}) {
  const calls = []
  return {
    calls,
    stream: async args => {
      calls.push({ path: args.path, body: args.body, session: args.session })
      if (overrides.fail) throw overrides.fail
      args.onData(JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' } }] }))
      args.onData(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } }))
      args.onData('[DONE]')
      return { status: 200 }
    },
    models: async () => ({
      object: 'list',
      data: [{ id: FREE }, { id: 'nemotron-3.5-lightning' }, { id: 'someone-elses-free' }],
    }),
  }
}

async function withGateway(options, run) {
  const gateway = await startGateway({ port: 0, host: '127.0.0.1', ...options })
  try { return await run(gateway) } finally { await gateway.close() }
}

const post = (gateway, path, body, headers = {}) => fetch(`${gateway.url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

// The advertised set is what the live listing says and the free-lane naming
// rule admits: every id is read from the listing at request time, never typed
// into this package. A paid id (no -free suffix) never appears.
test('GET /v1/models advertises the listing\'s free-lane ids, and only those', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const response = await fetch(`${gateway.url}/models`)
    assert.equal(response.status, 200)
    const listing = await response.json()
    assert.deepEqual(listing.data.map(row => row.id), [FREE, 'someone-elses-free'])
  })
})

test('the admin and statistics surfaces do not exist', async () => {
  await withGateway({ lane: fakeLane() }, async gateway => {
    for (const path of ['/stats', '/stats.json', '/admin', '/dashboard', '/healthz', '/']) {
      const response = await fetch(`${gateway.url}${path}`)
      assert.equal(response.status, 404, `${path} must not be served`)
    }
  })
})

test('a paid model id is refused locally, and the lane is never called', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: 'nemotron-3.5-lightning', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /ends in -free/)
    assert.equal(lane.calls.length, 0)
  })
})

test('wrong methods and empty messages are refused', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const get = await fetch(`${gateway.url}/chat/completions`)
    assert.equal(get.status, 405)
    const empty = await post(gateway, '/chat/completions', { model: FREE, messages: [] })
    assert.equal(empty.status, 400)
    assert.equal(lane.calls.length, 0)
  })
})

test('a non-streaming call returns one chat.completion aggregated from the lane stream', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.object, 'chat.completion')
    assert.equal(result.model, FREE)
    assert.equal(result.choices[0].message.content, 'PONG')
    assert.equal(result.choices[0].finish_reason, 'stop')
    assert.equal(result.usage.total_tokens, 12)

    const sent = lane.calls[0]
    assert.equal(sent.path, '/inference/openai/v1/chat/completions')
    assert.equal(sent.body.stream, true, 'the lane wire is always a stream')
    assert.deepEqual(sent.body.tools.map(tool => tool.function.name), [...V2_OFFICIAL_TOOL_ORDER])
    const system = sent.body.messages.find(message => message.role === 'system')
    assert.match(String(system.content), /^You are an AI agent running in OpenCode/)
    assert.match(sent.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })
})

test('a streaming call relays SSE frames and terminates with [DONE]', async () => {
  const lane = fakeLane()
  await withGateway({ lane }, async gateway => {
    const response = await post(gateway, '/chat/completions', { model: FREE, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /"content":"PONG"/)
    assert.match(text, /data: \[DONE\]/)
  })
})

test('a lane refusal keeps its class: quota 429, lane lock 403, transport 502', async () => {
  for (const [code, status] of [['RATE_LIMIT', 429], ['LANE_LOCKED', 403], ['TRANSPORT', 502]]) {
    const lane = fakeLane({ fail: Object.assign(new Error(`refused: ${code}`), { code }) })
    await withGateway({ lane }, async gateway => {
      const response = await post(gateway, '/chat/completions', { model: FREE, messages: [{ role: 'user', content: 'hi' }] })
      assert.equal(response.status, status, `${code} must answer ${status}`)
      assert.equal(response.headers.get('x-free-lane-code'), code)
      const body = await response.json()
      assert.equal(body.error.code, code)
      assert.equal(lane.calls.length, 1, 'one request, no retry')
    })
  }
})
