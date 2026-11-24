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
 * @module src/gateway.js
 */

import { createServer } from 'node:http'

import { CODE, getJson, postStreamed } from './http.js'
import { applyFingerprint, endpointFor, restoreToolName, sessionForConversation, truncateSession } from './upstream.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18787
const MODELS_PATH = '/inference/v1/models'

/** Fields this gateway forwards from an OpenAI chat body; everything else is local. */
const CARRIED = [
  'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens',
  'max_completion_tokens', 'stop', 'response_format', 'seed', 'presence_penalty',
  'frequency_penalty', 'logit_bias', 'parallel_tool_calls',
]

/** HTTP status for one upstream refusal class, so a caller can act on it. */
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

/** The free lane's model ids all end in `-free`; anything else is a paid request we must not send. */
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

function sendError(res, status, message, code = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type: code, code } })
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error(`request body over ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new Error('empty request body')
  return JSON.parse(text)
}

/** One SSE frame as an OpenAI stream chunk. */
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

  /** The conversation identity this request runs under: one upstream quota bucket per caller conversation. */
  const sessionFor = req => truncateSession(sessionForConversation(
    String(req.headers['x-free-lane-conversation'] ?? options.conversation ?? 'gateway').trim() || 'gateway',
  ))

  async function handleModels(req, res) {
    const session = sessionFor(req)
    try {
      const listing = await lane.models({ session })
      const rows = Array.isArray(listing?.data) ? listing.data : []
      const free = rows.filter(row => isFreeLaneModel(row?.id))
      // The count is what this request observed in the upstream listing, carried
      // out of the process so no artifact has to hard-code a number.
      sendJson(res, 200, { object: 'list', data: free }, { 'x-free-lane-models': String(free.length) })
    } catch (error) {
      upstreamFailure(res, error)
    }
  }

  async function handleChat(req, res) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return sendError(res, 400, `could not read the request body: ${error?.message ?? error}`)
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
    // The rename map is the only thing the gateway may use to touch the response:
    // the caller's tool spellings have to come back, and nothing else is changed.
    const renames = applyFingerprint(payload, false)
    const session = sessionFor(req)
    const wantsStream = body.stream === true
    const created = Math.floor(Date.now() / 1000)
    const id = `chatcmpl-${created}-${session.slice(-8)}`

    let text = ''
    let usage
    let finish = null
    let wrote = false
    /** Tool calls aggregated for the non-streaming answer, keyed by their index. */
    const calls = new Map()
    const restore = name => restoreToolName(name, renames)
    /** Put the caller's tool spelling back on every name the model returned. */
    const restoreChunk = chunk => {
      const choice = chunk?.choices?.[0]
      for (const call of choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? []) {
        const name = call?.function?.name
        if (typeof name === 'string' && name !== '') call.function.name = restore(name)
      }
      const legacy = choice?.delta?.function_call
      if (legacy && typeof legacy.name === 'string' && legacy.name !== '') legacy.name = restore(legacy.name)
      return chunk
    }
    const onData = raw => {
      if (raw === '[DONE]') return
      let chunk
      try { chunk = JSON.parse(raw) } catch { return }
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
      restoreChunk(chunk)
      if (wantsStream) {
        if (!wrote) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          wrote = true
        }
        res.write(frame(chunk))
      }
    }

    try {
      await lane.stream({ path: endpointFor(body.model), body: payload, session, onData })
    } catch (error) {
      if (wrote) {
        // Headers are gone; the refusal travels as an error frame, then the
        // stream ends. Never a second attempt.
        res.write(frame({ error: { message: String(error?.message ?? error), code: error?.code ?? 'upstream_error' } }))
        res.end(frame('[DONE]'))
        return
      }
      return upstreamFailure(res, error)
    }

    if (wantsStream) {
      if (!wrote) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      res.end(frame('[DONE]'))
      return
    }
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: calls.size > 0 ? null : text,
          ...(calls.size > 0
            ? { tool_calls: [...calls.values()].map((call, index) => ({ id: call.id ?? `call_${index}`, type: 'function', function: { name: restore(call.function.name), arguments: call.function.arguments } })) }
            : {}),
        },
        finish_reason: finish ?? (calls.size > 0 ? 'tool_calls' : 'stop'),
      }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  function upstreamFailure(res, error) {
    if (res.headersSent) { res.end(); return }
    const code = error?.code ?? 'upstream_error'
    const status = statusFor(code)
    sendJson(res, status, {
      error: {
        message: String(error?.message ?? error),
        type: 'upstream_error',
        code,
        status: error?.status,
      },
    }, { 'x-free-lane-code': String(code) })
  }

  /** The whole surface: two routes, and a 404/405 for everything else. */
  async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}`}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path === '/v1/models') {
      if (req.method !== 'GET') return sendError(res, 405, 'only GET /v1/models', 'method_not_allowed')
      return handleModels(req, res)
    }
    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') return sendError(res, 405, 'only POST /v1/chat/completions', 'method_not_allowed')
      return handleChat(req, res)
    }
    return sendError(res, 404, `no route ${req.method} ${path}`)
  }

  return { handler, host, describe: () => ({ routes: ['GET /v1/models', 'POST /v1/chat/completions'], workDir: workDir ?? null }) }
}

/** Start the gateway on a socket and return the handle needed to stop it. */
export async function startGateway(options = {}) {
  const gateway = createGateway(options)
  const server = createServer((req, res) => {
    gateway.handler(req, res).catch(error => {
      if (!res.headersSent) sendError(res, 500, `gateway failure: ${error?.message ?? error}`)
      else res.end()
    })
  })
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  return {
    server,
    host,
    port: bound,
    url: `http://${host}:${bound}/v1`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}
