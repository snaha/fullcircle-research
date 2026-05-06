// After `save()`, drop the loaded children of nodes below `depthLimit` so the
// resident set returns to ~O(top fan-out) regardless of how many inserts ran.
// Eviction keeps each node's `entry`, `type`, and `contentAddress` intact —
// only `forks` is cleared. The next `hydrateSpine` rebuilds the spine on
// demand by calling `loadAndStub`, which fetches the chunk at
// `node.getContentAddress` and re-populates forks.

import type { MantarayNodeInstance } from './spine.js'

// Walk the tree post-order, clearing `forks` on every node strictly below
// `depthLimit`. Default depth = 1 (keep root and its immediate children
// loaded; everything below is fetched lazily on the next mutation).
export function evictBelowDepth(node: MantarayNodeInstance, depthLimit = 1): void {
  evictWalk(node, 0, depthLimit)
}

function evictWalk(node: MantarayNodeInstance, depth: number, limit: number): void {
  if (!node.forks) return
  for (const fork of Object.values(node.forks)) {
    evictWalk(fork.node, depth + 1, limit)
    if (depth + 1 > limit) {
      // Nuke the child's loaded forks. `entry`, `type`, `contentAddress`
      // stay intact so the parent's next serialisation is still valid; the
      // child will be reloaded from `contentAddress` on the next descent.
      ;(fork.node as { forks?: unknown }).forks = undefined
    }
  }
}
