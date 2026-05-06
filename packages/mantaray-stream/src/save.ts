// Iterative dirty-walk save for a Mantaray tree. Replaces mantaray-js's
// built-in recursive `save()`, which spawns a Promise per fork of every dirty
// node — including clean forks that short-circuit. For a big tree that means
// millions of Promise allocations before the first chunk ever flows; this
// walker only allocates work for dirty nodes and enforces post-order via
// child-count decrements.
//
// Ported from packages/era/src/swarm.ts:saveMantarayTree. The streaming
// wrapper is the natural home — it pairs with hydrateSpine, both of which
// only need to know about dirty nodes.

import type { StorageSaver } from './bee.js'
import type { MantarayNodeInstance } from './spine.js'

type Reference = Uint8Array & { length: 32 | 64 }

export interface SaveOptions {
  saver: StorageSaver
  concurrency?: number
  onProgress?: (uploaded: number, dirty: number) => void
}

export async function saveTree(
  root: MantarayNodeInstance,
  options: SaveOptions,
): Promise<Reference> {
  const concurrency = options.concurrency ?? 32
  const onProgress = options.onProgress

  const remaining = new Map<MantarayNodeInstance, number>()
  const parents = new Map<MantarayNodeInstance, MantarayNodeInstance>()
  const ready: MantarayNodeInstance[] = []
  let readyHead = 0
  let dirtyCount = 0

  ;(function walk(node: MantarayNodeInstance): void {
    if (node.getContentAddress) return
    let dirtyChildren = 0
    if (node.forks) {
      for (const fork of Object.values(node.forks)) {
        const child = fork.node
        if (child.getContentAddress) continue
        dirtyChildren++
        parents.set(child, node)
        walk(child)
      }
    }
    remaining.set(node, dirtyChildren)
    dirtyCount++
    if (dirtyChildren === 0) ready.push(node)
  })(root)

  if (dirtyCount === 0) {
    const existing = root.getContentAddress
    if (!existing) {
      throw new Error('saveTree: root is clean but has no contentAddress')
    }
    return existing as Reference
  }

  let inFlight = 0
  let uploaded = 0
  let rootRef: Reference | null = null

  await new Promise<void>((resolveAll, rejectAll) => {
    let failed = false

    const startNext = (): void => {
      while (!failed && inFlight < concurrency && readyHead < ready.length) {
        const node = ready[readyHead++]
        inFlight++
        processNode(node).catch((err: unknown) => {
          inFlight--
          if (failed) return
          failed = true
          rejectAll(err instanceof Error ? err : new Error(String(err)))
        })
      }
      if (!failed && inFlight === 0 && readyHead >= ready.length) {
        resolveAll()
      }
    }

    const processNode = async (node: MantarayNodeInstance): Promise<void> => {
      const data = node.serialize()
      const ref = await options.saver(data)
      node.setContentAddress = ref
      if (node === root) rootRef = ref
      uploaded++
      onProgress?.(uploaded, dirtyCount)
      const parent = parents.get(node)
      if (parent) {
        const rem = (remaining.get(parent) ?? 0) - 1
        remaining.set(parent, rem)
        if (rem === 0) ready.push(parent)
      }
      inFlight--
      startNext()
    }

    startNext()
  })

  if (!rootRef) {
    const addr = root.getContentAddress
    if (!addr) throw new Error('saveTree: root was not uploaded')
    rootRef = addr as Reference
  }
  return rootRef
}
