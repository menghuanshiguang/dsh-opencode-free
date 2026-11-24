// 断言 entry：读 POS/NEG/NEGB 三个 gates.json，按预期判放行/拦截。
import fs from 'node:fs'
const load = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const pos = load(process.env.POS), neg = load(process.env.NEG), negb = load(process.env.NEGB)
const bad = []
if (pos.passed !== true) bad.push('pos 未全绿')
for (const k of ['0.3-transport-bun', '0.5-200-pong', '0.6-billing-source', '0.7-single-request', '0.9-inputs-present'])
  if (neg.checks?.[k]?.pass !== false) bad.push(`neg 未拦下 ${k}`)
if (neg.passed !== false) bad.push('neg 不该 passed')
if (negb.checks?.['0.3-no-node-transport']?.pass !== false) bad.push('negb 未拦下 node 传输')
console.log(JSON.stringify({ pos: { passed: pos.passed, postCount: pos.postCount }, neg: { passed: neg.passed, failed: Object.entries(neg.checks ?? {}).filter(([, v]) => v.pass !== true).map(([k]) => k) }, negb: { passed: negb.passed, failed: Object.entries(negb.checks ?? {}).filter(([, v]) => v.pass !== true).map(([k]) => k) } }))
if (bad.length) { console.log('FAIL', bad.join('; ')); process.exit(1) }
console.log('FIXTURES: PASS')
