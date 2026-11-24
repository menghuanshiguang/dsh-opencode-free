#!/usr/bin/env bash
# 归档序列的唯一一份定义。
#
# 为什么要有这个脚本：这套命令原先在 free-lane-live.yml 里手写一遍、在 gates/check-live-artifact.mjs
# 的夹具里另走一遍，两处序列不同——夹具从没见过 check-preconditions，于是那一处缺陷只会在真派发时红。
# 现在 workflow 只调这个脚本，CI 用合成输入调同一个脚本（gates/check-archive-script.mjs 证明它会红）。
#
#   scripts/archive-live-run.sh --dir <产物目录> --out <archive.json> \
#     --run-json <p> --jobs-json <p> --artifacts-json <p> --repo-json <p> [--product <name>]
#
# 输入：
#   <dir>/live.json  <dir>/<product>（默认 gates.flat.json）  <dir>/fields.json  <dir>/egress.env
#   --run-json / --jobs-json / --artifacts-json  本次 run 的 API JSON（artifacts 必须是上传之后拉的）
#   --repo-json                                  仓库 API JSON（P2 只认它的 private/visibility）
#
# 三个前置门的输入在这里现取，不让调用方各写一遍：LICENSE 来自 `git show HEAD:LICENSE`，
# 历史来自 `git log -p --all`，仓库事实来自 --repo-json。
#
# 退出码：
#   0  产出 <archive.json>，末行打印 `ARCHIVE-OK <path>`
#   2  缺参数，或产物目录里缺必需文件——缺参数不许降级成「跳过判定」
#   1  浅历史（P3 会拿一个提交充数）、P1–P3 没全过、from-artifact 拒绝、validate 不过
set -uo pipefail

# 仓库根 = 本脚本所在目录的上一级：浅历史判定要判「装着本脚本的那个检出」，
# 而不是调用方的 cwd。BASH_SOURCE 在个别 shell 里是空的，退回 $0。
self=${BASH_SOURCE[0]:-$0}
ROOT=$(cd -- "$(dirname -- "$self")/.." && pwd) || exit 2
cd "$ROOT" || exit 2

die() {
  local code=$1
  shift
  printf 'ARCHIVE-SCRIPT REFUSED: %s\n' "$*" >&2
  exit "$code"
}

product=gates.flat.json
dir= out= runjson= jobsjson= artifactsjson= repojson=

while [ $# -gt 0 ]; do
  case "$1" in
    --dir | --out | --run-json | --jobs-json | --artifacts-json | --repo-json | --product)
      [ $# -ge 2 ] || die 2 "缺少 $1 的值"
      key=${1#--}
      value=$2
      shift 2
      case "$key" in
        dir) dir=$value ;;
        out) out=$value ;;
        run-json) runjson=$value ;;
        jobs-json) jobsjson=$value ;;
        artifacts-json) artifactsjson=$value ;;
        repo-json) repojson=$value ;;
        product) product=$value ;;
      esac
      ;;
    *)
      die 2 "不认识的参数：$1"
      ;;
  esac
done

for pair in "--dir:$dir" "--out:$out" "--run-json:$runjson" "--jobs-json:$jobsjson" \
  "--artifacts-json:$artifactsjson" "--repo-json:$repojson"; do
  [ -n "${pair#*:}" ] || die 2 "缺少 ${pair%%:*}"
done

# 浅历史先判，先于任何一步：深度 1 的克隆里 `git log -p --all` 只看得见一个提交，
# P3 会在这种历史上报 PASS，那比跳过更坏（督查 2026-11-24）。
git rev-parse --git-dir >/dev/null 2>&1 || die 2 "$ROOT 不是 git 检出，P1/P3 无从判"
shallow=$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)
gitdir=$(git rev-parse --git-dir 2>/dev/null || echo .git)
if [ "$shallow" = true ] || [ -f "$gitdir/shallow" ]; then
  die 1 "浅历史（shallow=$shallow, gitdir=$gitdir）：--depth 1 的克隆里 P3 拿一个提交充数，本脚本拒绝归档。workflow 的 checkout 必须 fetch-depth: 0"
fi

missing=()
for required in live.json "$product" fields.json egress.env; do
  [ -f "$dir/$required" ] || missing+=("$required")
done
[ ${#missing[@]} -eq 0 ] || die 2 "产物目录 $dir 缺 ${missing[*]}——没有东西可归档"

for sidecar in "$runjson" "$jobsjson" "$artifactsjson" "$repojson"; do
  [ -f "$sidecar" ] || die 2 "找不到 $sidecar"
done
[ -f docs/fingerprint-baseline.json ] || die 2 "docs/fingerprint-baseline.json 不存在，锁比对无从做"

outdir=$(dirname -- "$out")
mkdir -p "$outdir" || die 2 "建不出 $outdir"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/archive-live.XXXXXX") || die 2 "mktemp 失败"
trap 'rm -rf "$tmp"' EXIT

# ---- P1–P3：三个输入都由脚本自己取，调用方只给 repo.json ----
git show HEAD:LICENSE > "$tmp/LICENSE" 2>"$tmp/license.err" ||
  die 2 "HEAD 里没有 LICENSE：$(tail -1 "$tmp/license.err")"
git log -p --all > "$tmp/gitlog.txt" 2>"$tmp/gitlog.err" ||
  die 2 "git log -p --all 失败：$(tail -1 "$tmp/gitlog.err")"

preconditions=$outdir/preconditions.json
node gates/check-preconditions.mjs --license "$tmp/LICENSE" --repo-json "$repojson" \
  --git-log "$tmp/gitlog.txt" --json > "$preconditions"
pre_rc=$?
cat "$preconditions"
[ "$pre_rc" -eq 0 ] || die 1 "P1–P3 没有全过（check-preconditions exit $pre_rc）"
node -e '
const d = JSON.parse(require("node:fs").readFileSync(process.argv.at(-1), "utf8"))
if (d.pass !== true || (d.skipped ?? []).length !== 0) {
  const bad = (d.results ?? []).filter(r => r.pass !== true).map(r => `${r.id} ${r.detail}`)
  console.error(`P1–P3 不是全过：${bad.join(" | ") || "(结果不完整)"} skipped=${(d.skipped ?? []).join(",")}`)
  process.exit(1)
}
console.log(`preconditions: ${d.results.map(r => r.id).join(" ")} PASS`)
' "$preconditions" || die 1 "P1–P3 结果不合格"

# ---- 反向测试的计数也从工具现取，不手打 ----
negative=$outdir/negative-tests.json
node gates/selftest.mjs --json > "$negative" || die 1 "gates/selftest.mjs 没有全过，归档里的 negativeTests 会是个没被验过的数"
node -e '
const d = JSON.parse(require("node:fs").readFileSync(process.argv.at(-1), "utf8"))
if (!Array.isArray(d.negativeTests) || d.negativeTests.length === 0) { console.error("selftest 没有给出 negativeTests"); process.exit(1) }
console.log(`negativeTests: ${d.negativeTests.length}`)
' "$negative" || die 1 "selftest 输出不合格"

# ---- 档案 ----
contracts=upstream/src/o2a/assets/ofm-tool-contracts.json
extra=()
if [ -f "$contracts" ]; then
  extra=(--contracts "$contracts")
  echo "contracts: $contracts"
else
  echo "contracts: 不在检出里（$contracts），档案的 contractsSha256 退回锁文件"
fi

node gates/from-artifact.mjs \
  --dir "$dir" \
  --run-json "$runjson" \
  --jobs-json "$jobsjson" \
  --artifacts-json "$artifactsjson" \
  --repo-json "$repojson" \
  --lock docs/fingerprint-baseline.json \
  --preconditions "$preconditions" \
  --negative-tests "$negative" \
  --stage 4 \
  --out "$out" "${extra[@]}" || die 1 "from-artifact 拒绝产出档案（上面是它给的原因）"

# --lock 不是可选项：不带它时锁比对那一段整段不跑，指纹闭环等于没判（督查 条件七）。
node gates/validate.mjs "$out" --stage 4 --lock docs/fingerprint-baseline.json ||
  die 1 "产出的档案过不了 validate --stage 4 --lock"

[ -s "$out" ] || die 1 "产物 $out 是空的"
echo "ARCHIVE-OK $out"
