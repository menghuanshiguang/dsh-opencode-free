# acceptance/ — 验收员的独立判定器

规矩（督查 2026-11-24 裁定）：**任何「我跑过了」的结论，产出它的脚本必须在 HEAD 里。**
不在仓库里的脚本产出的东西只算声明，不算证据。所以这里每个脚本都自带取源、不依赖任何人的本机路径。

全部只用 node 内置模块（`verify-trigger-surface.py` 除外，需 python3 + PyYAML）。

| 脚本 | 判什么 | 退出码 |
| --- | --- | --- |
| `year-clock-test.mjs` | websearch 描述里的年份是否按「请求那一刻」渲染（判产品渲染，不判资产） | 0 = 四条判据全成立；1 = 产品停在资产那一年，或与官方模板不是同一串字节 |
| `verify-rendered.mjs` | 13 个工具描述：官方 v2.2.3 源 → 渲染串 → 与资产逐字节比 | 0 = 13/13 一致；1 = 有不一致或取源失败 |
| `verify-trigger-surface.py` | workflow 的 `on:` 触发面（真 YAML 解析） | 0 = 全合格；1 = 有禁止触发面/无法解析 |
| `baseline.mjs` | 从赛道代码重建 linux 指纹基线（解释 0.8 用） | 0 = 产出；2 = 缺 `--upstream` |
| `fixtures/run-fixtures.sh` | 用合成输入验 `tools/gates.mjs` 会不会拦坏数据 | 0 = 三档都符合预期；1 = 有一档不符 |

## 用法

```bash
node acceptance/year-clock-test.mjs                    # 今天
node acceptance/year-clock-test.mjs --clock 2027-01-01 # 注入时钟：跨年同样 exit 0
node acceptance/verify-rendered.mjs                    # 匿名取源，13/13
node acceptance/verify-rendered.mjs --cache <dir>      # 用本地已下载的官方源
python3 acceptance/verify-trigger-surface.py .github/workflows
bash acceptance/fixtures/run-fixtures.sh
node acceptance/baseline.mjs --upstream ../upstream --out /tmp/baseline.json
```

## `year-clock-test` 的四条判据（任何时钟都必须成立）

判的是**产品自己**渲染出来的那份 description（`src/o2a.js` 的 `officialTool`，请求体走的就是它），
不是资产文件：资产是 v2.2.3 那个 tag 的取源，年份必然停在那一刻，拿它当期望值等于要求产品跟着停。

1. 官方模板里确实有 `${new Date().getFullYear()}` —— 恒久判据；
2. 产品在给定时钟下渲染出的是**那一年**；
3. 产品渲染 == 官方模板在同一年份的渲染（逐字节，等价于与真客户端同字节）；
4. 产品在资产那一年上逐字节复现资产（说明除年份外一个字也没动）。

期望值全部来自外部（官方模板 + 注入的时钟），没有一条拿产品自己的输出去当答案。
CI 里 2027 那一档是硬断言：`rc` 必须 0；`rc = 1` 是产品又冻结回资产那年，`rc > 1` 是脚本自己坏了，
两者都 FAIL。

时钟按**本地正午**构造：客户端用的是 `new Date().getFullYear()`（本地年），
用 UTC 零点在 UTC 以西的时区会退成前一年，那测的就不是跨年而是时区。

## 不在本目录的东西

`gates/` 是归档与闸门（总策划），`tools/` 是赛道运行时（高级程序员）。
本目录只放**独立复算**用的判定器：不 import 被测实现，避免自证。

唯一例外是 `year-clock-test.mjs`：要注入时钟，只能直接调渲染函数。它不自证——比对的期望
来自官方 v2.2.3 模板与注入的年份，产品的输出只是被比对的一方；「线上的字节等于锁值」这条
仍由 live 的闸门判，不由这里判。
