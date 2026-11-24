#!/usr/bin/env node
// 时钟注入测试：websearch 描述里的 `${new Date().getFullYear()}` 必须在"求值那一刻"渲染。
//
//   node acceptance/year-clock-test.mjs                 # 用今天
//   node acceptance/year-clock-test.mjs --clock 2027-01-01
//
// 判据分两层（别把已知状态写成硬断言，否则修好之后门自己会红）：
//   1) 模板里存在运行时插值        —— 恒久判据，任何时候都必须 PASS
//   2) 渲染(year) 与资产逐字节一致 —— 状态判据；冻结年被跨过时必然 FAIL
//
// 默认匿名取源（raw.githubusercontent.com），可用 --source / --asset 指向本地文件。
import fs from 'node:fs'
import crypto from 'node:crypto'
const SOURCE = 'https://raw.githubusercontent.com/sst/opencode/v2.2.3/packages/core/src/tool/plugin/websearch.ts'
const ASSET = 'https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/f29116baea55483ff067c1816966f1d08d8f0981/src/o2a/assets/ofm-tool-contracts.json'
const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const read = async (url, file) => file ? fs.readFileSync(file, 'utf8') : (await fetch(url)).text()
const clock = new Date(arg('--clock') ? `${arg('--clock')}T00:00:00Z` : Date.now())
const year = clock.getUTCFullYear()
const src = await read(SOURCE, arg('--source'))
const assetDoc = JSON.parse(await read(ASSET, arg('--asset')))
const asset = String(assetDoc.websearch?.description ?? '')
const m = src.match(/export const description = `([\s\S]*?)`/)
if (!m) { console.log('FAIL 找不到 websearch description 模板'); process.exit(1) }
const template = m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$')
const rendered = template.replace(/\$\{new Date\(\)\.getFullYear\(\)\}/g, String(year))
const frozenYear = (asset.match(/current year is (\d{4})/) ?? [])[1]
const checks = [
  ['模板含运行时插值', /\$\{new Date\(\)\.getFullYear\(\)\}/.test(template)],
  [`渲染(${year}) 含 ${year}`, rendered.includes(`The current year is ${year}`)],
  [`时钟=${year} 时资产与渲染逐字节一致`, rendered === asset],
]
let fail = 0
for (const [name, ok] of checks) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`) }
console.log(JSON.stringify({ clock: clock.toISOString().slice(0, 10), year, frozenYear, equal: rendered === asset }))
if (rendered !== asset) console.log(`已知状态：资产冻结在 ${frozenYear}，客户端在 ${year} 会渲染 ${year}；抽出的产品必须改成运行时渲染。`)
process.exit(fail ? 1 : 0)
