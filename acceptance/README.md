# acceptance/ — 验收员的独立判定器

规矩（督查 2026-11-24 裁定）：**任何「我跑过了」的结论，产出它的脚本必须在 HEAD 里。**
不在仓库里的脚本产出的东西只算声明，不算证据。所以这里每个脚本都自带取源、不依赖任何人的本机路径。

全部只用 node 内置模块（`verify-trigger-surface.py` 除外，需 python3 + PyYAML）。

| 脚本 | 判什么 | 退出码 |
| --- | --- | --- |
| `year-clock-test.mjs` | websearch 描述里的 `${new Date().getFullYear()}` 是否按求值时刻渲染 | 0 = 全部成立；1 = 资产冻结年与注入年不一致（已知状态） |
| `verify-rendered.mjs` | 13 个工具描述：官方 v2.2.3 源 → 渲染串 → 与资产逐字节比 | 0 = 13/13 一致；1 = 有不一致或取源失败 |
| `verify-trigger-surface.py` | workflow 的 `on:` 触发面（真 YAML 解析） | 0 = 全合格；1 = 有禁止触发面/无法解析 |
| `baseline.mjs` | 从赛道代码重建 linux 指纹基线（解释 0.8 用） | 0 = 产出；2 = 缺 `--upstream` |
| `fixtures/run-fixtures.sh` | 用合成输入验 `tools/gates.mjs` 会不会拦坏数据 | 0 = 三档都符合预期；1 = 有一档不符 |

## 用法

```bash
node acceptance/year-clock-test.mjs                    # 今天
node acceptance/year-clock-test.mjs --clock 2027-01-01 # 注入时钟：资产仍冻结则 exit 1
node acceptance/verify-rendered.mjs                    # 匿名取源，13/13
node acceptance/verify-rendered.mjs --cache <dir>      # 用本地已下载的官方源
python3 acceptance/verify-trigger-surface.py .github/workflows
bash acceptance/fixtures/run-fixtures.sh
node acceptance/baseline.mjs --upstream ../upstream --out /tmp/baseline.json
```

## 两条判据的分层（别混）

`year-clock-test` 里分两层，接 CI 时不要一律写成硬断言：

1. **模板存在运行时插值** —— 恒久判据，任何时候都必须 PASS。修不修年份它都成立。
2. **渲染(year) 与资产逐字节一致** —— 状态判据。资产冻结在 `SOURCE_YEAR` 时，跨年后必然 FAIL。
   现阶段这是**已知状态**（`exit 1` 是预期的），产品抽出后改成运行时渲染，这一档自然转绿，CI 不用改。

CI 接法要求：`rc` 只许 0 或 1；`rc > 1`（脚本崩溃、路径错、语法错）必须判 FAIL，
否则脚本坏了 CI 照样绿。

## 不在本目录的东西

`gates/` 是归档与闸门（总策划），`tools/` 是赛道运行时（高级程序员）。
本目录只放**独立复算**用的判定器：不 import 被测实现，避免自证。
