#!/bin/bash
# 闸门 fixture 正反档：喂 tools/gates.mjs 合成输入，判它是否按预期放行/拦截。
#   bash acceptance/fixtures/run-fixtures.sh
# pos   = 完美 200（postCount=1）→ 必须 13/13 全 pass、exit 0
# neg   = 零请求且没有 live.json → 0.3/0.5/0.6/0.7/0.9 必须 FAIL、exit 1
# negb  = OUR_FREE_MODEL_FREE_TRANSPORT=node + 零请求 → 0.3-no-node 必须 FAIL、exit 1
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -r "$root/acceptance/fixtures/pos" "$root/acceptance/fixtures/neg" "$root/acceptance/fixtures/negb" "$tmp/"
export GITHUB_EVENT_NAME=workflow_dispatch GATES_CONFIRM=true RUNNER_OS=Linux RUNNER_NAME="GitHub Actions 2" GATES_BUN_VERSION=1.4.5
run() { node "$root/tools/gates.mjs" --fields "$tmp/$1/fields.json" --live "$tmp/$1/live.json" \
  --egress "$tmp/$1/egress.env" --wire "$tmp/$1/wire" --out "$tmp/$1/gates.json" >/dev/null 2>&1; echo $?; }
rc=0
unset OUR_FREE_MODEL_FREE_TRANSPORT
p=$(run pos); echo "pos  exit=$p"
[ "$p" = "0" ] || { echo "FAIL pos 必须 exit 0"; rc=1; }
n=$(run neg); echo "neg  exit=$n"
[ "$n" = "1" ] || { echo "FAIL neg 必须 exit 1"; rc=1; }
export OUR_FREE_MODEL_FREE_TRANSPORT=node
b=$(run negb); echo "negb exit=$b"
[ "$b" = "1" ] || { echo "FAIL negb 必须 exit 1"; rc=1; }
POS="$tmp/pos/gates.json" NEG="$tmp/neg/gates.json" NEGB="$tmp/negb/gates.json" node "$root/acceptance/fixtures/check.mjs" || rc=1
exit $rc
