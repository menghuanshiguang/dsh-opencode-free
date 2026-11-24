// @ts-check
/**
 * The OpenCode free lane, behind a local OpenAI-compatible gateway.
 *
 * Two routes, no more: `GET /v1/models` and `POST /v1/chat/completions`. There is
 * no authentication, no billing, no admin page, no statistics endpoint and no
 * rate limiter, because there is nothing here to administer: one anonymous free
 * lane, reached with the released client's own request shape.
 *
 * The body that reaches the upstream is the one src/upstream.js shapes: the
 * official v2.2.3 system prompt, the 13 tool contracts in the lane's wire order,
 * the `x-opencode-*` identity and a real-timestamp session id. A gateway that
 * only forwarded the caller's JSON would be refused by the free tier (403
 * FreeTierError / 429), which is why shaping is not optional here.
 *
 * The caller-facing contract is docs/GATEWAY-CONTRACT.md, clause by clause
 * (C1…C20); the tests name the clause they hold. The short version: the request
 * body is byte-identical to `applyFingerprint` rendered alone (I1), one inbound
 * request is one upstream request (I2), and the response side may only rewrite
 * the id, the model, the tool names, and the SSE framing (I4).
 *
 * @module src/gateway.js
 */

import { createServer } from 'node:http'

import { CODE, getJson, postStreamed } from './http.js'
import { applyFingerprint, endpointFor, restoreToolName, sessionForConversation, truncateSession } from './upstream.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18787
const MODELS_PATH = '/inference/v1/models'
const MODEL_OBJECT = 'model'
const OWNER = 'opencode'

/** Fields this gateway forwards from an OpenAI chat body; everything else is local (C-§3.1). */
const CARRIED = [
  'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens',
  'max_completion_tokens', 'stop', 'response_format', 'seed', 'presence_penalty',
  'frequency_penalty', 'logit_bias', 'parallel_tool_calls',
]

/** HTTP status for one upstream refusal class (C-§4). */
function statusFor(code) {
  switch (code) {
    case CODE.quota: return 429
    case CODE.exhausted: return 429
    case CODE.laneLocked: return 403
    case CODE.permission: return 403
    case CODE.authorization: return 401
    case CODE.region: return 451
    case CODE.client: return 400
    case CODE.timeout: return 504
    case CODE.aborted: return 499
    default: return 502
  }
}

/** The free lane's model ids all end in `-free` (C2); anything else is a paid request we must not send (C6). */
function isFreeLaneModel(model) {
  return typeof model === 'string' && /^[a-z0-9][a-z0-9._-]*-free$/i.test(model) && !/[\s,]/.test(model)
}

function sendJson(res, status, value, extraHeaders = {}) {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

/**
 * A local error (C16): `invalid_request_error` unless the caller names something
 * else, and never the `x-free-lane-code` header that marks an upstream refusal.
 */
function sendError(res, status, message, code = 'invalid_request_error', extraHeaders = {}) {
  sendJson(res, status, { error: { message, type: code, code } }, extraHeaders)
}

class BodyTooLarge extends Error {}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge(`request body over ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One SSE frame. */
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`

/**
 * Build the gateway without opening a socket, so tests can drive it directly.
 * `lane` is injectable for the same reason: the default talks to the real
 * upstream, and no test should.
 */
export function createGateway(options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const workDir = options.workDir
  const lane = options.lane ?? {
    stream: args => postStreamed(args),
    models: args => getJson(MODELS_PATH, args),
  }

  /** I3: one conversation keeps one upstream session. */
  const sessionFor = req => truncateSession(sessionForConversation(
    String(req.headers['x-free-lane-conversation'] ?? options.conversation ?? 'gateway').trim() || 'gateway',
  ))

  async function handleModels(req, res) {
    const session = sessionFor(req)
    try {
      const listing = await lane.models({ session })
      const rows = Array.isArray(listing?.data) ? listing.data : []
      const free = rows.filter(row => isFreeLaneModel(row?.id)).map(row => ({
        ...row,
        id: row.id,
        object: typeof row.object === 'string' ? row.object : MODEL_OBJECT,
        created: Number.isInteger(row.created) ? row.created : 0,
        owned_by: typeof row.owned_by === 'string' ? row.owned_by : OWNER,
      }))
      // C4: the count is what this request observed in the upstream listing.
      // It reaches the caller in a header and the operator in the log, and no
      // artifact has to hard-code it.
      console.log(`modelsFreeCount=${free.length}`)
      sendJson(res, 200, { object: 'list', data: free }, { 'x-free-lane-models': String(free.length) })
    } catch (error) {
      upstreamFailure(res, error)
    }
  }

  async function handleChat(req, res) {
    // C-§3.2 order: size, then parse, then model, then messages.
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      if (error instanceof BodyTooLarge) return sendError(res, 413, 'request body over 8 MiB')
      return sendError(res, 400, `could not read the request body: ${error?.message ?? error}`)
    }
    if (raw.trim() === '') return sendError(res, 400, 'empty request body')
    let body
    try {
      body = JSON.parse(raw)
    } catch (error) {
      return sendError(res, 400, `request body is not JSON: ${error?.message ?? error}`)
    }
    if (!isFreeLaneModel(body?.model)) {
      return sendError(res, 400, 'model must be one free-lane id (it ends in -free); this gateway sends no paid request')
    }
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return sendError(res, 400, 'messages must be a non-empty array')
    }

    const payload = { model: body.model }
    for (const key of CARRIED) if (body[key] !== undefined) payload[key] = body[key]
    // The lane's own wire is a stream; a caller asking for one object gets it
    // aggregated below, not by asking the upstream for a different shape.
    payload.stream = true
    // The rename map is the only thing the gateway may use to touch the response
    // (I4): the caller's tool spellings have to come back, and nothing else changes.
    const renames = applyFingerprint(payload, false)
    const session = sessionFor(req)
    const wantsStream = body.stream === true
    const wantsUsage = body?.stream_options?.include_usage === true
    const created = Math.floor(Date.now() / 1000)
    const id = `chatcmpl-${created}-${session.slice(-8)}`

    let text = ''
    let usage
    let finish = null
    let wrote = false
    let sawRole = false
    /** Tool calls aggregated for the non-streaming answer, keyed by their index (C8). */
    const calls = new Map()
    const restore = name => restoreToolName(name, renames)

    /** C12: every frame is an OpenAI chunk with this turn's id and the caller's model. */
    const normalize = chunk => {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return null
      const choices = Array.isArray(chunk.choices) ? chunk.choices : []
      // C14: a usage frame only exists because the caller asked for usage.
      if (choices.length === 0 && chunk.usage !== undefined && !wantsUsage) return null
      chunk.id = id
      chunk.object = 'chat.completion.chunk'
      chunk.created = created
      chunk.model = body.model
      for (const choice of choices) {
        if (!choice.delta || typeof choice.delta !== 'object') choice.delta = {}
        // C13: the first frame declares the assistant role.
        if (!sawRole && choice.delta.role === undefined) choice.delta.role = 'assistant'
        if (choice.delta.role === 'assistant') sawRole = true
        for (const call of Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []) {
          const name = call?.function?.name
          if (typeof name === 'string' && name !== '') call.function.name = restore(name)
        }
        const legacy = choice.delta.function_call
        if (legacy && typeof legacy.name === 'string' && legacy.name !== '') legacy.name = restore(legacy.name)
        for (const call of Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : []) {
          const name = call?.function?.name
          if (typeof name === 'string' && name !== '') call.function.name = restore(name)
        }
      }
      return chunk
    }

    const startStream = () => {
      if (wrote) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      wrote = true
    }

    const onData = (/** @type {string} */ rawChunk) => {
      if (rawChunk === '[DONE]') return
      let chunk
      try { chunk = JSON.parse(rawChunk) } catch { return }
      const choice = chunk?.choices?.[0]
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call?.index ?? 0
        const held = calls.get(index) ?? { id: undefined, type: 'function', function: { name: '', arguments: '' } }
        if (typeof call?.id === 'string') held.id = call.id
        if (typeof call?.function?.name === 'string' && call.function.name !== '') held.function.name = call.function.name
        if (typeof call?.function?.arguments === 'string') held.function.arguments += call.function.arguments
        calls.set(index, held)
      }
      if (choice?.finish_reason) finish = choice.finish_reason
      if (chunk?.usage) usage = chunk.usage
      const normalized = normalize(chunk)
      if (normalized === null) return
      if (wantsStream) {
        startStream()
        res.write(frame(normalized))
      }
    }

    try {
      await lane.stream({ path: endpointFor(body.model), body: payload, session, onData })
    } catch (error) {
      if (wrote) {
        // C15: headers are gone; the refusal travels as one error frame, then the
        // stream ends. Never a second attempt, never a different status.
        res.write(frame({ error: { message: String(error?.message ?? error), code: error?.code ?? 'upstream_error' } }))
        res.end(frame('[DONE]'))
        return
      }
      return upstreamFailure(res, error)
    }

    if (wantsStream) {
      startStream()
      // C14: the usage frame closes the stream when it was asked for; [DONE] last.
      if (wantsUsage && usage !== undefined) {
        res.write(frame({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage }))
      }
      res.end(frame('[DONE]'))
      return
    }

    const toolCalls = [...calls.values()].map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: { name: restore(call.function.name), arguments: call.function.arguments },
    }))
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          // C7 keeps the content a string; C8 adds the calls beside it.
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  function upstreamFailure(res, error) {
    if (res.headersSent) { res.end(); return }
    const code = error?.code ?? 'upstream_error'
    const status = statusFor(code)
    const headers = { 'x-free-lane-code': String(code) }
    // C17: forward the window the upstream named, and invent nothing when it did not.
    const retryMs = Number(error?.providerRetryAfterMs ?? error?.retryAfterMs)
    if (Number.isFinite(retryMs) && retryMs > 0) headers['retry-after'] = String(Math.ceil(retryMs / 1000))
    sendJson(res, status, {
      error: {
        message: String(error?.message ?? error),
        type: 'upstream_error',
        code,
        status: error?.status,
      },
    }, headers)
  }

  /** The whole surface: two routes, and a 404/405 for everything else (C1/C2). */
  async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    // I5: an Authorization header is ignored, never answered with 401.
    if (path === '/v1/models') {
      if (req.method !== 'GET') return sendError(res, 405, 'only GET /v1/models', 'method_not_allowed', { allow: 'GET' })
      return handleModels(req, res)
    }
    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') return sendError(res, 405, 'only POST /v1/chat/completions', 'method_not_allowed', { allow: 'POST' })
      return handleChat(req, res)
    }
    return sendError(res, 404, `no route ${req.method} ${path}`)
  }

  return {
    handler,
    host,
    describe: () => ({ routes: ['GET /v1/models', 'POST /v1/chat/completions'], workDir: workDir ?? null }),
  }
}

/** Start the gateway on a socket and return the handle needed to stop it. */
export async function startGateway(options = {}) {
  const gateway = createGateway(options)
  const server = createServer((req, res) => {
    gateway.handler(req, res).catch(error => {
      // C18: a programming error is the only thing that earns a 500, and it still
      // answers with the error shape.
      if (!res.headersSent) sendError(res, 500, `gateway failure: ${error?.message ?? error}`)
      else res.end()
    })
  })
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve(undefined) })
  })
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  return {
    server,
    host,
    port: bound,
    url: `http://${host}:${bound}/v1`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve(undefined)))),
  }
}
