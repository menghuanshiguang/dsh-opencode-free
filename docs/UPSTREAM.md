# 上游与派生范围

## 上游（只读参考）

| | |
| --- | --- |
| 仓库 | https://github.com/Ebony-Vinyl/dsh-our-free-model （public） |
| 锁定 commit | `f29116baea55483ff067c1816966f1d08d8f0981`（`2026-11-24T10:50:32+08:00`，`Merge pull request #919 from Ebony-Vinyl/docs/eac-star-access`） |
| 许可证 | MIT，版权行 `Copyright (c) 2026 Ebony-Vinyl`；LICENSE 原文 14289 字节，另含 models.dev / opencode / RTK / 9router 的第三方声明与派生说明 |
| 用法 | 只读：任何测试/构建都从该 commit 取文件，本仓库不修改上游任何内容 |

本仓库（`menghuanshiguang/dsh-opencode-free`）是它的派生：MIT + 我们自己那行
`Copyright (c) 2026 menghuanshiguang (dsh-opencode-free modifications)`，见根目录 `LICENSE`。

## 派生范围

保留（产品唯一要的东西）：

- 免费车道本体：`src/o2a/`（官方 v2.2.3 请求体整形、会话铸造、资产）、`src/upstream.js`、
  `src/http.js`、`src/egress.js`、`src/bun-fetch.js`（生产传输是 Bun worker，node 传输只作诊断）。
- 免费模型清单：`src/catalog.js` 里上游标记的免费 id。
- 本地 OpenAI 兼容网关：`/v1/models`、`/v1/chat/completions`，出站只走免费车道的指纹。

删除（阶段 2 执行，不留开关、不留死代码分支）：

- 十账号渠道与其登录/额度管理（`src/accounts/`、`channel*`、`chan-relay`、`kilo`、`gemini` 等）。
- EAC：`src/eac.js`、`src/eac-login.js`、`src/eac-user.js`、`worker/auth-github.mjs`。
- 管理页与统计：`worker/dashboard.html`、`worker/gateway-node.mjs` 的 stats/admin 路由。

## 官方客户端资产（sst/opencode v2.2.3）

免费车道必须复刻官方客户端的请求体，资产锁在 `docs/opencode-assets.lock.json`：

- 23 个源文件，逐个记录 `blobSha`（git 对象 id：`sha1("blob <size>\0" + bytes)`）、`sha256`、字节数。
- 其中 14 个（`system.txt` + 13 个工具插件）的 blob sha 与上游
  `docs/opencode-assets.md` 的表逐条相等；本机复核 `documented=14 match=14 mismatch=0`。
- 取源走匿名 `raw.githubusercontent.com`，不带 token、不用 gh CLI。

重新生成/校验：

```bash
node gates/asset-lock-23.mjs           # 重算 23 个文件并写锁
node gates/asset-lock-23.mjs --check   # 只比对，锁与官方源不一致则 exit 1
```

`toolOrder` 的线上顺序是 `V2_OFFICIAL_TOOL_ORDER`（字母序：`edit glob grep patch question read
shell skill subagent todowrite webfetch websearch write`）；资产 JSON 的键序只作取源顺序，
不参与线上判定。

## 阶段 0 的线上证据

| | |
| --- | --- |
| run | https://github.com/menghuanshiguang/dsh-opencode-free/actions/runs/45333286803 （`workflow_dispatch`，attempt 1，head `57fbc0c`） |
| 结果 | `ok:true / status:200 / reply:PONG / billingSource:free / postCount:1`，`transport=bun`（bun 1.4.5） |
| 指纹 | `toolsSha256=6fb3aed805228cc69ca5e838b7af2fffa9bf57b8c27ebd7606fd94e41c05b77f`，与 `docs/fingerprint-baseline.json` 锁值相等 |
| 档案 | `gates/stage0/45333286803-1.json`（sha256 见 `gates/stage0/index.json`）；`run.conclusion=failure` 原样记录，红在报告步骤 `report the wire capture`，由 督查 一次性豁免（阶段 4 不再豁免） |

复核：

```bash
node gates/validate.mjs gates/stage0/45333286803-1.json --stage 0 --lock docs/fingerprint-baseline.json
```
