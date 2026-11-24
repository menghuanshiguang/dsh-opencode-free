#!/usr/bin/env bash
# 封存档案：run 结束之后，用**同一份** scripts/archive-live-run.sh 再产一份档案。
#
# 为什么要两份：run 内的那份归档跑在它自己这条 run 里，那一刻 run 还没结束，
# `run.conclusion` 只能是 null（观测值，不编）。那份只证明「请求层与门全过」。
# 这一份在 run 结束后跑，结论是真的，才声称结论。
#
#   scripts/seal-live-run.sh <run-id> --out <dir>
#   scripts/seal-live-run.sh <run-id> --out <dir> --inputs <已下好的目录>   # 离线（测试或人工复盘）
#
# --inputs 目录里要有 run.json / jobs.json / artifacts.json 和解开的 artifact/。
# 不给 --inputs 时自己从 API 取：需要 GITHUB_TOKEN（或 GH_TOKEN）+ GITHUB_REPOSITORY。
#
# 退出码：0 产出 <dir>/gates.json；2 缺参数/缺输入；1 取不到或归档被拒（沿用 archive-live-run.sh 的码）。
set -uo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")/.." && pwd) || exit 2
cd "$ROOT" || exit 2

die() { local code=$1; shift; printf 'SEAL REFUSED: %s\n' "$*" >&2; exit "$code"; }

runid= out= inputs=
while [ $# -gt 0 ]; do
  case "$1" in
    --out | --inputs)
      [ $# -ge 2 ] || die 2 "缺少 $1 的值"
      [ "${1#--}" = out ] && out=$2 || inputs=$2
      shift 2 ;;
    -*) die 2 "不认识的参数：$1" ;;
    *) [ -z "$runid" ] || die 2 "只接受一个 run id"; runid=$1; shift ;;
  esac
done
[ -n "$runid" ] || die 2 "用法：scripts/seal-live-run.sh <run-id> --out <dir> [--inputs <dir>]"
[ -n "$out" ] || die 2 "缺少 --out"
mkdir -p "$out" || die 2 "建不出 $out"

if [ -n "$inputs" ]; then
  for f in run.json jobs.json artifacts.json; do
    [ -f "$inputs/$f" ] || die 2 "离线输入缺 $inputs/$f"
  done
  [ -d "$inputs/artifact" ] || die 2 "离线输入缺 $inputs/artifact/"
  [ -f "$inputs/repo.json" ] || die 2 "离线输入缺 $inputs/repo.json"
  runjson=$inputs/run.json jobsjson=$inputs/jobs.json artifactsjson=$inputs/artifacts.json
  repojson=$inputs/repo.json dir=$inputs/artifact
else
  token=${GITHUB_TOKEN:-${GH_TOKEN:-}}
  [ -n "$token" ] || die 2 "没有 GITHUB_TOKEN / GH_TOKEN，取不到 run 与 artifact"
  [ -n "${GITHUB_REPOSITORY:-}" ] || die 2 "没有 GITHUB_REPOSITORY"
  api=${GITHUB_API_URL:-https://api.github.com}
  auth=(-H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json')
  runjson=$out/run.json jobsjson=$out/jobs.json artifactsjson=$out/artifacts.json repojson=$out/repo.json
  curl -sS "${auth[@]}" "$api/repos/$GITHUB_REPOSITORY/actions/runs/$runid" -o "$runjson" || die 1 "取不到 run $runid"
  curl -sS "${auth[@]}" "$api/repos/$GITHUB_REPOSITORY/actions/runs/$runid/jobs" -o "$jobsjson" || die 1 "取不到 run $runid 的 jobs"
  curl -sS "${auth[@]}" "$api/repos/$GITHUB_REPOSITORY/actions/runs/$runid/artifacts" -o "$artifactsjson" || die 1 "取不到 run $runid 的 artifacts"
  curl -sS "${auth[@]}" "$api/repos/$GITHUB_REPOSITORY" -o "$repojson" || die 1 "取不到仓库元数据"

  # 封存只在 run 结束之后做：这时结论必须是真的，不是 null。
  conclusion=$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv.at(-1),"utf8"));process.stdout.write(String(d.conclusion))' "$runjson")
  [ "$conclusion" = "success" ] || die 1 "run $runid 的 conclusion=$conclusion：封存档案只给已经成功的 run 出结论，先看 run 自己"
  node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv.at(-1),"utf8"));process.exit(d.status==="completed"?0:1)' "$runjson" ||
    die 1 "run $runid 的 status 不是 completed，仍然谈不上封存"

  # 取这一件的 id 与 digest，再按 id 下载 zip。
  #
  # 选件必须**精确命中唯一一件** `live-<run-id>`。同一个 run 名下还有一件
  # `archive-<run-id>`，两个名字都含 run id：按 `includes(runId)` 取第一件，
  # 取到的是列表里靠前的那一个，而真实的列表顺序是 archive- 在前、live- 在后，
  # 于是封存档案的 artifacts[0] 绑在 archive- 上，内容却取自 live-——绑定成了假话。
  # validate 只查字段齐备，不看绑的是谁，rc 依然 0。这就是按顺序选件的老病。
  #
  # 所以这里不出选项：名字必须等号相等，命中 0 件或 2 件都拒（不挑、不回落）。
  #
  # 参数用 .at(-2)/.at(-1) 取，不用 argv[1]/argv[2]：`node -e` 下 process.argv 是
  # ['/path/node', '[eval]', arg1, arg2]，[eval] 把下标整体推后一位，Linux 上同样如此。
  pick=$out/artifact.pick
  node -e '
const fs = require("node:fs")
const d = JSON.parse(fs.readFileSync(process.argv.at(-1), "utf8"))
const want = `live-${String(process.argv.at(-2))}`
const all = Array.isArray(d.artifacts) ? d.artifacts : []
const hits = all.filter(a => String(a.name ?? "") === want)
if (hits.length !== 1) {
  const seen = all.map(a => String(a.name ?? "")).join(", ") || "(none)"
  process.stderr.write(`expected exactly one artifact named ${want}, found ${hits.length}; list = ${seen}\n`)
  process.exit(1)
}
const a = hits[0]
process.stdout.write(`${a.id}\n${String(a.digest ?? "").replace(/^sha256:/, "")}\n${a.name}\n`)
' "$runid" "$artifactsjson" > "$pick" || die 1 "run $runid 的 artifacts 里没有唯一的 live-$runid（多命中也不挑）"
  aid=$(sed -n '1p' "$pick"); adigest=$(sed -n '2p' "$pick"); aname=$(sed -n '3p' "$pick")
  [ -n "$aid" ] || die 1 "artifact 没有 id，没法按 id 取件"
  zip=$out/artifact.zip
  curl -sSL "${auth[@]}" "$api/repos/$GITHUB_REPOSITORY/actions/artifacts/$aid/zip" -o "$zip" || die 1 "取不到 artifact $aid 的 zip"
  mkdir -p "$out/artifact" && (cd "$out/artifact" && unzip -q "$zip") || die 1 "解不开 artifact $aid 的 zip"
  dir=$out/artifact
  echo "sealed inputs: run=$runid conclusion=$conclusion artifact id=$aid digest=$adigest name=$aname"
fi

bash scripts/archive-live-run.sh \
  --dir "$dir" \
  --out "$out/gates.json" \
  --run-json "$runjson" \
  --jobs-json "$jobsjson" \
  --repo-json "$repojson" \
  ${artifactsjson:+--artifacts-json "$artifactsjson"} \
  ${aid:+--artifact-id "$aid"} ${adigest:+--artifact-digest "$adigest"} || exit $?

echo "SEAL-OK $out/gates.json"
