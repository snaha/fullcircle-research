# FullCircle: Implementation Proposal

**Project:** [ethersphere/swarm-accelerator#5](https://github.com/ethersphere/swarm-accelerator/issues/5)
**Research:** See [RESEARCH.md](./RESEARCH.md) for technical background.

---

## Table of Contents

1. [TypeScript Ecosystem and Tooling](#1-typescript-ecosystem-and-tooling)
2. [Architecture Options](#2-architecture-options)
3. [Recommended Approach](#3-recommended-approach)

---

## 1. TypeScript Ecosystem and Tooling

### 1.1 bee-js (Already in Repo)

`@ethersphere/bee-js` v10.1.1 provides everything needed:

**Upload/Download:**
- `bee.uploadData(batchId, data)` -- raw bytes, returns reference
- `bee.downloadData(reference)` -- returns Bytes
- `bee.downloadReadableData(reference)` -- returns `ReadableStream<Uint8Array>` (streaming)
- `bee.uploadFile(batchId, file, name)` -- single file with manifest
- `bee.uploadCollection(batchId, collection)` -- multiple files with paths

**Feeds (for mutable pointers like "latest block" or "epoch index"):**
- `bee.makeFeedWriter(topic, signer)` -- returns writer with `.upload(batchId, reference)`
- `bee.makeFeedReader(topic, owner)` -- returns reader with `.download()`

**Manifests (for organizing era1 files by epoch):**
- `MantarayNode.addFork(path, reference, metadata)` -- build directory structure
- `MantarayNode.saveRecursively(bee, batchId)` -- upload to Swarm
- `MantarayNode.loadRecursively(bee)` -- download and traverse

**Streaming (for large uploads):**
- `streamDirectory(bee, dir, batchId, onProgress)` -- stream upload with progress
- Uses `cafe-utility` MerkleTree for client-side chunking with concurrency of 64

### 1.2 Era1 Parsing

**`@ethereumjs/e2store`** -- First-party EthereumJS package for era1/era/e2hs parsing:
- Part of the [EthereumJS monorepo](https://github.com/ethereumjs/ethereumjs-monorepo)
- Supports reading era1 files: headers, bodies, receipts, total difficulty per block
- Each era1 file contains up to 8,192 blocks
- npm: https://www.npmjs.com/package/@ethereumjs/e2store

### 1.3 Ethereum Block Parsing

| Package | Purpose |
|---------|---------|
| `@ethereumjs/block` | Block creation, parsing, validation |
| `@ethereumjs/tx` | Transaction types (legacy, EIP-1559, EIP-4844, etc.) |
| `@ethereumjs/common` | Chain/hardfork configuration |
| `@ethereumjs/rlp` | RLP encode/decode (~1.76M weekly downloads) |
| `@ethereumjs/trie` | Merkle Patricia Tree implementation |
| `@ethereumjs/util` | Byte conversion, signatures, types |

### 1.4 SSZ for Accumulator Verification

**`@chainsafe/ssz`** -- TypeScript SSZ implementation from ChainSafe/Lodestar:
- Serialization, deserialization, merkleization (hash_tree_root)
- Needed to verify era1 epoch accumulators
- npm: https://www.npmjs.com/package/@chainsafe/ssz

### 1.5 Real-Time Block Subscription

**`viem`** -- Modern, fully typed, tree-shakeable (~35kB). Recommended for new TS projects:
- `watchBlocks()` / `watchBlockNumber()` for real-time subscriptions
- Full JSON-RPC support, WebSocket subscriptions
- `getBlock()`, `getTransaction()`, `getTransactionReceipt()` for fetching data
- npm: https://www.npmjs.com/package/viem

### 1.6 Block Explorer UI References

- **Ethereum Lite Explorer** (Alethio) -- React + MobX + TS, client-side only, connects to JSON-RPC
- **Otterscan** -- React-based, runs against local Erigon node
- **EthVM** -- Vue.js + TypeScript + Apollo GraphQL

---

## 2. Architecture Options

### Option A: Era1 Files on Swarm + Web Explorer (Recommended for PoC)

```
                    +-----------------+
                    |  Era1 Sources   |
                    | (ethPandaOps,   |
                    |  Nimbus, etc.)  |
                    +--------+--------+
                             |
                    fetch era1 files
                             |
                    +--------v--------+
                    |  fullcircle-cli  |  (TypeScript)
                    |  - parse era1   |  (@ethereumjs/e2store)
                    |  - upload to    |  (@ethersphere/bee-js)
                    |    Swarm        |
                    |  - build index  |  (Mantaray manifest)
                    +--------+--------+
                             |
              Swarm manifest: /epoch/0000/ -> ref
                              /epoch/0001/ -> ref
                              /blocks/0/{hash} -> block data
                             |
                    +--------v--------+
                    |  Web Explorer   |  (SvelteKit)
                    |  - browse       |
                    |    blocks       |
                    |  - view txs     |
                    |  - search by    |
                    |    block #      |
                    +--------+--------+
                             |
                    reads from Swarm via bee-js
                             |
                    +--------v--------+
                    |  Client Import  |
                    |  Download era1  |
                    |  from Swarm ->  |
                    |  geth import    |
                    +-----------------+
```

**Implementation:**
1. **Ingestion CLI** (TypeScript): Fetch era1 files from public endpoints, parse with `@ethereumjs/e2store`, upload to Bee, build a Mantaray manifest organizing files by epoch
2. **Web Explorer** (SvelteKit): Browse blocks/txs stored on Swarm, search by block number, view decoded block data -- all reads via bee-js from Swarm gateway
3. **Export tool**: Download era1 files from Swarm for client import (`geth import-history`)

**Key libraries:** `@ethersphere/bee-js`, `@ethereumjs/e2store`, `@ethereumjs/block`, `@ethereumjs/rlp`

**Pros:** Full TypeScript stack. Visual demo. No client modifications. Uses existing era1 infrastructure.
**Cons:** Batch process for historical data. Need a running Bee node.

### Option B: Real-Time Block Archival + Live Dashboard

```
[Ethereum RPC]                    [Swarm Network]
     |                                  ^
     | viem: watchBlocks()              | bee-js: uploadData()
     v                                  |
+----+----+    block data     +---------+---------+
| Block    | ───────────────> | fullcircle-daemon  |
| Listener |                  | - RLP encode       |
+----------+                  | - Upload to Swarm  |
                              | - Update feed      |
                              +---------+----------+
                                        |
                              feed: "latest-block" -> ref
                                        |
                              +---------v----------+
                              |  Live Dashboard    |  (SvelteKit)
                              |  - Real-time       |
                              |    block feed      |
                              |  - Block details   |
                              |  - TX explorer     |
                              +--------------------+
```

**Implementation:**
1. **Daemon** (TypeScript): Connect to Ethereum RPC via `viem`, subscribe to new blocks, encode and upload each block to Swarm, update a Swarm feed with the latest block reference
2. **Dashboard** (SvelteKit): Real-time block explorer reading from Swarm feed, auto-updating as new blocks arrive

**Key libraries:** `viem`, `@ethersphere/bee-js`, `@ethereumjs/block`, `@ethereumjs/rlp`

**Pros:** Real-time. Compelling live demo. Shows Swarm's mutable feed capability.
**Cons:** Requires an Ethereum RPC endpoint. Ongoing postage stamp cost.

### Option C: Geth Freezer Backend on Swarm (Go)

Replace Geth's "ancient" (freezer) database backend with a Swarm-backed store. This is a Go project (Geth is Go), but could be combined with a TypeScript frontend.

**Implementation:** Implement the `ethdb.AncientStore` interface with Swarm as backend.

**Pros:** Deep integration, node reads directly from Swarm.
**Cons:** Requires Go. Latency concerns. Requires Geth fork.

### Option D: Trie Nodes as Swarm Chunks (State on Swarm)

Per the zelig proposal -- treat Ethereum state trie nodes as Swarm chunks. Requires Bee protocol changes (Keccak256 addressing vs BMT).

**Pros:** Most ambitious -- enables trustless state access from Swarm.
**Cons:** Requires Bee changes. Research-stage.

---

## 3. Recommended Approach

### For the Accelerator PoC (Days) -- TypeScript-First

**Combine Option A + B: Era1 archival + real-time blocks + web explorer.**

#### Day 1: Foundation

**Set up monorepo** with three packages:

```
fullcircle/
  packages/
    core/           # Shared: era1 parsing, Swarm upload/download, block encoding
    cli/            # CLI tool: ingest era1 files, upload, build index
    web/            # SvelteKit web explorer: browse blocks on Swarm
  package.json
  tsconfig.json
```

**Core library** (`packages/core`):
```
npm install @ethersphere/bee-js @ethereumjs/e2store @ethereumjs/block
            @ethereumjs/rlp @ethereumjs/common viem
```

Key functions to implement:
- `parseEra1(file: Uint8Array)` -> parsed blocks (using `@ethereumjs/e2store`)
- `uploadEra1ToSwarm(bee, batchId, era1Data)` -> Swarm reference
- `buildEpochManifest(bee, batchId, epochs)` -> manifest reference
- `downloadBlockFromSwarm(bee, manifestRef, blockNumber)` -> decoded block
- `encodeBlockForSwarm(block)` -> Uint8Array (RLP-encoded)

#### Day 2: Ingestion Pipeline

**CLI tool** (`packages/cli`):
1. Fetch era1 files from `https://data.ethpandaops.io/era1/mainnet/`
2. Parse with `@ethereumjs/e2store`
3. Upload to Bee node via `bee.uploadData(batchId, era1Data)`
4. Build a Mantaray manifest: `/epoch/{epochNumber}` -> era1 reference
5. Also index individual blocks: `/block/{blockNumber}` -> block data reference

**Start small:** Upload just 1-2 epochs (~16K blocks) to prove the concept.

#### Day 3: Web Explorer

**SvelteKit app** (`packages/web`):
- Landing page: list of available epochs on Swarm
- Epoch view: list of blocks in an epoch
- Block view: decoded header, transaction list, receipts
- Search: jump to block by number
- All data fetched from Swarm via `bee-js` (can use public gateway)

#### Day 4: Real-Time Extension

**Block listener daemon** (add to `packages/cli`):
1. Connect to Ethereum RPC via `viem`
2. `watchBlocks()` -> on each new block:
   - Fetch full block + receipts
   - RLP-encode and upload to Swarm
   - Update a Swarm feed: topic = "fullcircle-latest"
3. Web explorer subscribes to the feed for live updates

#### Day 5: Polish + Full Loop Test

1. Test the full bootstrap loop:
   - Download era1 from Swarm
   - Import into a fresh Geth node (`geth import-history`)
   - Verify node syncs from imported history
2. Polish the web explorer UI
3. Document everything

### Key TypeScript Dependencies

| Package | Purpose |
|---------|---------|
| `@ethersphere/bee-js` | Swarm upload/download/feeds/manifests |
| `@ethereumjs/e2store` | Era1 file parsing |
| `@ethereumjs/block` | Block creation and parsing |
| `@ethereumjs/rlp` | RLP encode/decode |
| `@ethereumjs/common` | Chain/hardfork config |
| `@chainsafe/ssz` | SSZ for accumulator verification |
| `viem` | Ethereum RPC + real-time block subscriptions |

### Stretch Goals

- **Blob archival**: Post-Dencun blobs are pruned after ~18 days. Archive them on Swarm.
- **State snapshots**: Periodic state trie snapshots uploaded to Swarm
- **P2P block gossip**: Use Swarm PSS for real-time block notification
- **Geth plugin**: Modify Geth to check Swarm before failing on missing historical data (Go)
- **Verification UI**: Show Merkle proofs that blocks on Swarm match the canonical chain
