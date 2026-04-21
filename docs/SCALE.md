# Scale: From PoC to Mainnet

## Problem Statement

The current tooling in `packages/era/` builds a single in-memory Mantaray manifest covering every era it processes, with three top-level index prefixes (`number/`, `hash/`, `tx/`). This works well for the PoC — tens to hundreds of eras, a few million entries — because the whole manifest tree fits in JS memory and a single consolidated snapshot file on disk makes repeat loads near-instant.

Full mainnet is a different regime. This document records the scale ceiling of the current design and sketches the architecture we'd need to cross it, so the assumption stays explicit.

---

## Current Design

- **One unified Mantaray tree** per upload run, covering all eras being extended.
- **In-memory mutation:** `openManifest` calls `loadAllNodes` to force-hydrate the full tree before `addFork` mutations.
- **Content-addressed chunk cache** at `data/.manifest-cache/<ab>/<ref>.bin`, populated by both the loader and saver.
- **Consolidated snapshot** at `data/.manifest-cache/snapshot-<root>.bin` — a single binary file containing every manifest chunk for the latest root. Read once into a `Map<refHex, bytes>` and served to `loadAllNodes` from memory.
- **Incremental save:** Mantaray's internal dirty-node tracking means only changed chunks are re-uploaded to Bee.

This is appropriate for the current PoC workload and fits in ~40 lines of cache glue.

---

## Why It Breaks at Mainnet Scale

Back-of-envelope for the full archive:

| Quantity | Value |
|---|---|
| Blocks | ~25 million |
| Transactions | ~3.5 billion |
| Manifest entries (`number/` + `hash/` + `tx/`) | ~3.55 billion |

Consequences:

- **In-memory tree is infeasible.** At ~200 bytes of JS-object overhead per Mantaray node (conservative — V8 object headers, hidden classes, fork map, Uint8Array wrappers), a trie over 3.55B keys is easily hundreds of GB of RAM. No single machine in normal spec range.
- **Snapshot file is infeasible.** After BMT chunking of the trie, manifest chunk bytes alone are likely 300–500 GB. You cannot slurp that into a `Map`; you cannot meaningfully mutate it in one process.
- **Upload is weeks-to-months.** At a realistic Bee ingest rate of ~100–500 chunks/s per node, emitting the manifest chunks alone takes 80–400 days on a single node. Block bundle uploads are on top of that.
- **Incremental dirty-tracking stops helping.** For a tree that large, the working set of "dirty during one append run" is still a non-trivial fraction. Mantaray's save path assumes the full tree is in memory, so dirty tracking can't be the mechanism that saves us.

---

## What Mainnet-Scale Requires

A different architecture, not an incremental optimisation of the current one.

### 1. LSM-backed source of truth

Move the authoritative `path → entry-ref` mapping out of Mantaray and into an on-disk LSM store (LevelDB, RocksDB, or SQLite with WAL). Mantaray becomes purely a **Swarm serialisation format**, not the database.

- Appends: plain `db.put(path, ref)`. No tree traversal, no in-memory ceiling.
- Lookups: `db.get(path)` — answer "which block has tx 0xabc" without touching a manifest at all.
- Uploads: stream through the LSM in sorted key order and emit Mantaray chunks bottom-up, holding only one root-to-leaf path in RAM at any time.

### 2. Split the indexes

`number/`, `hash/`, and `tx/` should be **three independent top-level manifests**, not forks under one root.

- `tx/` is ~99 % of the entries and grows with every new block.
- `number/` and `hash/` are tiny by comparison and update at the same cadence.
- Decoupling lets you re-publish `number/` / `hash/` far more frequently than `tx/`, and upload the three in parallel.
- A small "index-of-indexes" manifest referencing the three roots can live at a stable feed.

### 3. Streaming Mantaray emission

Because the LSM yields keys in sorted order, you can build the Mantaray trie **bottom-up** as a streaming operation:

- Accumulate entries sharing a prefix.
- When the next key breaks the prefix, emit the completed subtree as a chunk, hash it, release the nodes.
- Carry only O(depth) state forward.

This is the standard LSM → sorted-merkle emission pattern used elsewhere (e.g. tries built from rocksdb compaction output).

### 4. Content-addressed chunk dedup

Streaming emission drops Mantaray's in-memory dirty-tracking. You recover it via the on-disk chunk cache: before uploading an emitted chunk, consult the cache by ref — if we've uploaded this exact chunk before, skip the Bee call.

Unchanged subtrees (very common when appending recent blocks) dedup naturally because their chunks hash identically to the previous run's.

### 5. Orchestration, not just code

At 3.5B chunks you also need operational machinery:

- **Crash-resume:** the LSM is durable; upload progress needs a separate checkpoint log so a killed process can pick up where it left off.
- **Per-chunk retry with backoff:** network errors are inevitable over 400-day runs.
- **Multiple Bee nodes behind a dispatcher** to parallelise upload across independent pipelines.
- **Monitoring:** chunk rate, per-node queue depth, postage stamp depletion, error taxonomy.

---

## Where The Current PoC Sits on This Road

- **Useful:** establishes the on-chain → Swarm data model, exercises real Bee APIs, produces real manifests for real ranges, gives us a format we can consumers point at (`/number/<n>`, `/hash/<h>`, `/tx/<h>` all resolve to an RLP-encoded block bundle).
- **Not useful at mainnet scale:** every in-memory data structure and every "walk the whole tree" primitive needs to go. The cache + snapshot design is a dead-end past ~10⁷ entries.

**Practical recommendation:**

1. Keep the current design for the PoC and for the first few hundred eras of real data — it's small, debuggable, and proves the end-to-end story.
2. When we plan the full-archive upload, treat it as a separate project with a fresh architecture built on the five points above. Don't try to evolve `packages/era/src/swarm.ts` into it — the abstractions are wrong.
3. If we need intermediate capacity (e.g. a sub-mainnet demo covering one era group or a specific client range), the first thing to add is "split the indexes into per-prefix manifests." That alone buys ~10–100× and requires no new storage technology.

---

## Decision Log

- **2026-04:** Chunk cache + consolidated snapshot added ([packages/era/src/swarm.ts](../packages/era/src/swarm.ts)). Sufficient for PoC. Scale ceiling documented here; revisit before any >10M-entry run.
