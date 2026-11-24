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
# 一条贯穿这份脚本的规矩（四次额度买来的）：**每条写进档案的断言，问一句「这个值在写它
# 的那一刻能不能被观测到」**。答不上来的，改判据、不许改数据。已经踩过的三次：
#   transport 只有 derived 却被要求 observed；归档查 artifacts 列表，+15 毫秒还没索引到；
#   自归档问 run 自己的 conclusion，那一刻它必然还是 null。
# 因此 run 内这份档案照实写 conclusion=null + status=in_progress，只声称「请求层与门全过」；
# 结论由 scripts/seal-live-run.sh 在 run 结束后用同一份脚本另出一份封存档案。
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
dir= out= runjson= jobsjson= artifactsjson= repojson= artifactid= artifactdigest= artifactjson=
artifactid_seen=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir | --out | --run-json | --jobs-json | --artifacts-json | --repo-json | --product | --artifact-id | --artifact-digest | --artifact-json)
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
        artifact-id) artifactid=$value; artifactid_seen=1 ;;
        artifact-digest) artifactdigest=$value ;;
        artifact-json) artifactjson=$value ;;
      esac
      ;;
    *)
      die 2 "不认识的参数：$1"
      ;;
  esac
done

for pair in "--dir:$dir" "--out:$out" "--run-json:$runjson" "--jobs-json:$jobsjson" \
  "--repo-json:$repojson"; do
  [ -n "${pair#*:}" ] || die 2 "缺少 ${pair%%:*}"
done

# 归档哪一个 artifact：三种给法，互不兜底。
#   --artifact-json   直接给单件响应（夹具、人工复盘）
#   --artifact-id     按 id 取单件响应（live 走这条；id 与 digest 来自 upload-artifact 的 outputs）
#   --artifacts-json  列表（旧路径；给了 id 时一个字都不看）
if [ "$artifactid_seen" -eq 1 ] && [ -z "$artifactid" ]; then
  # 上传失败时 upload-artifact 的 artifact-id 是空串。那是「没给 id」，不是「id 查不到」。
  die 2 "upload-artifact 没给 artifact-id（空值，上传失败？）：这是「没给 id」，不是「id 查不到」"
fi
if [ -z "$artifactid" ] && [ -z "$artifactjson" ] && [ -z "$artifactsjson" ]; then
  die 2 "缺少 --artifact-id（live）或 --artifact-json / --artifacts-json（夹具）"
fi

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

for sidecar in "$runjson" "$jobsjson" "$repojson"; do
  [ -f "$sidecar" ] || die 2 "找不到 $sidecar"
done
# artifacts 列表只在没有 id 时才用；给了 id 时它可以是空的，那不是缺输入。
if [ -z "$artifactid" ] && [ -z "$artifactjson" ] && [ ! -f "$artifactsjson" ]; then
  die 2 "找不到 $artifactsjson"
fi
[ -f docs/fingerprint-baseline.json ] || die 2 "docs/fingerprint-baseline.json 不存在，锁比对无从做"

outdir=$(dirname -- "$out")
mkdir -p "$outdir" || die 2 "建不出 $outdir"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/archive-live.XXXXXX") || die 2 "mktemp 失败"
trap 'rm -rf "$tmp"' EXIT

# ---- 按 id 取单件响应：不读列表，就没有「列表还没索引到」这回事 ----
# 一次有界重试（两次尝试），失败时把 id 与 HTTP 状态码原样打出来；绝不退化成一句「没有 artifact」。
if [ -n "$artifactid" ] && [ -z "$artifactjson" ]; then
  if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_API_URL:-}" ]; then
    die 2 "给了 --artifact-id $artifactid，但缺 GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_API_URL，取不到这一件的响应"
  fi
  artifactjson=$tmp/artifact.json
  status=000
  for attempt in 1 2; do
    status=$(curl -sS -m 20 -o "$artifactjson" -w '%{http_code}' \
      -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' \
      "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$artifactid") || status=000
    [ "$status" = "200" ] && break
    # 最后一次之后没有第三次：骗人的「重试」比不说更坏（验收员 在失败路径上读到过它）。
    if [ "$attempt" -lt 2 ]; then
      echo "artifact id=$artifactid: 第 $attempt 次取件返回 HTTP $status，2 秒后重试" >&2
      sleep 2
    else
      echo "artifact id=$artifactid: 第 $attempt 次取件返回 HTTP $status，没有下一次" >&2
    fi
  done
  if [ "$status" != "200" ]; then
    die 1 "取不到 artifact id=$artifactid：HTTP $status（GET $GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/artifacts/$artifactid）$(head -c 300 "$artifactjson" 2>/dev/null | tr '\n' ' ')"
  fi
  echo "artifact: id=$artifactid 取件 HTTP 200（按 id 取，未读列表）"
fi

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

artifactargs=()
if [ -n "$artifactid" ]; then
  artifactargs+=(--artifact-id "$artifactid" --artifact-json "$artifactjson")
  [ -n "$artifactdigest" ] && artifactargs+=(--artifact-digest "$artifactdigest")
elif [ -n "$artifactjson" ]; then
  artifactargs+=(--artifact-json "$artifactjson")
else
  artifactargs+=(--artifacts-json "$artifactsjson")
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
  --out "$out" "${artifactargs[@]}" "${extra[@]}" || die 1 "from-artifact 拒绝产出档案（上面是它给的原因）"

# --lock 不是可选项：不带它时锁比对那一段整段不跑，指纹闭环等于没判（督查 条件七）。
node gates/validate.mjs "$out" --stage 4 --lock docs/fingerprint-baseline.json ||
  die 1 "产出的档案过不了 validate --stage 4 --lock"

[ -s "$out" ] || die 1 "产物 $out 是空的"
echo "ARCHIVE-OK $out"
