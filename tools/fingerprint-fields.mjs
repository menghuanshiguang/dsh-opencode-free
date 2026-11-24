// Prints the fingerprint fields of the next lane request: headers, session
// identity, and the hashes of the shippped body.
//
// It calls the lane's own functions (`applyFingerprint`, `gatewayHeaders`,
// `endpointFor`, `sessionForConversation`) — the same ones
// `scripts/oc-free-live-test.mjs` calls — so the record is the request the lane
// is about to send, not a replica of it. Run it with the SAME working directory
// as the live script: the environment block carries `process.cwd()`.
//
// Usage: node tools/fingerprint-fields.mjs <model> [outfile]
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { load } from './upstream.mjs'

const { applyFingerprint, endpointFor, sessionForConversation } = await load('src/upstream.js')
const { gatewayHeaders } = await load('src/o2a/headers.js')
const { CLIENT_UA, V2_CLIENT_VERSION } = await load('src/o2a/version.js')
const { findBunExecutable } = await load('src/bun-fetch.js')

const model = process.argv[2] ?? 'nemotron-3.5-lightning-free'
const outFile = process.argv[3]
const sha = value => createHash('sha256').update(value).digest('hex')
const canon = value => {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const body = {
  model,
  messages: [{ role: 'user', content: 'Do not use tools. Reply with exactly: PONG' }],
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 128,
}
applyFingerprint(body, false)

const path = endpointFor(model)
const session = sessionForConversation(`oc-free-live:${model}`)
const headers = gatewayHeaders({ session, project: session, stream: true, anthropic: path.includes('/messages') })
headers['user-agent'] = CLIENT_UA

const systemMessage = (body.messages ?? []).find(message => message?.role === 'system' || message?.role === 'developer')
const prompt = typeof systemMessage?.content === 'string' ? systemMessage.content : ''
const tools = Array.isArray(body.tools) ? body.tools : []
const envBlock = prompt.match(/<env>([\s\S]*?)<\/env>/)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''

// The transport the lane will actually take: `auto` + a resolvable Bun binary is
// the production Bun worker; anything else is the node fallback, which is not
// acceptance evidence (constraint 2).
const transportEnv = process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? ''
const bunPath = (() => { try { return findBunExecutable() ?? '' } catch { return '' } })()
const resolvedTransport = transportEnv === '' || transportEnv === 'auto'
  ? (bunPath ? 'bun' : 'missing-bun')
  : transportEnv

const fields = {
  at: new Date().toISOString(),
  model,
  endpoint: path,
  cwd: process.cwd(),
  node: process.version,
  platform: process.platform,
  clientVersion: V2_CLIENT_VERSION,
  transport: { env: transportEnv || '(unset)', bun: bunPath, resolved: resolvedTransport },
  userAgent: headers['user-agent'],
  authorization: headers.authorization,
  headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'authorization')),
  sessionId: session,
  envBlock,
  bodyKeys: Object.keys(body).sort(),
  systemPrompt: { bytes: Buffer.byteLength(prompt), sha256: sha(prompt) },
  systemPromptSha256: sha(prompt),
  toolCount: tools.length,
  toolsSha256: sha(JSON.stringify(tools)),
  tools: tools.map(tool => ({
    name: tool?.function?.name,
    description: { bytes: (tool?.function?.description ?? '').length, sha256: sha(tool?.function?.description ?? '') },
    parameters: { sha256: sha(canon(tool?.function?.parameters)) },
  })),
}

const text = JSON.stringify(fields, null, 2)
console.log(`transport: ${resolvedTransport} (OUR_FREE_MODEL_FREE_TRANSPORT=${transportEnv || '(unset)'}, bun=${bunPath || '(not found)'})`)
console.log(`toolsSha256=${fields.toolsSha256}`)
console.log(`systemPromptSha256=${fields.systemPromptSha256}`)
console.log(text)
if (outFile) writeFileSync(outFile, text)
