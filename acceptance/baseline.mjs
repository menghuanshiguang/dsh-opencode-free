#!/usr/bin/env node
// 从赛道代码重建 runner(linux) 指纹基线。用于解释/复核 0.8，不是 CI 的判据来源（判据是 docs/fingerprint-baseline.json）。
//
//   node acceptance/baseline.mjs --upstream ../upstream --out /tmp/baseline.json
//
// 两个口径分开写：
//   toolsSha256Wire       = sha256(JSON.stringify(body.tools))   线上字节，与 gates 0.8 同源
//   toolsSha256Unwrapped  = 去掉 type/function 包装后的哈希       仅供对照，不参与判定
//   systemPromptSha256Normalized = 把 cwd 两行与日期换成占位符后的哈希（Platform 行保留）
import crypto from 'node:crypto'
import { writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const upstream = arg('--upstream')
if (!upstream) { console.error('需要 --upstream <包含 src/upstream.js 的上游 checkout>'); process.exit(2) }
const out = arg('--out') ?? 'baseline.json'
if (process.platform !== 'linux') Object.defineProperty(process, 'platform', { value: 'linux' })
const { applyFingerprint, endpointFor, sessionForConversation } = await import(`${upstream}/src/upstream.js`)
const { gatewayHeaders } = await import(`${upstream}/src/o2a/headers.js`)
const { CLIENT_UA } = await import(`${upstream}/src/o2a/version.js`)
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const normalizeSystem = s => s
  .replace(/^(  Working directory: ).*$/m, '$1<cwd>')
  .replace(/^(  Workspace root folder: ).*$/m, '$1<cwd>')
  .replace(/^(  Today's date: ).*$/m, "$1<date>")
const model = arg('--model') ?? 'nemotron-3.5-lightning-free'
const body = { model, messages: [{ role: 'user', content: 'Do not use tools. Reply with exactly: PONG' }], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 128 }
applyFingerprint(body, false)
const sys = body.messages.find(m => m.role === 'system' || m.role === 'developer')
const sysText = typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '')
const tools = (body.tools ?? []).map(t => t.function ?? t)
const session = sessionForConversation(`oc-free-live:${model}`)
const headers = gatewayHeaders({ session, project: session, stream: true, anthropic: endpointFor(model).includes('/messages') })
const baseline = {
  model,
  userAgent: CLIENT_UA,
  endpoint: endpointFor(model),
  toolsSha256Wire: sha(JSON.stringify(body.tools)),
  toolsSha256Unwrapped: sha(JSON.stringify(tools)),
  toolCount: tools.length,
  toolNames: tools.map(t => t.name),
  systemPromptSha256Normalized: sha(normalizeSystem(sysText)),
  bodyKeys: Object.keys(body).sort(),
  sessionRegex: '^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$',
  sessionPhaseWindowHours: 720,
  xOpencodeHeaders: Object.keys(headers).filter(k => k.startsWith('x-opencode')).sort(),
}
writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`)
console.log(JSON.stringify({ wrote: out, toolsSha256Wire: baseline.toolsSha256Wire, tools: baseline.toolCount }))
