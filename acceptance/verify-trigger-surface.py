#!/usr/bin/env python3
"""触发面判定：真 YAML 解析，不看文本。用法: verify-trigger-surface.py <workflows目录>"""
import sys, pathlib, yaml

ALLOWED = {"workflow_dispatch"}
# GitHub 会触发的全部面；出现在 on: 里就是失败
FORBIDDEN = {
    "push", "pull_request", "pull_request_target", "schedule", "workflow_run",
    "repository_dispatch", "release", "issues", "issue_comment", "fork",
    "merge_group", "workflow_call", "discussion", "deployment", "page_build",
    "registry_package", "status", "watch", "create", "delete", "public",
}
def get_on(doc):
    # PyYAML 按 YAML 1.1 把裸 on: 解析成布尔键 True；不认它就会静默放行
    if not isinstance(doc, dict): return None
    if 'on' in doc: return doc['on']
    if True in doc: return doc[True]
    return None

def normalize(on):
    if isinstance(on, str): return {on: {}}
    if isinstance(on, list): return {k: {} for k in on}
    if isinstance(on, dict): return dict(on)
    return {}

d = pathlib.Path(sys.argv[1])
files = sorted(list(d.glob("*.yml")) + list(d.glob("*.yaml")))
if not files:
    print("FAIL no workflow files under", d); sys.exit(2)
rc = 0
for f in files:
    doc = yaml.safe_load(f.read_text())
    raw_on = get_on(doc)
    if raw_on is None:
        print(f"FAIL {f.name}  没有 on: 键（或无法解析），门失败即关闭"); rc = 1; continue
    keys = normalize(raw_on)
    surface = sorted(keys)
    unknown = sorted(set(surface) - ALLOWED - FORBIDDEN)
    # 规则按 workflow 类型分开：声明了 workflow_dispatch 的是 live，on 必须恰好只有它；
    # 其余 workflow 允许 push/pull_request，但 schedule/workflow_run 等仍一律禁止。
    dispatch_only = {"workflow_dispatch"} & set(surface)
    if dispatch_only:
        bad = sorted(set(surface) - {"workflow_dispatch"})
        kind = "live"
    else:
        bad = sorted(set(surface) & (FORBIDDEN - {"push", "pull_request"}))
        kind = "ci"
    verdict = "OK" if not bad and not unknown else "FAIL"
    if verdict == "FAIL": rc = 1
    print(f"{verdict} {f.name} [{kind}] on={surface}  unknown={unknown}  forbidden={bad}  "
          f"runs-on={ (doc.get('jobs') or {}).get('live',{}).get('runs-on', [j.get('runs-on') for j in (doc.get('jobs') or {}).values()]) }")
sys.exit(rc)
