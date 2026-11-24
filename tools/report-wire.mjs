// Reads the wire tap and reports what the upstream answered, with the request's
// identity re-derived from the very bytes that were sent.
//
// Usage: node tools/report-wire.mjs --dir <wire dir> [--expect <fields.json>]
//
// --expect is the fingerprint dump taken on the same runner, in the same working
// directory, before the live call. If the wire bytes and the dump disagree, the
// dump is not evidence and this exits 1 — that is the point of comparing them
// instead of printing both.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetDir } from './upstream.mjs'

const args = process.argv.slice(2)
const valueOf = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined }
const dir = valueOf('--dir') ?? process.env.OFM_WIRE_DIR
const expectFile = valueOf('--expect')

const sha = value => createHash('sha256').update(value).digest('hex')
const canon = value => {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const contracts = JSON.parse(readFileSync(new URL('ofm-tool-contracts.json', assetDir), 'utf8'))

const file = join(dir ?? '', 'wire.jsonl')
if (!dir || !existsSync(file)) {
  console.error(`REPORT: FAIL — no wire capture at ${file}`)
  process.exit(1)
}

const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const requests = records.filter(record => record.kind === 'request')
const responses = records.filter(record => record.kind === 'response')

console.log(`=== wire capture ===`)
console.log(`records: ${records.length} (requests ${requests.length}, responses ${responses.length})`)

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

check(requests.length === 1, 'exactly one request was sent', String(requests.length))

if (requests.length === 1) {
  const sent = JSON.parse(requests[0].body)
  const tools = Array.isArray(sent.tools) ? sent.tools : []
  const prompt = (sent.messages ?? []).find(message => message?.role === 'system' || message?.role === 'developer')?.content ?? ''
  const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
  const envBlock = promptText.match(/<env>([\s\S]*?)<\/env>/)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''

  console.log(`\n=== request actually sent (${requests[0].bytes} bytes, sha256 ${requests[0].sha256}) ===`)
  console.log(`model: ${sent.model}`)
  console.log(`body keys: ${Object.keys(sent).sort().join(', ')}`)
  console.log(`stream: ${sent.stream} stream_options: ${JSON.stringify(sent.stream_options)} max_completion_tokens: ${sent.max_completion_tokens}`)
  console.log(`env: ${envBlock}`)

  const assetNames = Object.keys(contracts)
  check(tools.length === 13, '13 tools on the wire', String(tools.length))
  check(tools.map(tool => tool?.function?.name).join(',') === assetNames.join(','), 'tool order equals the pinned asset order')

  console.log(`\n=== tool contracts on the wire ===`)
  for (const name of assetNames) {
    const fn = tools.find(tool => tool?.function?.name === name)?.function
    const asset = contracts[name]
    const descSha = sha(fn?.description ?? '')
    const schemaSha = sha(canon(fn?.parameters))
    const ok = fn?.description === asset.description && canon(fn?.parameters) === canon(asset.parameters)
    console.log(`     ${name.padEnd(11)} desc ${descSha.slice(0, 16)}  schema ${schemaSha.slice(0, 16)}  ${ok ? 'identical' : 'DIFFERS'}`)
    check(ok, `${name}: wire description and schema are the pinned asset`)
  }

  console.log(`\n=== system prompt on the wire ===`)
  console.log(`     bytes ${Buffer.byteLength(promptText)}  sha256 ${sha(promptText)}`)
  const promptAsset = readFileSync(new URL('ofm-agent-context.txt', assetDir), 'utf8')
  const PLACEHOLDER = '${OPENCODE_TOOL_GUIDANCE}'
  const slotAt = promptAsset.indexOf(PLACEHOLDER)
  check(slotAt >= 0, 'asset still carries the guidance placeholder')
  check(promptText.startsWith(promptAsset.slice(0, slotAt)), 'prompt starts with the asset verbatim')
  check(promptText.includes(promptAsset.slice(slotAt + PLACEHOLDER.length), slotAt), 'asset tail follows the guidance slot')
  check(!promptText.includes(PLACEHOLDER), 'no template placeholder on the wire')

  if (expectFile && existsSync(expectFile)) {
    const expected = JSON.parse(readFileSync(expectFile, 'utf8'))
    console.log(`\n=== wire bytes vs fingerprint dump (${expectFile}) ===`)
    check(expected.systemPrompt?.sha256 === sha(promptText), 'system prompt matches the dump', `${expected.systemPrompt?.sha256} vs ${sha(promptText)}`)
    check(expected.toolCount === tools.length, 'tool count matches the dump')
    const dumped = new Map((expected.tools ?? []).map(tool => [tool.name, tool]))
    for (const name of assetNames) {
      const fn = tools.find(tool => tool?.function?.name === name)?.function
      const dump = dumped.get(name)
      check(!!dump, `${name}: present in the dump`)
      if (!dump) continue
      check(dump.description?.sha256 === sha(fn?.description ?? ''), `${name}: description matches the dump`)
      check(dump.parameters?.sha256 === sha(canon(fn?.parameters)), `${name}: schema matches the dump`)
    }
    check(expected.sessionId?.startsWith('ses_'), 'session id has the client shape', expected.sessionId)
    console.log(`     user-agent: ${expected.userAgent}`)
    console.log(`     session id:  ${expected.sessionId}`)
  } else if (expectFile) {
    check(false, `fingerprint dump missing: ${expectFile}`)
  }
}

// The answer, verbatim.
if (responses.length) {
  for (const response of responses) {
    console.log(`\n=== upstream response (HTTP ${response.status}, ${response.bytes} bytes, sha256 ${response.sha256}) ===`)
    console.log(`headers: ${JSON.stringify(response.headers)}`)
    console.log('raw body:')
    console.log(response.body)
    let envelope
    try { envelope = JSON.parse(response.body) } catch { envelope = null }
    if (envelope) {
      const type = envelope?.error?.type ?? envelope?.type ?? ''
      const code = envelope?.error?.code ?? envelope?.code ?? ''
      console.log(`envelope.error.type: ${JSON.stringify(type)}`)
      console.log(`envelope.error.code: ${JSON.stringify(code)}`)
    }
  }
} else {
  console.log('\nno non-2xx response body was read by the lane (a 200 streams instead; see the live step output)')
}

if (failures.length) {
  console.error(`\nREPORT: FAIL (${failures.length} checks)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nREPORT: PASS')
