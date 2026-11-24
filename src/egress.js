/**
 * Transport for the free lane.
 *
 * The lane speaks to `https://opencode.ai/inference/*` through the Bun worker —
 * the released client's own fetch stack is what the free tier accepts, and the
 * worker source is inlined in src/bun-fetch.js. Every other URL (there is one:
 * the model listing lives on the same host) keeps the runtime's fetch.
 *
 * Deliberately absent, and not replaced by a flag: the upstream egress outlets,
 * the lane-exit pool, the loopback CONNECT relay and the proxy ladder. Those
 * route a paid, multi-account channel through customer proxies and retry across
 * exits. This package has one anonymous lane, so there is nothing to choose
 * between, and a refusal is reported instead of retried.
 *
 * @module src/egress.js
 */

import { bunFetch } from './bun-fetch.js'

const LANE_HOST = 'opencode.ai'

/** Whether `url` is the official inference lane this package is allowed to spend. */
export function isLaneUrl(url) {
  const target = new URL(url instanceof Request ? url.url : String(url))
  return target.protocol === 'https:' && target.hostname === LANE_HOST
    && (target.port === '' || target.port === '443') && target.pathname.startsWith('/inference/')
}

/**
 * Fetch `url`, through the Bun worker for the lane and plainly otherwise.
 * No retry, no fallback transport: one request in, one response out.
 */
export async function egressFetch(url, init = {}) {
  if (isLaneUrl(url)) return bunFetch(url, init)
  return fetch(url, init)
}
