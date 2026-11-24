#!/usr/bin/env node
// 时钟注入测试：`websearch` 描述里的年份必须在「请求那一刻」渲染，不许冻结成资产里的那一年。
//
//   node acceptance/year-clock-test.mjs                     # 用今天
//   node acceptance/year-clock-test.mjs --clock 2027-01-01  # 跨年也不许红
//   node acceptance/year-clock-test.mjs --source <file> --asset <file>   # 离线跑
//
// 判的是**产品自己**渲染出来的那份描述（src/o2a.js 的 officialTool，请求体走的就是它），
// 不是资产文件：资产是 v2.2.3 那个 tag 的取源，年份必然停在那一刻，拿它当期望值就等于
// 要求产品跟着停在那一年。四条判据在任何时钟下都必须成立：
//
//   1) 官方模板里确实是运行时插值（恒久判据）
//   2) 产品在给定时钟下渲染出的是**那一年**
//   3) 产品渲染结果 == 官方模板在同一年份的渲染（逐字节，等价于与真客户端同字节）
//   4) 产品在资产那一年上，逐字节复现资产（说明除年份外一个字也没动）
//
// 时钟按**本地正午**构造：客户端用的是 `new Date().getFullYear()`（本地年），
// 用 UTC 零点在 UTC 以西的时区会退成前一年，那测的就不是「跨年」而是时区。
import fs from 'node:fs'
import { officialTool } from '../src/o2a.js'

const SOURCE = 'https://raw.githubusercontent.com/sst/opencode/v2.2.3/packages/core/src/tool/plugin/websearch.ts'
const ASSET = 'https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/f29116baea55483ff067c1816966f1d08d8f0981/src/o2a/assets/ofm-tool-contracts.json'
const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const read = async (url, file) => file ? fs.readFileSync(file, 'utf8') : (await fetch(url)).text()

const clockArg = arg('--clock')
const clock = new Date(clockArg ? `${clockArg}T12:00:00` : Date.now())
const year = clock.getFullYear()

const src = await read(SOURCE, arg('--source'))
const assetDoc = JSON.parse(await read(ASSET, arg('--asset')))
const assetDescription = String(assetDoc.websearch?.description ?? '')

const m = src.match(/export const description = `([\s\S]*?)`/)
if (!m) { console.log('FAIL 找不到 websearch description 模板'); process.exit(1) }
const template = m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$')
const renderOfficial = y => template.replace(/\$\{new Date\(\)\.getFullYear\(\)\}/g, String(y))

const renderedAt = at => officialTool('chat', 'websearch', at.getTime()).function.description
const product = renderedAt(clock)
const frozenYear = Number((assetDescription.match(/current year is (\d{4})/) ?? [])[1])
const atFrozen = Number.isInteger(frozenYear) ? renderedAt(new Date(`${frozenYear}-06-15T12:00:00`)) : null

const checks = [
  ['官方模板含运行时插值', /\$\{new Date\(\)\.getFullYear\(\)\}/.test(template)],
  [`产品在时钟 ${year} 渲染出 ${year}`, product.includes(`The current year is ${year}`)],
  [`产品渲染 == 官方模板在 ${year} 的渲染`, product === renderOfficial(year)],
  ...(atFrozen === null ? [] : [[`产品在 ${frozenYear}（资产那一年）逐字节复现资产`, atFrozen === assetDescription]]),
]
let fail = 0
for (const [name, ok] of checks) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`) }
console.log(JSON.stringify({
  clock: clockArg ?? clock.toISOString().slice(0, 10),
  year,
  frozenYear: Number.isInteger(frozenYear) ? frozenYear : null,
  productYear: (product.match(/current year is (\d{4})/) ?? [])[1] ?? null,
  matchesOfficial: product === renderOfficial(year),
}))
process.exit(fail ? 1 : 0)
