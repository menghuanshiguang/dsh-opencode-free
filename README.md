# dsh-opencode-free

OpenCode 免费车道独立版：逐字节复刻官方 v2.2.3 客户端请求体，直连 opencode.ai 免费车道，对外只暴露一个本地 OpenAI 兼容网关。独立包，不是 DSH 插件：插件外壳（`index.js`、`client.js`、`adapters`）按阶段 2 的剥离判据不保留。

## 许可证

MIT。本仓库派生自
[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（commit `f29116ba`，仅作只读参考），上游本身亦为 MIT 许可。

- `LICENSE` 逐字保留上游原文，含其第三方声明
  （models.dev、opencode、RTK、9router）与派生说明，并另加一行：
  `Copyright (c) 2026 menghuanshiguang (dsh-opencode-free modifications)`。
- GitHub 对本仓库报 `spdx_id: NOASSERTION`，原因是该 LICENSE 是一份合成文本
  （MIT 加四条第三方声明再加一段派生说明），其检测器不把它归类为纯 MIT。
  授权本身仍是 MIT，如此处与 `LICENSE` 所述。

## 这条车道是什么

只保留官方 OC 免费车道与一个本地 OpenAI 兼容网关。上游的十账号渠道路由、
EAC 与管理页均已删除，不留开关、不留死代码分支。

live 请求一律从 GitHub Actions（`ubuntu-latest`）经生产 Bun worker 发出；
node 传输只是诊断用的兜底，永远不作为验收证据。

## 用法

```bash
npm install                       # 仅类型检查需要；运行期没有任何依赖
node -e "import('./src/gateway.js').then(async m => {
  const g = await m.startGateway({ port: 18787 })
  console.log(g.url)
})"
```

两条路由，别的一概没有：

| 路由 | 做什么 |
| --- | --- |
| `GET /v1/models` | 免费车道的 id，在请求时刻从线上列表读出（绝不写死在这里） |
| `POST /v1/chat/completions` | 一次免费车道往返；`stream: true` 时原样转发上游 SSE 帧 |

任何其他路径回 404、其他方法回 405 —— 没有管理页、没有统计路由、没有鉴权、
没有计费、没有限流，因为这里没有任何东西需要管理。不以 `-free` 结尾的模型 id
在本地就被 400 拒绝，所以付费请求不可能被误发出去。

出站的请求体就是 `src/upstream.js` 整形出的那一份：官方 v2.2.3 的 system prompt、
13 条工具契约按车道的线上顺序、`x-opencode-*` 身份，以及带真实时间戳的 session id。
把调用方的 JSON 原样转出去会被免费层拒绝（403 FreeTierError / 429），
所以整形不是可选项。

## 环境要求与限制

**Bun 是这条车道的前置。** 网关本身是一个 Node `>=20` 的 `node:http` 服务，
运行期没有依赖，但每一个发往 `opencode.ai/inference/*` 的请求——补全与模型列表
都一样——都经过 `src/bun-fetch.js` 里的生产 Bun worker，那是发布版客户端自己的
fetch 栈。找不到 `bun` 可执行文件时（先找 `$OUR_FREE_MODEL_BUN`，再找
`~/.bun/bin/bun`，再找 `PATH` 上的 `bun`），车道请求会以

```
Bun executable not found; set OUR_FREE_MODEL_BUN to a native executable.
```

失败，并且不会回落到 Node 传输上重试。那条路径只作诊断存在，永远不是验收证据：
只有 Node 的运行从来不是本仓库所说的通过。

**只走免费车道，任何地方都没有凭据。** 没有账号可加、没有密钥要设、没有渠道可选。
车道是匿名到达的，请求体是官方发布版的形状，不以 `-free` 结尾的模型 id 在本地
就被 400 拒绝——付费请求不可能误发，也没有任何配置能让它被发出去。

**一次一条请求，同一时刻一发。** `free-lane-live` 只允许 `workflow_dispatch`。
`confirm` 必须恰为 `true`，含空格或逗号的模型 id 会被拒绝（"exactly one model per
run"），id 必须匹配 `^[a-z0-9][a-z0-9.-]*-free$`。只要还有另一个 live run 处于
`queued`、`in_progress`、`waiting`、`requested` 或 `pending`，它拒绝启动；并且在
`live request` 这一步真的跑过的 run 之后保持 900 秒冷却——在那一步之前就停下的
run 什么也没花，不触发冷却。900 秒是地板，不是工作规则：两次 live 之间至少隔
一小时，而"workflow 允许"从来不是派发它的理由。

**`websearch` 描述里的年份是按请求时刻渲染的**，与官方客户端一致。工具描述里带着
`The current year is <year>.`；出站体替换成请求组装那一刻的年份（`src/o2a.js`），
而不是冻结资产里的那一个。所以当时钟落在资产自己的年份（2026）时，本产品逐字节
复现资产；其他年份则渲染当年，因为发布的客户端发出去的就是当年。
`docs/fingerprint-baseline.json` 记录的是资产当年（2026）的 `toolsSha256`：那一年
出站体逐字节复现资产，任何更晚的年份则渲染当年、且与官方模板该年的渲染相等，
而记录下来的锁值**只在资产当年内**才可作比对。这个后果值得事先说清，免得
有人用更贵的方式重新发现：到 2027 年，一次 live 的 `toolsSha256` 会与锁值不等，
gate 0.8 会如实报红，而指纹一个字节都没动——动的是日历。这与"请求体已不再与
官方客户端一致"是两种不同的失败。`node acceptance/year-clock-test.mjs --clock
<year>` 是这道行为的死门，永远带着时钟跑，不单凭今天的日期：`--clock 2027-01-01`
必须 exit 0，而描述重新冻结回资产年份、或渲染不再等于官方模板对注入时钟的渲染，
两者都会让它红。

**派生代码随它的声明同行。** 本包是 MIT，派生自
`Ebony-Vinyl/dsh-our-free-model` 的 `f29116ba`；`LICENSE` 带上游原文与其第三方
声明，并且随包发布（`package.json` 的 `files`），不只是留在仓库里。

## 证据必须能变红

本仓库对任何一个零、一处相等、一次请求作出的断言，都随附一个能让它变红的反例。
没有反例的检查只是装饰，而诱饵看起来和通过一模一样。

这条规矩是在本仓库抓到三个真例之后写下的：

| 它声称什么 | 为什么它不可能失败 | 现在什么让它失败 |
| --- | --- | --- |
| "没有尝试任何 loopback 之外的请求" | 守卫写 **stderr**，而这一步只 tee 了 stdout，`grep` 从来没见过那一行 | tee 上加 `2>&1`，加上只数守卫标记的套件计数，以及夹具里一次故意发出的出站尝试 |
| "跑了 5 个套件" | 计数器匹配 `^=== `，而那是套件自己打印的标题 | 运行器打印 `### suite: <name>`，计数器只匹配这个 |
| "transport 是生产 Bun worker" | `transport=bun` 是从配置推断的，零请求发出时同样成立 | gate 0.3 还要求 `postCount>=1`，所以零请求的 run 过不了它——dry-run 演练（`45335463823`）就是用来证明这点的 |

同一条规矩适用于契约闸门：`scripts/tests/gateway.test.mjs` 断言那些不该存在的
路由，`scripts/check-extraction.mjs` 由六个坏输入证明（多一个导出、一条 `/stats`
路由、verbatim 文件里改一个字节、被排除路径又被引回来、注释掉一条路由、一个
`if (false)` 分支），而离线计数用一个必须被拦下的请求来演示。

封存脚本也一样，而它是最容易骗过去的那一类。`scripts/tests/seal-online.test.mjs`
里**五档是一组，不是五份独立证明**：两档证明"该选中的选中了"（嵌套层、扁平层），
三档证明"该拒绝的拒绝了"（只有 `archive-`、两件同名、run 未终态）。拒绝型用例
最容易因为别的原因变绿——只要脚本在下载之前停下，"状态 1、零件下载"就成立，
至于是不是这道断言拦下的，看不出。所以那三档各配一个变异证明：把一份 seal 脚本
副本里对应的那道拒绝改掉，同一个夹具再跑一遍，断言这一档**自己的条件已经变成
假**（`archive-` 会被下载、重名会挑一个、`conclusion=null` 不再被引用）。变异本身
也要能失败：模式在脚本里不是恰好命中一次、或替换后文本没变，脚本自己先报错——
一次"改了个不存在的字符串"曾经被当成"行为无变化"读成通过。

## 剥离闸门

`node scripts/check-extraction.mjs` 是阶段 2 的闸门，只有四族全部成立时它才 exit 0：

1. **导入集** —— 每个被导入的上游文件仍然与 pin 指定的 blob 同哈希，或在
   `docs/adaptations.json` 里连同理由申报为 adapted/removed
   （`899 = 7 imported + 892 excluded`，互不相交）。这 7 个导入拆成
   `3 verbatim + 3 adapted + 1 removed`，`src/` 里是其中 6 个再加
   `1 added`（`src/gateway.js`，本包自己的入口）——声明的路径八条，磁盘上的
   模块七个，因为那个删除按定义已经不在。
   这些计数不是散文：`scripts/check-extraction.mjs` 把
   `gates/extraction-whitelist.json` 的 `verbatim`/`adapted`/`removed`/`added`
   四个列表与 `docs/adaptations.json` 及导入集双向比对，所以一处在说逐字节未动、
   另一处在说改写过的路径，会当场变红；
2. **排除可达性** —— 没有任何出站模块导入被排除的路径，这是"没有把账号渠道
   一起带过来"的机器形式；
3. **公开面** —— 入口恰好导出 `{createGateway, startGateway}`，`package.json`
   只导出 `"."`；
4. **不留残迹** —— 本包自己写的文件里没有管理/统计路由、没有凭据形状的配置名、
   没有渠道 provider、没有 EAC 标识符；`src/` 里没有死文件；没有注释掉的代码、
   没有 `if (false)`。

退出码：`0` 通过，`1` 失败（逐条列出命中），`2` 检查器本身跑不起来。只把 `1`
当失败的做法会让一次坏掉的运行看起来是绿的。

`npm test` 跑三个离线套件：契约哈希、路由面、以及替身契约（一个记录出站体的
loopback 服务，于是"网关不添加任何东西"被断言成一次 sha256 相等，而不是一句承诺）。

不带 `--live` 的 `node scripts/live-test.mjs` 打印
`Skipped: pass --live to send an actual request.` 并且什么也不发；CI 就是这么跑
它的，在网络守卫之下，并统计出站到 loopback 之外的尝试次数（期望为 0）。
`npm run typecheck` 检查本包自己写的文件（它们带 `// @ts-check`）；那四个上游文件
由它们各自的 blob sha 覆盖，而不是重新做类型检查，因为为了让检查器满意而改它们，
就会改变这条车道赖以成立的指纹。

## 验证

`free-lane-ci` 在 push 与 pull request 上跑，对推理主机零字节：`tools/guard-offline.mjs`
拒绝测试进程发出的每一个 loopback 之外的请求，而运行会把是否尝试过打印出来。

- `node tools/contract-check.mjs <model>` —— 13 条工具契约与 system prompt 对照
  pin 住的资产，外加 `toolsSha256`。
- `node tools/gates-selftest.mjs` —— 闸门校验器对一个完美 run 与六个坏 run 的判定。
- `node gates/selftest.mjs` 与 `node gates/validate.mjs` —— 档案 schema 及其反例。
- 把 `node tools/gh-anon-shim.mjs` 装成 `gh`，让那个 pin 住上游资产的取源器不带
  任何凭据就能读 `raw.githubusercontent.com`；blob SHA 在本地重算并与来源表比对。

`free-lane-live` 只用 `workflow_dispatch`，一个模型、一次请求、不重试。它拒绝
同时存在第二个 run，记录出口 IP 与国家，要求生产 Bun 传输，并在花任何额度之前
断言指纹基线。它的产物带 `gates.json`、线上抓包，以及上游原始响应。

### 档案有两种形态

写在它所描述的那条 run **内部**的档案，无法知道那条 run 是怎么结束的——那一刻
`run.conclusion` 还是 `null`，而 `failedSteps` 也不是 `[]`（还没有失败，但也还
没有跳过）。所以 run 内那份档案写 `conclusion: null`、`status: in_progress`、
`failedSteps: null`：它证明请求层与闸门，不声称结局。
`scripts/archive-live-run.sh` 产出的就是这一份。

run 结束之后，`scripts/seal-live-run.sh <run-id> --out <dir>` 用同一份归档代码
产出第二种形态，只有这一份才允许写 `conclusion: success`——它拒绝 conclusion 不是
`success`、status 不是 `completed` 的 run。它按精确的 `live-<run-id>` 名绑定产物：
同一名下还有一件 `archive-<run-id>` 也含 run id，而按"名字里含 id"选件的做法会取
API 列表里靠前的那个，于是封存档案绑到了错的产物上，而每个字段仍然通过校验。
零命中与两命中都被拒绝；不存在回落到列表顺序的做法。
