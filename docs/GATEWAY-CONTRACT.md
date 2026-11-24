# 本地 OpenAI 兼容网关 · 对外合约

阶段 3 冻结（2026-11-24，总策划）。实现是 `src/gateway.js` 的 `createGateway` / `startGateway`，
上游是唯一一条免费车道（`f29116ba` 的 OpenCode v2.2.3 指纹）。本文是**对调用方的承诺**，
也是合约测试与闸门的判据来源：每个条款有编号（C1…），测试名里引用编号，闸门按编号点。

状态：C1–C20 全部为**要求**。与当前实现不一致的地方在条款里标「变更」——那是待改的，不是待商量的。

## 0. 不变量

- **I1 出站体逐字节**：网关发往上游的请求体字节，必须等于对同一 payload 单独调用
  `JSON.stringify(applyFingerprint(payload))` 的字节；同一 sha256。网关不得在指纹之后再加、再删、
  再改任何字段。唯一被允许的差别是 `payload` 自身的构造（§3.2 列出的携带字段 + 强制 `stream:true`）。
- **I2 一次一封**：一个入站请求最多产生一个上游请求，**不重试**、不换模型、不降级。
- **I3 会话**：`x-free-lane-conversation` 头（缺省取 `options.conversation`，再缺省 `'gateway'`）
  经 `sessionForConversation` + `truncateSession` 得到会话 id；同一会话内稳定，跨会话不同。
  两个并发请求不得共用会话。
- **I4 响应侧改写白名单**：允许改写 `id`、`model`、工具名（§5）、SSE 分帧与 `[DONE]` 标记。
  **正文 token、finish_reason、usage 数值不得改写**。
- **I5 无鉴权**：`Authorization` 收到即忽略，本地永不因鉴权返回 401；免费车道本身不带凭据。
- **I6 离线**：合约测试只打 loopback stand-in；CI 期间对 `opencode.ai` 的请求计数必须为 0，
  且该计数要落 artifact（见 §6）。

## 1. 路由表

| 方法 | 路径 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET` | `/v1/models` | 200 JSON | §4 |
| `POST` | `/v1/chat/completions` | 200 JSON 或 `text/event-stream` | §4 |
| 其他方法 | 上述两条路径 | — | **405** + `allow` 头（C1，变更：当前缺 `allow`） |
| 任意 | 其他路径（含 `/v1/models/{id}`、`/v1/embeddings`、`/v1/completions`、`/stats`、`/admin`、`/`） | — | **404** |

路径尾斜杠归一：`/v1/models/` 与 `/v1/models` 同一条路由。
404/405 的响应体同 §4 的本地错误形状，`type`/`code` 分别 `invalid_request_error` 与
`method_not_allowed`（405）。

## 2. `GET /v1/models`

- **C2** 响应 200，`{ "object": "list", "data": [ … ] }`；`data` 只含免费车道 id
  （`^[a-z0-9][a-z0-9._-]*-free$`，大小写不敏感），上架的非免费 id 不得出现。
- **C3** 每条至少含 `id`（string）、`object`（`"model"`）、`created`（int）、`owned_by`（string）；
  上游多给的字段原样保留。上游缺 `created` 取 0、缺 `owned_by` 取 `"opencode"`。
- **C4** 响应头 `x-free-lane-models: <n>`，`n === data.length === modelsFreeCount`，
  而 `modelsFreeCount` 必须是**本次请求从上游列表里数出来的**。任何环节不得硬编码条数
  （阶段 3 判据：日志里的 `modelsFreeCount` 与响应条数相等）。
- 上游失败按 §4。`/v1/models` 不接受 `POST`（405）。

## 3. `POST /v1/chat/completions`

### 3.1 请求体

只认下列字段，其余一律本地丢弃、不进上游：

`messages` `tools` `tool_choice` `temperature` `top_p` `max_tokens` `max_completion_tokens` `stop`
`response_format` `seed` `presence_penalty` `frequency_penalty` `logit_bias` `parallel_tool_calls`
（与 `src/gateway.js` 的 `CARRIED` 常量一致，改它要单独 commit）。`stream`、`stream_options`
是本地语义，不随体上行。

### 3.2 校验与顺序（错误码固定）

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 体 > 8 MiB | **413**（C5，变更：当前落 400） |
| 2 | 体为空或 JSON 解析失败 | 400 |
| 3 | `model` 不以 `-free` 结尾、或含空白/逗号 | 400，**且不发任何上游请求**（C6） |
| 4 | `messages` 不是非空数组 | 400 |

通过后：`payload = { model, …CARRIED, stream: true }`，`applyFingerprint(payload)` 得 rename 映射，
再一次性发上游。

### 3.3 非流式响应（`stream` 不为 `true`）

```json
{
  "id": "chatcmpl-<created>-<会话尾8位>",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "<调用方给的 model，原样>",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

- **C7** `choices[0].message.content` 必须是 string（可为 `""`），由上游 `delta.content` 按序拼接。
- **C8** 有工具调用时，`message.tool_calls` 为数组，元素按上游 `delta.tool_calls[].index` 聚合：
  `{ id, type:"function", function: { name, arguments } }`，`arguments` 是各分片的**字符串拼接**，
  不是二次序列化；`finish_reason` 取上游最后一个非 null 值（通常 `"tool_calls"`）。
  **没有工具调用时该字段不出现**（不是空数组）。
- **C9** `model` 恒为调用方给的值；上游的 id/model 不得泄漏到响应里。
- **C10** `usage` 取上游最后一个 `usage`；上游没给时是全 0 三件套（不省略）。

### 3.4 流式响应（`stream: true`）

- **C11** 200 + `content-type: text/event-stream; charset=utf-8`，`cache-control: no-store`；
  每帧 `data: <json>\n\n`，末帧 `data: [DONE]\n\n`，其后不得再有数据。
- **C12** 帧形状为 OpenAI chunk：`{ id, object:"chat.completion.chunk", created, model, choices:[{ index, delta, finish_reason }] }`；
  `id` 全流一致，`model` 每帧等于调用方 model（C9 同样适用于流式）。
- **C13** 首帧 `delta.role === "assistant"`；有工具调用时，`delta.tool_calls[]` 带 `index` 与
  `function.name`/`function.arguments` 分片，工具名必须已还原（§5）。
- **C14** `stream_options.include_usage === true` 时，在 `[DONE]` 之前多一帧 `choices: []` + `usage`；
  没请求时 usage 帧丢弃。
- **C15** 上游在已发头之后失败：写一帧 `data: {"error":{…}}`，随后 `data: [DONE]`，流结束；
  **不重试、不重开流、不改 HTTP 状态**。未发头时失败走 §4 的 HTTP 错误。

## 4. 错误映射

上游拒绝按 `src/http.js` 的 `CODE` 映射为 HTTP 状态，响应体
`{ "error": { "message": string, "type": "upstream_error", "code": string, "status"?: number } }`，
并带响应头 `x-free-lane-code: <code>`：

| CODE | HTTP |
| --- | --- |
| `quota`、`exhausted` | 429 |
| `laneLocked`、`permission` | 403 |
| `authorization` | 401 |
| `region` | 451 |
| `client` | 400 |
| `timeout` | 504 |
| `aborted` | 499 |
| 其他（含网络错误） | 502 |

- **C16** 本地错误（400/404/405/413）的 `type`/`code` 为 `invalid_request_error` / `method_not_allowed`，
  无 `x-free-lane-code`。
- **C17** 429 时若上游给了窗口信息（`windowEndsAt` 或 `retry-after`），转发为 `retry-after` 秒数。
  不给就不编。
- **C18** 入站请求不得因为上游错误收到 500；500 只留给网关自身编程错误，且仍返回 `{error}` 体。

## 5. 工具往返（阶段 3 的核心判据）

- **C19 出站**：调用方 `tools[]`（OpenAI 形状）经 `applyFingerprint` 改名后上行，
  线上 `tools[].function.name` 必须是 13 个官方契约名之一；参数 schema 逐字节取自契约
  （`docs/opencode-assets.lock.json` 那 13 份）。`applyFingerprint` 返回的 `ToolRenameMap` 是
  唯一合法的名字映射来源。
- **C20 入站还原**：上游返回的每个工具名——`delta.tool_calls[].function.name`、
  `message.tool_calls[].function.name`、以及 legacy `function_call.name`——都要经
  `restoreToolName(name, renames)` 还原成**调用方那一侧的名字**，逐字节相等；不在映射里的名字原样透传。
  非流式与流式两条路径各要一条测试：调用方声明 `my_read`（映射到线上 `read`），上游回 `read`，
  客户端必须看到 `my_read`。

## 6. 合约测试与离线纪律

- 测试文件：`scripts/tests/gateway.test.mjs`（单测，loopback stand-in 注入 `lane`），
  `scripts/tests/contract.test.mjs`（指纹/契约）。测试名里引用条款编号，例如
  `test('C8/C20 非流式 tool_calls 聚合且工具名还原')`。
- stand-in 必须是本地假上游：固定 SSE 剧本、**不发真实请求**。CI 用
  `tools/guard-offline.mjs` 预载，off-loopback 请求数落 artifact（`offline-requests.txt`，
  `OFFLINE REQUESTS: 0`），且要证明检测器在每个 suite 都活着（干净行数 = suite 数）。
- 指纹不变量的机器形式：stand-in 记录收到的**原始字节**，测试断言
  `sha256(raw) === sha256(JSON.stringify(applyFingerprint(同一 payload)))`（C/I1）。
- `node scripts/oc-free-live-test.mjs` 不带 `--live` 必须打印 `Skipped: pass --live …`
  并零请求；这是阶段 3 的负向证据。

## 7. 非目标（明确不做）

`/v1/embeddings`、`/v1/completions`、`/v1/responses`、`/v1/models/{id}`、管理页、统计路由、
鉴权、限流、计费、多账号、出口梯子、缓存、重试、模型路由、非 `-free` 模型转发。
出现任何一个即阶段 3 不过（并由 `scripts/check-extraction.mjs` 的残留族兜底）。

## 8. 条款清单（闸门按此点名）

C1 405 带 allow 头 · C2 models 只列免费 · C3 条目字段 · C4 `x-free-lane-models` = 运行时计数 ·
C5 413 · C6 非免费本地 400 零出站 · C7 content 拼接 · C8 tool_calls 聚合 · C9 model 原样 ·
C10 usage 兜底 · C11 SSE 分帧与 `[DONE]` · C12 chunk 形状与 model · C13 首帧 role 与工具分片 ·
C14 include_usage · C15 断流错误帧 · C16 本地错误形状 · C17 429 retry-after · C18 不出 500 ·
C19 出站改名 · C20 入站还原（流式+非流式各一条）。
