#!/usr/bin/env node
// 验收员 independent contract bench for the local OpenAI-compatible gateway.
// It drives the exported createGateway with an injected stand-in lane, never a real upstream,
// and counts every attempt to reach a non-loopback host.
//
// rc: 0 all contracts hold, 1 a contract broke (each named), 2 the bench itself could not run.
// --live is reserved for the real lane; without it the live section prints exactly "Skipped".
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')

// ---- network guard: everything that is not loopback is recorded, and any target is judged ----
const attempts = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  attempts.push(url)
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(url)) {
    return Promise.reject(new Error(`network guard: blocked ${url}`))
  }
  return realFetch(input, init)
}
const realConnect = connect
const guardConnect = function (...a) {
  const [opts] = a
  if (opts && typeof opts === 'object' && opts.host) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(opts.host)) {
      attempts.push(`tcp://${opts.host}:${opts.port}`)
      throw new Error(`network guard: blocked tcp ${opts.host}:${opts.port}`)
    }
  }
  return realConnect.apply(this, a)
}

const mod = await import(new URL('../src/gateway.js', import.meta.url).href)
const { applyFingerprint } = await import(new URL('../src/upstream.js', import.meta.url).href)

const sha = (s) => createHash('sha256').update(s).digest('hex')
const failures = []
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`) }
const ok = (m) => console.log(`  ok   ${m}`)

async function withServer(gateway) {
  const server = createServer((req, res) => {
    gateway.handler(req, res).catch(error => {
      if (!res.headersSent) { res.writeHead(500); res.end(String(error)) } else res.end()
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/v1`
  return { base, close: () => new Promise(r => server.close(r)) }
}

// one stand-in lane: records what the gateway sent, replays a scripted upstream
function standIn(script) {
  const sent = []
  return {
    sent,
    lane: {
      models: async (opts) => { sent.push({ kind: 'models', opts }); return script.models },
      stream: async ({ path, body, session, onData }) => {
        sent.push({ kind: 'stream', path, body, session, raw: JSON.stringify(body) })
        for (const chunk of script.chunks) onData(chunk)
      },
    },
  }
}

const freeRows = (n) => Array.from({ length: n }, (_, i) => ({ id: `model-${i}-free`, object: 'model', owned_by: 'opencode' }))
const paidRows = [{ id: 'gpt-4o', object: 'model' }, { id: 'claude-sonnet', object: 'model' }]

console.log('contract 1 — GET /v1/models lists exactly the runtime free-marked models')
for (const n of [3, 2, 0]) {
  const up = standIn({ models: { object: 'list', data: [...freeRows(n), ...paidRows] }, chunks: [] })
  const gateway = mod.createGateway({ lane: up.lane })
  const { base, close } = await withServer(gateway)
  const res = await fetch(`${base}/models`)
  const body = await res.json()
  await close()
  const ids = body.data.map(r => r.id)
  if (res.status !== 200) fail(`models: status ${res.status}`)
  if (ids.length !== n) fail(`models: ${ids.length} rows for a runtime listing with ${n} free ids (hardcoded?)`)
  else ok(`models: ${n} free rows in, ${n} out (${ids.join(',') || 'none'})`)
  if (ids.some(id => !/-free$/.test(id))) fail(`models: a non-free id leaked: ${ids.join(',')}`)
}

console.log('contract 2 — POST /v1/chat/completions, non-stream, aggregates one object')
{
  const chunks = ['{"choices":[{"delta":{"content":"PO"}}]}', '{"choices":[{"delta":{"content":"NG"},"finish_reason":"stop"}],"usage":{"total_tokens":4}}']
  const up = standIn({ models: { data: [] }, chunks })
  const gateway = mod.createGateway({ lane: up.lane })
  const { base, close } = await withServer(gateway)
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'big-pickle-free', messages: [{ role: 'user', content: 'ping' }] }),
  })
  const body = await res.json()
  await close()
  const text = body?.choices?.[0]?.message?.content
  if (res.status !== 200) fail(`non-stream: status ${res.status} ${JSON.stringify(body).slice(0, 120)}`)
  else if (text !== 'PONG') fail(`non-stream: content ${JSON.stringify(text)} != "PONG"`)
  else ok(`non-stream: content "PONG", finish ${body.choices[0].finish_reason}, usage ${JSON.stringify(body.usage)}`)
  if (body?.object !== 'chat.completion') fail(`non-stream: object ${body?.object}`)
  if (up.sent[0]?.body?.stream !== true) fail('non-stream: the gateway did not ask the lane for its stream wire')
}

console.log('contract 2b — a non-free model is refused locally, with nothing sent to the lane')
{
  const up = standIn({ models: { data: [] }, chunks: [] })
  const gateway = mod.createGateway({ lane: up.lane })
  const { base, close } = await withServer(gateway)
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'ping' }] }),
  })
  const body = await res.json()
  await close()
  const sent = up.sent.filter(s => s.kind === 'stream').length
  if (res.status !== 400) fail(`paid model: status ${res.status}, expected 400`)
  else if (sent !== 0) fail(`paid model: ${sent} request(s) still reached the lane`)
  else ok(`paid model: 400 local, ${sent} lane requests, ${JSON.stringify(body).slice(0, 90)}`)
}

console.log('contract 3 — stream=true yields SSE frames that end with [DONE]')
{
  const chunks = ['{"choices":[{"delta":{"content":"PO"}}]}', '{"choices":[{"delta":{"content":"NG"},"finish_reason":"stop"}]}']
  const up = standIn({ models: { data: [] }, chunks })
  const gateway = mod.createGateway({ lane: up.lane })
  const { base, close } = await withServer(gateway)
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'big-pickle-free', messages: [{ role: 'user', content: 'ping' }], stream: true }),
  })
  const text = await res.text()
  await close()
  const frames = text.split('\n\n').filter(Boolean)
  if (!/text\/event-stream/.test(res.headers.get('content-type') ?? '')) fail(`stream: content-type ${res.headers.get('content-type')}`)
  if (frames.at(-1) !== 'data: [DONE]') fail(`stream: last frame ${JSON.stringify(frames.at(-1))}`)
  const joined = frames.filter(f => f !== 'data: [DONE]').map(f => {
    try { return JSON.parse(f.replace(/^data: /, ''))?.choices?.[0]?.delta?.content ?? '' } catch { return '' }
  }).join('')
  if (joined !== 'PONG') fail(`stream: reassembled ${JSON.stringify(joined)} != "PONG"`)
  else ok(`stream: ${frames.length} frames, reassembled "PONG", ends [DONE]`)
}

// the caller declares tools; shaping renames them on the wire, so the reply must be restored
const callerTools = [
  { type: 'function', function: { name: 'read', description: 'caller read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'my_lookup', description: 'caller lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
]

async function toolRoundTrip(stream) {
  const up = standIn({ models: { data: [] }, chunks: [] })
  up.lane.stream = async ({ path, body, session, onData }) => {
    up.sent.push({ kind: 'stream', path, body, session, raw: JSON.stringify(body) })
    const wire = body.tools.map(t => t.function?.name ?? t.name)
    const callerRead = wire.find(n => n !== 'read' && !/^(edit|glob|grep|patch|question|read|shell|skill|subagent|todowrite|webfetch|websearch|write)$/.test(n))
    up.wireRead = callerRead
    up.officialNames = wire
    for (const raw of [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: callerRead, arguments: '{"path":"/etc"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]) onData(raw)
  }
  const gateway = mod.createGateway({ lane: up.lane })
  const { base, close } = await withServer(gateway)
  const payload = { model: 'big-pickle-free', messages: [{ role: 'user', content: 'read /etc' }], tools: callerTools }
  if (stream) payload.stream = true
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  const raw = await res.text()
  await close()
  const wireRead = up.wireRead
  let seen
  if (stream) {
    seen = raw.split('\n\n').filter(f => f.startsWith('data: ') && f !== 'data: [DONE]')
      .flatMap(f => { try { return JSON.parse(f.slice(6))?.choices?.[0]?.delta?.tool_calls ?? [] } catch { return [] } })
      .map(c => c.function?.name)
  } else {
    let body
    try { body = JSON.parse(raw) } catch { body = null }
    seen = (body?.choices?.[0]?.message?.tool_calls ?? []).map(c => c.function?.name)
  }
  return { wireRead, seen, raw }
}

console.log('contract 4 — a tool round trip restores the caller spelling')
{
  const r = await toolRoundTrip(true)
  if (!r.wireRead) fail('tool/stream: the gateway sent the caller tool under its own spelling, nothing to restore (test inconclusive)')
  else if (!r.seen.includes('read')) fail(`tool/stream: caller tool came back as ${JSON.stringify(r.seen)}, expected "read"`)
  else ok(`tool/stream: wire name ${r.wireRead} restored to "read"`)
}
{
  const r = await toolRoundTrip(false)
  if (!r.wireRead) fail('tool/non-stream: the gateway sent the caller tool under its own spelling (test inconclusive)')
  else if (r.seen.length === 0) fail(`tool/non-stream: no tool_calls in the response at all (raw: ${r.raw.slice(0, 160)})`)
  else if (!r.seen.includes('read')) fail(`tool/non-stream: caller tool came back as ${JSON.stringify(r.seen)}, expected "read"`)
  else ok(`tool/non-stream: wire name ${r.wireRead} restored to "read"`)
}

console.log('contract 5 — the outbound body is exactly what applyFingerprint renders, sha256 for sha256')
{
  const up = standIn({ models: { data: [] }, chunks: ['{"choices":[{"delta":{"content":"x"}}]}'] })
  const gateway = mod.createGateway({ lane: up.lane })
  const { base, close } = await withServer(gateway)
  const client = {
    model: 'big-pickle-free',
    messages: [{ role: 'user', content: 'ping' }],
    tools: callerTools,
    temperature: 0.3,
    max_tokens: 16,
    stream: false,
  }
  await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(client),
  })
  await close()
  const sentBody = up.sent.find(s => s.kind === 'stream').body
  // rebuild what the shaping layer alone says, from the same client body
  const expected = { model: client.model, messages: client.messages, tools: client.tools, temperature: client.temperature, max_tokens: client.max_tokens, stream: true }
  applyFingerprint(expected, false)
  const a = sha(JSON.stringify(sentBody))
  const b = sha(JSON.stringify(expected))
  if (a !== b) {
    const keysA = Object.keys(sentBody).sort().join(','), keysB = Object.keys(expected).sort().join(',')
    fail(`sha mismatch: gateway ${a.slice(0, 16)}… vs applyFingerprint ${b.slice(0, 16)}… (keys ${keysA} vs ${keysB})`)
  } else ok(`sha256 equal: ${a}`)
}

// ---- live section: gated, and it must say Skipped when not asked for ----
console.log('contract 6 — the live section')
if (!LIVE) {
  console.log('Skipped')
  ok('live section printed "Skipped" (no --live, nothing was sent to the lane)')
} else {
  console.log('  live requested but this bench has no live lane; run it on the runner')
  fail('live section: --live is not implemented in this bench')
}

const external = attempts.filter(u => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u))
console.log(`network guard: ${attempts.length} attempt(s) recorded, ${external.length} outside loopback`)
const toOpencode = attempts.filter(u => /opencode\.ai/i.test(u))
if (toOpencode.length) fail(`requests reached opencode.ai: ${toOpencode.length}`)
if (external.length) fail(`requests went outside loopback: ${external.join(', ')}`)

console.log(failures.length === 0 ? 'GATEWAY-CONTRACT: PASS' : `GATEWAY-CONTRACT: FAIL (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
