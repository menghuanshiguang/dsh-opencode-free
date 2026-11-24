#!/usr/bin/env node
// 13 个工具描述的「渲染后字节」核对：官方 v2.2.3 源 → 渲染串 → 与资产逐字节比。
// 自带字面量扫描器（不是正则配对），不复用上游抽取器、不复用实现者的 reporter。
//
//   node acceptance/verify-rendered.mjs                    # 匿名取源（13 个文件 + 资产）
//   node acceptance/verify-rendered.mjs --cache <dir>      # 用本地已下载的官方源（cache/<path>）
//   node acceptance/verify-rendered.mjs --asset <file>     # 用本地资产文件
//
// 退出码：0 = 13/13 一致；1 = 有不一致或取源失败。
import fs from 'node:fs'
import path from 'node:path'
const TAG = 'v2.2.3'
const REPO = 'sst/opencode'
const ASSET_URL = 'https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/f29116baea55483ff067c1816966f1d08d8f0981/src/o2a/assets/ofm-tool-contracts.json'
const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const cache = arg('--cache')
const assetFile = arg('--asset')
async function read(rel) {
  if (cache) return fs.readFileSync(path.join(cache, rel), 'utf8')
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${TAG}/${rel}`)
  if (!res.ok) throw new Error(`fetch ${rel}: ${res.status}`)
  return res.text()
}
const assetDoc = JSON.parse(assetFile ? fs.readFileSync(assetFile, 'utf8') : await (await fetch(ASSET_URL)).text())
const dedent = s => {
  const lines = s.replace(/^\r?\n/, '').replace(/\s+$/, '').split('\n')
  const ind = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)[0].length))
  return lines.map(l => l.slice(ind)).join('\n')
}
const decodeQuote = (q, raw) => q === '"'
  ? (() => { try { return JSON.parse(`"${raw}"`) } catch { return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') } })()
  : q === "'" ? raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  : raw.replace(/\\`/g, '`').replace(/\\\$/g, '$')
function literalAt(src, idx) {
  let s = idx
  while (s > 0 && !'"`\''.includes(src[s])) s--
  const q = src[s], end = () => { let i = s + 1, raw = ''; while (i < src.length) { const c = src[i]; if (c === '\\') { raw += c + (src[i + 1] ?? ''); i += 2; continue } if (c === q) break; raw += c; i++ } return { raw, i } }
  const { raw, i } = end()
  return { value: decodeQuote(q, raw), end: i }
}
const scanAll = block => { const out = []; let i = 0; while (i < block.length) { if ('"`\''.includes(block[i])) { const l = literalAt(block, i); out.push(l.value); i = l.end + 1; continue } i++ } return out }
const renderRuntime = s => s.replace(/\$\{new Date\(\)\.getFullYear\(\)\}/g, String(new Date().getUTCFullYear()))
const norm = s => renderRuntime(s).replace(/\$\{OS\}/g, '@OS@').replace(/\$\{shell\}/g, '@SHELL@')
const vars = v => [['原样', v], ['dedent', dedent(v)], ['trim', v.trim()], ['dedent+trim', dedent(v).trim()]]
const plan = [
  ['read', 'packages/core/src/tool/plugin/read.ts'], ['edit', 'packages/core/src/tool/plugin/edit.ts'],
  ['grep', 'packages/core/src/tool/plugin/grep.ts'], ['write', 'packages/core/src/tool/plugin/write.ts'],
  ['glob', 'packages/core/src/tool/plugin/glob.ts'], ['webfetch', 'packages/core/src/tool/plugin/webfetch.ts'],
  ['question', 'packages/core/src/tool/plugin/question.ts'], ['websearch', 'packages/core/src/tool/plugin/websearch.ts'],
  ['skill', 'packages/core/src/tool/plugin/skill.ts'], ['subagent', 'packages/core/src/tool/plugin/subagent.ts'],
  ['shell', 'packages/core/src/tool/plugin/shell.ts'], ['patch', 'packages/core/src/tool/patch.txt'],
  ['todowrite', 'packages/core/src/tool/todowrite.txt'],
]
let pass = 0
const fails = []
for (const [tool, rel] of plan) {
  const want = String(assetDoc[tool]?.description ?? '')
  let src
  try { src = await read(rel) } catch (e) { fails.push(`${tool}:${e.message}`); console.log(`FAIL  ${tool.padEnd(10)} 取源失败`); continue }
  let note = null
  if (rel.endsWith('.txt')) {
    for (const [vn, v] of vars(src)) if (norm(v) === norm(want)) { note = `整文件 · ${vn}`; break }
  } else {
    const anchor = src.indexOf(want.slice(0, 22))
    if (anchor >= 0) {
      const lit = literalAt(src, anchor)
      for (const [vn, v] of vars(lit.value)) if (norm(v) === norm(want)) { note = `${lit.q} 字面量 · ${vn}`; break }
      if (!note) {
        const joinIdx = src.indexOf('.join(', anchor)
        const block = src.slice(src.lastIndexOf('[', anchor), joinIdx > 0 ? joinIdx : anchor + 200)
        const rawSep = joinIdx > 0 ? (src.slice(joinIdx).match(/\.join\((['"])(.*?)\1\)/) ?? [])[2] ?? '\\n' : '\\n'
        const sep = (() => { try { return JSON.parse(`"${rawSep}"`) } catch { return rawSep } })()
        const joined = scanAll(block).join(sep)
        for (const [vn, v] of vars(joined)) if (norm(v) === norm(want)) { note = `行数组 join(${JSON.stringify(sep)}) · ${vn}`; break }
      }
    }
  }
  if (note) { pass++; console.log(`PASS  ${tool.padEnd(10)} ${note}  [${Buffer.byteLength(want)}B]`) }
  else { fails.push(tool); console.log(`FAIL  ${tool.padEnd(10)} 渲染串与资产不符  [${Buffer.byteLength(want)}B]`) }
}
console.log(JSON.stringify({ tools: plan.length, pass, fail: fails.length, fails }))
process.exit(fails.length ? 1 : 0)
