// Lazy-load spine helpers for mantaray-js.
//
// mantaray-js's `node.load(loader, ref)` deserialises a single node, populating
// `forks` with stub child nodes. Each stub carries `entry` (= the child's
// 32-byte chunk ref read from the parent's serialised form) but NOT
// `contentAddress`, which is what `save()` checks to short-circuit clean
// subtrees. Without intervention, stubs appear dirty to `save()` and get
// re-serialised with `forks = {}`, orphaning everything underneath.
//
// We work around this by stamping `setContentAddress = entry` on every stub
// immediately after a load. From `save()`'s perspective the subtree is then
// indistinguishable from a freshly-saved one.
//
// `hydrateSpine(node, path)` walks the path the same way `addFork` would,
// loading each node it'd descend into. Because edge splits in `addFork`
// (`mantaray-js/src/node.ts:373`) construct a fresh local node and don't
// recurse into the existing fork's subtree, the spine ends at the split
// point — at most O(depth) loads, ~5 chunks at mainnet scale.

import MantarayJs from 'mantaray-js'

const { MantarayNode } = MantarayJs

type MantarayNodeInstance = InstanceType<typeof MantarayJs.MantarayNode>
type Reference = Uint8Array & { length: 32 | 64 }

export type StorageLoader = (reference: Reference) => Promise<Uint8Array>

// Load a node from storage and stamp `contentAddress` on every fork stub the
// load creates so `save()` short-circuits unmodified siblings. Idempotent —
// re-stamping a stub that was already stamped is a no-op (setContentAddress
// just reassigns the same value).
export async function loadAndStub(
  node: MantarayNodeInstance,
  ref: Reference,
  loader: StorageLoader,
): Promise<void> {
  await node.load(loader, ref)
  if (!node.forks) return
  for (const fork of Object.values(node.forks)) {
    const childRef = fork.node.getEntry
    if (childRef && !fork.node.getContentAddress) {
      fork.node.setContentAddress = childRef
    }
  }
}

// Walk `path` from `node`, loading every node `addFork` would descend into.
// Mirrors the descent decision in `addFork` exactly:
//   - load current node if its forks aren't materialised
//   - find the fork for the next path byte
//   - if the fork's prefix only partially matches the path, addFork will
//     split locally on the parent — no further descent, we stop
//   - otherwise descend into fork.node with the remaining path
export async function hydrateSpine(
  node: MantarayNodeInstance,
  path: Uint8Array,
  loader: StorageLoader,
): Promise<void> {
  // Always materialise the current node's forks. Even when path.length === 0
  // (we're setting an entry on this node), addFork will still serialise it on
  // the next save and would lose its existing children if forks is undefined.
  if (!node.forks) {
    const ref = node.getContentAddress
    if (ref) await loadAndStub(node, ref as Reference, loader)
    // No contentAddress and no forks: a freshly-created node with no children
    // yet. Nothing to load; addFork will populate forks itself.
  }

  if (path.length === 0) return
  if (!node.forks) return

  const fork = node.forks[path[0]]
  if (!fork) return // No existing fork; addFork will create one locally.

  const commonLen = commonPrefixLength(fork.prefix, path)
  if (commonLen < fork.prefix.length) {
    // Edge split: addFork creates a new intermediate node and doesn't recurse
    // into fork.node. fork.node's existing contentAddress stays valid.
    return
  }

  await hydrateSpine(fork.node, path.slice(commonLen), loader)
}

function commonPrefixLength(a: Uint8Array, b: Uint8Array): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

// Re-export the MantarayNode type for downstream use without forcing
// callers to repeat the InstanceType incantation.
export type { MantarayNodeInstance }
export { MantarayNode }
