# dsh-opencode-free

OpenCode 免费车道独立版：逐字节复刻官方 v2.2.3 客户端请求体，直连 opencode.ai Zen 网关；可作 DSH 插件安装，也可独立起本地 OpenAI 兼容网关

## License

MIT. This repository is derived from
[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
(commit `f29116ba`, used as a read-only reference), which is itself MIT licensed.

- `LICENSE` carries the upstream text verbatim, including its third-party notices
  (models.dev, opencode, RTK, 9router) and the derivative note, plus one added
  line: `Copyright (c) 2026 menghuanshiguang (dsh-opencode-free modifications)`.
- GitHub reports `spdx_id: NOASSERTION` for this repository because that LICENSE
  is a composite text (MIT plus four third-party notices plus a derivative
  paragraph), which its detector does not classify as plain MIT. The grant is
  still MIT, as stated here and in `LICENSE`.

## What the lane is

Only the official-OC free lane and a local OpenAI-compatible gateway are kept.
The upstream's ten-channel routing, EAC, and admin pages are removed, with no
switch and no dead branch left behind.

Live requests leave from GitHub Actions (`ubuntu-latest`) through the production
Bun worker; the node transport is a diagnostic fallback only and is never
acceptance evidence.

## Verification

`free-lane-ci` runs on push and pull request and touches the inference host with
zero bytes: `tools/guard-offline.mjs` refuses every off-loopback request made by
a test process, and the run prints whether anything was attempted.

- `node tools/contract-check.mjs <model>` — the 13 tool contracts and the system
  prompt against the pinned assets, plus `toolsSha256`.
- `node tools/gates-selftest.mjs` — the gate validator against one perfect run and
  six broken ones.
- `node gates/selftest.mjs` and `node gates/validate.mjs` — the archive schema and
  its negative cases.
- `node tools/gh-anon-shim.mjs` installed as `gh` lets the pinned upstream asset
  fetcher read `raw.githubusercontent.com` without any credential; the blob SHAs
  are recomputed locally and checked against the provenance table.

`free-lane-live` is `workflow_dispatch` only, one model, one request, no retry.
It refuses a second run in flight, records the egress IP and country, requires
the production Bun transport, and asserts the fingerprint baseline before it
spends anything. Its artifacts carry `gates.json`, the wire capture, and the raw
upstream response.
