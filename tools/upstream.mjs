// Where the pinned upstream checkout lives.
//
// On a runner it is `<repo>/upstream` (the workflow checks f29116ba out there).
// Locally, OFM_UPSTREAM_DIR points at the read-only reference clone, so the same
// tools run without a second copy of the tree.
import { pathToFileURL } from 'node:url'

const local = new URL('../upstream/', import.meta.url)
export const upstreamBase = process.env.OFM_UPSTREAM_DIR
  ? pathToFileURL(`${process.env.OFM_UPSTREAM_DIR.replace(/[\\/]+$/, '')}/`)
  : local

export const assetDir = new URL('src/o2a/assets/', upstreamBase)

/** Import a module from the pinned upstream tree. */
export const load = specifier => import(new URL(specifier, upstreamBase).href)
