# dsh-opencode-free

OpenCode 免费车道独立版：逐字节复刻官方 v2.2.3 客户端请求体，直连 opencode.ai 免费车道，对外只暴露一个本地 OpenAI 兼容网关。独立包，不是 DSH 插件：插件外壳（`index.js`、`client.js`、`adapters`）按阶段 2 的剥离判据不保留。

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

## Use

```bash
npm install                       # only for the typecheck; the runtime has no dependencies
node -e "import('./src/gateway.js').then(async m => {
  const g = await m.startGateway({ port: 18787 })
  console.log(g.url)
})"
```

Two routes, and nothing else:

| Route | What it does |
| --- | --- |
| `GET /v1/models` | the free-lane ids, read from the live listing at request time (never typed in here) |
| `POST /v1/chat/completions` | one free-lane turn; `stream: true` relays the upstream SSE frames |

Any other path answers 404 and any other method 405 — there is no admin page,
no statistics route, no authentication, no billing and no rate limiter, because
there is nothing here to administer. A model id that is not a free-lane id (it
does not end in `-free`) is refused locally with 400, so a paid request can
never be sent by mistake.

The request body that leaves is the one `src/upstream.js` shapes: the official
v2.2.3 system prompt, the 13 tool contracts in the lane's wire order, the
`x-opencode-*` identity and a real-timestamp session id. Forwarding the
caller's JSON unchanged would be refused by the free tier (403 FreeTierError /
429), which is why shaping is not optional.

## Evidence has to be able to go red

Every assertion this repository makes about a zero, an equality or a single
request ships with a negative case that turns it red. Without one, a check that
cannot fail is decoration, and the decoy looks exactly like the pass.

The rule was written after three real ones were caught in this repository:

| What it claimed | Why it could never fail | What makes it fail now |
| --- | --- | --- |
| "no off-loopback request was attempted" | the guard writes to **stderr**, the step teed only stdout, so the `grep` never saw the line | `2>&1` on the tee, plus a suite count that only counts the guard marker, and a deliberate outbound attempt in the fixtures |
| "5 suites ran" | the counter matched `^=== `, which the suites print themselves as titles | the runner prints `### suite: <name>` and the counter matches only that |
| "transport is the production Bun worker" | `transport=bun` was an inference from configuration, true with zero requests sent | gate 0.3 also requires `postCount>=1`, so a zero-request run fails it — the dry-run rehearsal (`45335463823`) exists to prove that |

The same rule applies to the contract gate: `scripts/tests/gateway.test.mjs`
asserts the routes that must not exist, `scripts/check-extraction.mjs` is proven
against six bad inputs (an extra export, a `/stats` route, one changed byte in a
verbatim file, an excluded path imported back, a commented-out route, an
`if (false)` branch), and the offline count is demonstrated with a request that
must be blocked.

## The extraction gate

`node scripts/check-extraction.mjs` is the stage-2 gate, and it exits 0 only
when all four families hold:

1. **import set** — every imported upstream file still hashes to the blob the
   pin names, or is declared adapted/removed in `docs/adaptations.json` with a
   reason (`899 = 7 imported + 892 excluded`, disjoint);
2. **excluded reach** — no shipped module imports an excluded path, which is
   the machine form of "no account channels were carried along";
3. **public surface** — the entry exports exactly `{createGateway,
   startGateway}` and `package.json` exports only `"."`;
4. **no leftovers** — no admin/statistics route, credential-shaped config name,
   channel provider or EAC identifier in the files this package authored; no
   dead file inside `src/`; no commented-out code and no `if (false)`.

Exit codes: `0` pass, `1` fail (each hit listed), `2` the checker itself could
not run. Treating only `1` as failure would let a broken run look green.

`npm test` runs the three offline suites: the contract hash, the route surface,
and the stand-in contract (a loopback server that records the outbound body, so
"the gateway adds nothing" is asserted as a sha256 equality rather than promised).

`node scripts/live-test.mjs` without `--live` prints
`Skipped: pass --live to send an actual request.` and sends nothing; CI runs it
exactly that way, under the network guard, and counts the off-loopback attempts
(it expects 0). `npm run typecheck` checks the files
this package authored (they carry `// @ts-check`); the four upstream files are
covered by their pinned blob shas instead of being re-typed, because editing
them to satisfy a checker would change the fingerprint this lane depends on.

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
