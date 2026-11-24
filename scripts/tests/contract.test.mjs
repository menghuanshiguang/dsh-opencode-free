// The two kept groups must still be the two kept groups on the wire.
//
// The lock in docs/fingerprint-baseline.json was produced by the harness on
// ubuntu-latest from the upstream source modules; the value below is recomputed
// here from the vendored bundle through a platform-independent path, so a drift
// of one byte in any of the 13 contracts or in the system prompt fails here
// rather than at the upstream, where it would look like a quota error.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('docs/fingerprint-baseline.json', ROOT), 'utf8'))
const { applyFingerprint } = await import(new URL('src/upstream.js', ROOT).href)
const { CLIENT_UA, V2_CLIENT_VERSION, V2_OFFICIAL_TOOL_ORDER, officialToolDefinition, v2ShellDescription } =
  await import(new URL('src/o2a.js', ROOT).href)

const sha = value => createHash('sha256').update(value).digest('hex')

/** The lane's own rendering, with the host platform pinned to the lock's one. */
function toolsFor(platform) {
  return V2_OFFICIAL_TOOL_ORDER.map(name => {
    const definition = officialToolDefinition(name)
    assert.ok(definition, `the asset still declares ${name}`)
    return {
      type: 'function',
      function: {
        name,
        description: name === 'shell' ? v2ShellDescription(definition.description, platform) : definition.description,
        parameters: definition.parameters,
        strict: false,
      },
    }
  })
}

test('the 13 tool contracts hash to the committed lock', () => {
  const tools = toolsFor(lock.platform ?? 'linux')
  assert.equal(tools.length, 13)
  assert.equal(sha(JSON.stringify(tools)), lock.toolsSha256)
})

test('the wire order is the lane official order, alphabetically', () => {
  assert.deepEqual([...V2_OFFICIAL_TOOL_ORDER], [...V2_OFFICIAL_TOOL_ORDER].sort())
  assert.deepEqual(V2_OFFICIAL_TOOL_ORDER, ['edit', 'glob', 'grep', 'patch', 'question', 'read', 'shell', 'skill', 'subagent', 'todowrite', 'webfetch', 'websearch', 'write'])
})

test('shaping a chat body appends exactly the 13 official tools, in order, with strict:false', () => {
  const body = {
    model: 'nemotron-3.5-lightning-free',
    messages: [{ role: 'user', content: 'Do not use tools. Reply with exactly: PONG' }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128,
  }
  applyFingerprint(body, false)
  assert.deepEqual(body.tools.map(tool => tool.function.name), [...V2_OFFICIAL_TOOL_ORDER])
  for (const tool of body.tools) {
    assert.deepEqual(Object.keys(tool.function).sort(), ['description', 'name', 'parameters', 'strict'])
    assert.equal(tool.function.strict, false)
  }
  const system = body.messages.find(message => message.role === 'system')
  assert.ok(system, 'the official prompt is injected')
  assert.match(String(system.content), /^You are an AI agent running in OpenCode, a coding agent harness\./)
  assert.match(String(system.content), /<env>[\s\S]*?<\/env>/)
  assert.doesNotMatch(String(system.content), /\$\{[A-Za-z_]+\}/)
  assert.equal(body.stream, true)
  assert.equal(body.stream_options.include_usage, true)
})

test('the client identity is the released v2 shape', () => {
  assert.equal(V2_CLIENT_VERSION, '2.2.3')
  assert.equal(CLIENT_UA, `opencode/latest/${V2_CLIENT_VERSION}/cli`)
})

test('a title-shaped body keeps the caller shape instead of shipping an agent tool list', async () => {
  const { isTitleRequest } = await import(new URL('src/upstream.js', ROOT).href)
  const title = { model: 'x-free', messages: [{ role: 'user', content: 'Generate a title for this conversation' }] }
  assert.equal(isTitleRequest(title, false), true)
  const shaped = { ...title, tools: [{ type: 'function', function: { name: 'mine', description: 'd', parameters: { type: 'object' } } }] }
  assert.equal(isTitleRequest(shaped, false), false)
})
