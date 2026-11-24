// @ts-check
/**
 * Transport for the free lane, and the record of which transport actually ran.
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
 * `transportRecord()` is the observation line 督查 asked for: the branch that
 * issued the request writes down which implementation it used, how many lane
 * requests it issued and how they ended. It is recorded here, at the call, and
 * never inferred from the environment.
 *
 * @module src/egress.js
 */

import { bunFetch } from './bun-fetch.js'

const LANE_HOST = 'opencode.ai'

/** @typedef {{ observed: 'bun' | 'node' | null, basis: 'observed' | null, requests: number, last: null | { method: string, at: string, status?: number, elapsedMs: number, failed?: string } }} TransportRecord */

/** @type {TransportRecord} */
const record = { observed: null, basis: null, requests: 0, last: null }

/**
 * What this process actually did with the lane. `basis` is `observed` only
 * because the branch below wrote it while sending; nothing here reads the
 * environment or guesses from an installed binary.
 */
export function transportRecord() {
  return { ...record, last: record.last === null ? null : { ...record.last } }
}

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
  const method = String(init.method ?? 'GET').toUpperCase()
  const isPost = method !== 'GET'
  const started = Date.now()
  if (isLaneUrl(url)) {
    // The lane branch: record before sending, so a refusal is still an
    // observation of *which* transport refused.
    record.observed = 'bun'
    record.basis = 'observed'
    if (isPost) record.requests += 1
    try {
      const response = await bunFetch(url, init)
      record.last = { method, at: new Date().toISOString(), status: response.status, elapsedMs: Date.now() - started }
      return response
    } catch (error) {
      record.last = { method, at: new Date().toISOString(), elapsedMs: Date.now() - started, failed: String(error?.message ?? error) }
      throw error
    }
  }
  // Everything off the lane goes through the runtime's fetch, and says so: the
  // record names the transport of the request just made, not of an earlier one.
  record.observed = 'node'
  record.basis = 'observed'
  if (isPost) record.requests += 1
  try {
    const response = await fetch(url, init)
    record.last = { method, at: new Date().toISOString(), status: response.status, elapsedMs: Date.now() - started }
    return response
  } catch (error) {
    record.last = { method, at: new Date().toISOString(), elapsedMs: Date.now() - started, failed: String(error?.message ?? error) }
    throw error
  }
}
