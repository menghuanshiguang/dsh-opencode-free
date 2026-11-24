// Byte-for-byte contract gate for the free lane.
//
// Judged by the machine, never by eye: this builds the exact body the lane sends
// (`applyFingerprint`, the same call `scripts/oc-free-live-test.mjs` makes) and
// compares it against the pinned assets extracted from opencode v2.2.3.
//
//   - 13 tools, each description AND parameters schema identical to the asset
//     (canonical-JSON compare, so key order cannot hide a diff). The `shell`
//     description is the one templated value: its `${OS}`/`${shell}` slots are
//     rendered here from an independent table taken from the source selectors,
//     and the lane's own rendering must agree with it.
//   - the system prompt is the asset's own text with only the tool-guidance slot
//     filled and the per-request environment block appended;
//   - the User-Agent is the released v2 client shape for the pinned version.
//
// It also prints `toolsSha256` — sha256 of the tools array exactly as it goes on
// the wire — which is the value gate 0.8 compares against the live run.
//
// Any mismatch exits 1. Numbers printed here are computed, never typed.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assetDir, load } from './upstream.mjs'

const { applyFingerprint } = await load('src/upstream.js')
const { CLIENT_UA, V2_CLIENT_VERSION } = await load('src/o2a/version.js')
const { V2_OFFICIAL_TOOL_ORDER, v2ShellDescription } = await load('src/o2a/official-tools.js')

const model = process.argv[2] ?? 'nemotron-3.5-lightning-free'
const contracts = JSON.parse(readFileSync(new URL('ofm-tool-contracts.json', assetDir), 'utf8'))
const promptAsset = readFileSync(new URL('ofm-agent-context.txt', assetDir), 'utf8')

// The selector tables from the source, written here independently of the lane's
// own constants so that agreement is evidence rather than tautology.
const OS_WORD = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const SHELL_WORD = { win32: 'powershell', darwin: 'bash', linux: 'bash' }
const renderedShellExpected = base => base
  .replace(/\$\{OS\}/g, OS_WORD[process.platform] ?? process.platform)
  .replace(/\$\{shell\}/g, SHELL_WORD[process.platform] ?? 'bash')

const sha = value => createHash('sha256').update(value).digest('hex')
const canon = value => {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const body = {
  model,
  messages: [{ role: 'user', content: 'Do not use tools. Reply with exactly: PONG' }],
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 128,
}
applyFingerprint(body, false)

const tools = Array.isArray(body.tools) ? body.tools : []
const assetNames = Object.keys(contracts)
const wireNames = tools.map(tool => tool?.function?.name)

console.log(`\n=== tools (${tools.length} declared, ${assetNames.length} in asset) ===`)
check(tools.length === 13, '13 tools declared', String(tools.length))
check(tools.length === assetNames.length, 'declared count equals asset count')
check(wireNames.join(',') === V2_OFFICIAL_TOOL_ORDER.join(','), 'wire order is the lane’s official order', wireNames.join(','))
check([...wireNames].sort().join(',') === [...assetNames].sort().join(','), 'declared set equals the asset set')

// The asset file's key order is the fetch list's order, not the wire order. It is
// printed so nobody mistakes one for the other; the wire order above is the one
// that reaches the upstream.
if (assetNames.join(',') !== wireNames.join(',')) {
  console.log(`     note: asset key order (${assetNames.join(' ')}) differs from wire order (${wireNames.join(' ')})`)
}

for (const name of V2_OFFICIAL_TOOL_ORDER) {
  const declared = tools.find(tool => tool?.function?.name === name)?.function
  const asset = contracts[name]
  if (!declared) { check(false, `${name}: declared`); continue }
  const expectedDescription = name === 'shell' ? renderedShellExpected(asset.description) : asset.description
  if (name === 'shell') {
    check(v2ShellDescription(asset.description) === renderedShellExpected(asset.description),
      'lane shell rendering agrees with the independent selector table')
  }
  const descSame = declared.description === expectedDescription
  const schemaSame = canon(declared.parameters) === canon(asset.parameters)
  console.log(`     ${name.padEnd(11)} desc ${sha(declared.description).slice(0, 16)}  schema ${sha(canon(declared.parameters)).slice(0, 16)}  bytes ${String(declared.description.length).padStart(4)}`)
  check(descSame, `${name}: description byte-identical`)
  check(schemaSame, `${name}: parameters schema identical`)
  check(Object.keys(declared).sort().join(',') === 'description,name,parameters,strict',
    `${name}: only name/description/parameters/strict (the allowed extra)`, Object.keys(declared).sort().join(','))
  check(declared.strict === false, `${name}: strict is false`)
}

// The system prompt: the asset is the source; rendering may only fill the
// guidance slot and append the environment block.
const systemMessage = (body.messages ?? []).find(message => message?.role === 'system' || message?.role === 'developer')
const prompt = typeof systemMessage?.content === 'string' ? systemMessage.content : ''
const PLACEHOLDER = '${OPENCODE_TOOL_GUIDANCE}'
const slotAt = promptAsset.indexOf(PLACEHOLDER)
const prefix = slotAt >= 0 ? promptAsset.slice(0, slotAt) : ''
const suffix = slotAt >= 0 ? promptAsset.slice(slotAt + PLACEHOLDER.length) : ''

console.log(`\n=== system prompt (${Buffer.byteLength(prompt)} bytes, sha256 ${sha(prompt)}) ===`)
check(slotAt >= 0, 'asset still carries the guidance placeholder')
check(prompt.startsWith(prefix), 'prompt starts with the asset verbatim')
check(prompt.includes(suffix, prefix.length), 'asset tail follows the guidance slot')
check(!prompt.includes(PLACEHOLDER), 'no template placeholder reaches the wire')
check(!/\$\{[A-Za-z_]+\}/.test(prompt), 'no other template placeholder reaches the wire')
check(/Use only skills explicitly provided by the host/.test(prompt), 'host-skills line present')
check(/<env>[\s\S]*?<\/env>/.test(prompt), 'environment block present')

const envBlock = prompt.match(/<env>([\s\S]*?)<\/env>/)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
console.log(`     env block: ${envBlock}`)

// The `websearch` description carries the year the upstream client interpolates
// at request time; the asset pins the year of the tag it was captured from.
// The shipped body no longer freezes it: src/o2a.js officialTool re-renders that
// one description per request with the client's own local-clock rule, and
// acceptance/year-clock-test.mjs judges the product's render against the
// official template at any clock. Two consequences worth stating here:
//   - the asset's year differing from today's is a fact about when the asset was
//     captured, not a defect in this file's checks;
//   - `toolsSha256` above is computed from that asset, so it is a fact of the
//     asset's year: when the year turns over the committed lock has to be
//     regenerated, or gate 0.8 compares a current-year body against a tag-year
//     lock and reds while the lane itself is fine.
const yearInAsset = /The current year is (\d{4})\./.exec(tools.find(tool => tool?.function?.name === 'websearch')?.function?.description ?? '')?.[1]
const currentYear = String(new Date().getFullYear())
console.log(`\n     websearch year: asset ${yearInAsset ?? '(none)'} (pinned at the tag) — the shipped body renders ${currentYear} at request time (src/o2a.js officialTool, judged by acceptance/year-clock-test.mjs)`)
if (yearInAsset !== undefined && yearInAsset !== currentYear) {
  console.log(`     NOTE the committed toolsSha256 was produced with ${yearInAsset}; a ${currentYear} body differs from it by that one number, so the lock has to be regenerated for this year before gate 0.8 is read`)
}

console.log(`\n=== client identity ===`)
console.log(`     user-agent: ${CLIENT_UA}`)
check(V2_CLIENT_VERSION === '2.2.3', 'client version is the pinned one', V2_CLIENT_VERSION)
check(CLIENT_UA === `opencode/latest/${V2_CLIENT_VERSION}/cli`, 'user-agent is the released v2 shape')

// The one number gate 0.8 compares across CI and the live run.
const toolsSha256 = sha(JSON.stringify(tools))
console.log(`\ntoolsSha256=${toolsSha256}`)
console.log(`systemPromptSha256=${sha(prompt)}`)

if (failures.length) {
  console.error(`\nCONTRACT: FAIL (${failures.length} checks)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nCONTRACT: PASS (${assetNames.length} tool contracts + system prompt byte-identical)`)
