# FullCircle: Storing Ethereum Blockchain Data on Swarm

## Research Document

**Project:** [ethersphere/swarm-accelerator#5](https://github.com/ethersphere/swarm-accelerator/issues/5)
**Goal:** Store Ethereum (ETH) blockchain data on Swarm so that it can be accessible for everyone. Explore whether a full node can bootstrap from Swarm and write block data to it.
**Team:** @agazso, @vojtechsimetka, @david-gauquelin

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Ethereum Data: What Needs to Be Stored](#2-ethereum-data-what-needs-to-be-stored)
3. [Swarm Storage Primitives](#3-swarm-storage-primitives)
4. [Prior Art and Existing Proposals](#4-prior-art-and-existing-proposals)
5. [EIP-4444 and History Expiry](#5-eip-4444-and-history-expiry)
6. [Portal Network](#6-portal-network)
7. [Era1/Era File Format](#7-era1era-file-format)
8. [Technical Challenges](#8-technical-challenges)
9. [References](#9-references)

---

## 1. Executive Summary

EIP-4444 (history expiry) is now live across all major Ethereum execution clients. Pre-merge history (~300-500 GB) can be pruned, and rolling expiry of older data is planned. This creates real demand for decentralized historical data distribution.

Swarm is a natural fit for this because:
- Ethereum trie nodes are under 4KB and Keccak256-addressed, closely matching Swarm's chunk model
- Era1 files (the standard archive format) are content-addressed, self-verifying, and immutable
- Swarm provides economic incentives (BZZ tokens) for persistence, unlike the Portal Network's altruistic model

The Portal Network is Ethereum's own answer to history distribution, but it's altruistic/voluntary with no persistence guarantees. Swarm and Portal are complementary, not competitive.

---

## 2. Ethereum Data: What Needs to Be Stored

### 2.1 Block Structure

An Ethereum block consists of:

| Component | Description | Encoding | Typical Size |
|---|---|---|---|
| Header | Parent hash, state root, tx root, receipts root, bloom filter, gas, timestamp, etc. | RLP | ~500-600 bytes |
| Body | Transactions + withdrawals (post-Shanghai) | RLP | Variable (avg ~100-200 KB total block) |
| Receipts | Status, gas used, logs, bloom per transaction | RLP | Variable |
| Ommers | Always empty post-Merge | RLP | Negligible |

### 2.2 State Trie

Ethereum uses a Modified Merkle Patricia Trie (MPT) with four sub-tries per block:
- **State trie**: `keccak256(address)` -> `rlp([nonce, balance, storageRoot, codeHash])`
- **Storage trie**: Per-contract key-value storage
- **Transaction trie**: Per-block transaction index
- **Receipt trie**: Per-block receipt index

Trie node types: branch (17-element), extension (path + next), leaf (path + value). All nodes are Keccak256-addressed and typically under 4KB -- a natural fit for Swarm chunks.

### 2.3 Data Sizes (2025-2026)

| Data Category | Size | Notes |
|---|---|---|
| Pre-merge history (bodies + receipts) | 300-500 GB | What EIP-4444 prunes first |
| Post-merge history | ~200-400 GB, growing | ~50-60 GB/month |
| All headers (genesis to present) | ~10-15 GB | Relatively small |
| Current state snapshot | ~50+ GB | Growing continuously |
| Historical state (Erigon-optimized) | 1.6-2 TB | Up to 20 TB unoptimized (Geth hash-based) |

| Client & Mode | Disk Size |
|---|---|
| Geth full node (snap sync, pruned) | 650-700 GB |
| Geth path-based archive | 1.9-2.0 TB |
| Erigon full node | ~1 TB |
| Erigon archive | 1.6-1.77 TB |

Chain growth: ~7,200 blocks/day, ~50-60 GB/month (full node before pruning).

### 2.4 Encoding Formats

- **RLP (Recursive Length Prefix)**: Execution layer canonical format. Deterministic, compact, no type system.
- **SSZ (Simple Serialize)**: Consensus layer format. Supports Merkleization and efficient proofs. Portal Network uses SSZ.
- **Transition**: Ethereum is gradually moving from RLP to SSZ. Era1 files store `snappy(rlp(data))`.

---

## 3. Swarm Storage Primitives

### 3.1 Chunks and the DISC Model

Swarm stores data as 4KB chunks distributed via the DISC (Distributed Immutable Storage of Chunks) model -- a modified Kademlia DHT where nodes store actual chunk data, not just pointers.

**Content-Addressed Chunks (CAC):**
```
address = keccak256(span || bmt_root_hash(payload))
```
- Payload: up to 4096 bytes
- Span: 8-byte little-endian uint64 (total data length of subtree)
- BMT: Binary Merkle Tree hash over 128 x 32-byte segments of the padded payload

**Single Owner Chunks (SOC):**
```
address = keccak256(identifier || owner_eth_address)
```
- Enables mutable content at deterministic addresses
- Owner signs `keccak256(identifier || cac_address)` for integrity

### 3.2 File Chunking (Merkle Tree)

Large files are split into a tree with **branching factor 128** (4096 / 32 = 128 hashes per chunk):

| Tree Level | Data Addressable |
|---|---|
| 0 (leaves) | 4 KB per chunk |
| 1 | 512 KB |
| 2 | 64 MB |
| 3 | 8 GB |
| 4 | 1 TB |
| 8 | ~16 EB |

The root chunk's address becomes the file's reference. Retrieval is top-down: download root, extract child references, recurse until leaf data chunks are reached.

### 3.3 Feeds

Built on SOCs. A feed is identified by `(owner_address, topic)`:
```
feed_identifier = keccak256(topic || index)
```
Sequential index enables mutable pointers -- perfect for "latest block" or "latest era1 file" references.

### 3.4 Manifests (Mantaray)

Compact trie (prefix tree) mapping URL-like paths to content references. Enables directory-style access to collections of files under a single root reference.

### 3.5 Erasure Coding (Bee 2.0+)

Four protection levels (Medium/Strong/Insane/Paranoid) adding parity chunks. A 1GB object with 5:2 encoding uses 1.4GB vs 3GB for triple replication.

### 3.6 Storage Economics

Uploads require purchasing **postage stamps** (BZZ tokens). Pricing is dynamic based on supply/demand. Unpaid content is garbage-collected. For TB-scale blockchain data, ongoing stamp costs are a significant consideration.

---

## 4. Prior Art and Existing Proposals

### 4.1 "Ethereum Blockchain State on Swarm" (Viktor Tron / zelig)

**Source:** https://hackmd.io/@zelig/Bkt-c42YV

Proposes treating trie nodes as Swarm chunks using Keccak256 hashes as content addresses. Four-phase implementation:

1. **Raw retrieval** via `bzz-eth-raw://<keccak256-hash>/` -- retrieve any trie node by its hash
2. **Trie-aware traversal** -- navigate the trie by key path in the URL
3. **Outsourced traversal with Merkle proofs** via PSS -- light clients request state, neighborhood nodes execute proofs
4. **Syncing support** with pinning feeds for persistence

**Key insight:** State trie nodes are naturally content-addressed by Keccak256 and under 4KB, making them native Swarm chunks (modulo the hash function difference -- Swarm uses BMT, not raw Keccak256).

### 4.2 "Trustless Access to Ethereum State with Swarm"

**Source:** https://ethresear.ch/t/trustless-access-to-ethereum-state-with-swarm/17350

Proposes Swarm as a "state cache and load balancer": light clients request state from Swarm first; neighborhood nodes fetch from connected full nodes on cache miss. Enables verifiable access via Merkle proofs against header chains.

### 4.3 "Swarm Data Chain" (jmozah)

**Source:** https://hackmd.io/@jmozah/HyEBlTWmR

A dedicated blockchain (CometBFT/Cosmos SDK) managing data from other blockchains using Swarm as storage. DPoS with BZZ staking. Supports blobs, blocks, state, logs, receipts.

### 4.4 "Ethereum's Data Roadmap and Client Democratisation"

**Source:** https://hackmd.io/@tonytony/Hk0KtEvuj

Identifies Swarm as one of six potential actors for serving historical data post-EIP-4444.

### 4.5 Solana + Filecoin ("Old Faithful")

Triton One's project archives Solana's entire ledger on Filecoin/IPFS (~250 TB, growing ~500 GB every 2 days). Uses CAR (Content Addressable Archives) format. Best existing precedent for blockchain-on-decentralized-storage at scale.

### 4.6 IPLD Ethereum Codecs

IPLD has Ethereum codec specs for state data structures: https://ipld.io/specs/codecs/dag-eth/state/

---

## 5. EIP-4444 and History Expiry

### Status (July 2025+)

**Phase 1 is live.** All major execution clients support partial history expiry:

- **Geth v1.16.0+**: `geth prune-history` command, `--history.chain postmerge` flag
- **Nethermind, Besu, Erigon**: All support pre-merge history dropping
- **Immediate savings**: 300-500 GB disk reclaimed

### EIP-7927 (Meta EIP)

Bundles related changes:
- **EIP-4444**: Pruning policy
- **EIP-7642**: New `eth/69` DevP2P protocol (doesn't serve pre-merge history)
- **EIP-7639**: Permission to drop pre-merge history
- **EIP-7801 (`etha`)**: New subprotocol for P2P historical data retrieval

### Future: Rolling History Expiry

Continuously pruning data older than ~1 year. Would keep node disk requirements stable regardless of chain age. This makes decentralized historical data distribution increasingly critical.

### Implication for FullCircle

With history being actively dropped from nodes, there's urgent need for reliable alternative distribution. Swarm can fill this gap alongside the Portal Network.

---

## 6. Portal Network

### Architecture

Ethereum's own solution for distributing historical data. Multiple specialized DHT sub-networks built on Discovery v5:

| Sub-network | Purpose |
|---|---|
| History Network | Block bodies and receipts |
| Beacon Light Client | Consensus layer tracking |
| State Network | Account and contract storage |
| Transaction Gossip | Lightweight mempool |

### How It Works

- Each node stores a fraction of total data (controlled by `data_radius`)
- Content addressed by block number using bit-manipulation for even distribution
- Four implementations: Trin (Rust), Fluffy (Nim), Ultralight (TypeScript), Shisui (Go)

### Content Keys (History Network)

- Block bodies: `0x00 + SSZ(block_number)`
- Receipts: `0x01 + SSZ(block_number)`
- Data encoded as RLP, matching native execution client format

### Portal vs Swarm

| Aspect | Portal Network | Swarm |
|---|---|---|
| Scope | Ethereum-specific | General-purpose storage |
| Incentives | Altruistic/voluntary | BZZ token economics |
| Data model | Block-number addressed | Content-hash addressed |
| Verification | Built-in header chain proofs | BMT hash verification |
| Persistence | Best-effort, no guarantees | Postage stamp-funded |
| Integration | Built into EL clients | Separate network |

**They are complementary, not competitive.** Portal has deeper Ethereum integration but no persistence guarantees. Swarm has economic incentives but needs additional verification layers.

---

## 7. Era1/Era File Format

### Era1 (Pre-Merge Execution Layer History)

Built on e2store (type-length-value container format):

```
era1 := Version | block-tuple* | Accumulator | BlockIndex
block-tuple := CompressedHeader | CompressedBody | CompressedReceipts | TotalDifficulty
```

| Entry | Type Code | Contents |
|---|---|---|
| CompressedHeader | `0x0300` | `snappyFramed(rlp(header))` |
| CompressedBody | `0x0400` | `snappyFramed(rlp(block_body))` |
| CompressedReceipts | `0x0500` | `snappyFramed(rlp(receipts))` |
| TotalDifficulty | `0x0600` | `uint256` |
| Accumulator | `0x0700` | SSZ hash_tree_root of header records |
| BlockIndex | `0x6632` | Starting number + offsets + count |

**Key properties:**
- **8,192 blocks per file** max
- **Snappy compressed** after RLP encoding
- **Self-verifying**: accumulator root can be validated against known canonical accumulator
- **Naming**: `mainnet-<6-digit-epoch>-<8-char-accumulator-root>.era1`

### Era (Post-Merge / Beacon Chain)

Same structure but with SSZ-encoded beacon blocks instead of RLP.

### Era1 File Sources

From [eth-clients/history-endpoints](https://github.com/eth-clients/history-endpoints):

| Source | URL |
|--------|-----|
| ethPandaOps (mainnet) | `https://data.ethpandaops.io/era1/mainnet/` |
| Nimbus (mainnet) | `https://mainnet.era1.nimbus.team` |
| ethPandaOps (Sepolia) | `https://data.ethpandaops.io/era1/sepolia/` |
| Torrent | Available via magnet link |

Files follow naming: `mainnet-<epoch>-<root>.era1`, each epoch = 8,192 blocks.

### Why Era1 is a Natural Fit for Swarm

1. **Content-addressed** (accumulator root in filename)
2. **Self-verifying** (embedded SSZ accumulator)
3. **Immutable** (historical data never changes)
4. **Manageable sizes** (8,192 blocks per file)
5. **Already compressed** (Snappy)
6. **Standardized** -- all clients support import/export

---

## 8. Technical Challenges

### 8.1 Data Scale

At 4KB per chunk, 1 TB = ~250 million chunks. Full Ethereum history (~1 TB) would require significant Swarm network capacity and postage stamp funding.

### 8.2 Hash Function Mismatch

Swarm uses BMT hashes; Ethereum state uses Keccak256. Storing era1 files as opaque blobs avoids this issue. But for state-on-Swarm approaches (trie nodes as chunks), this requires protocol-level changes to Bee or a mapping layer.

### 8.3 Retrieval Latency

Swarm chunk retrieval adds network latency vs local disk. For block sync (which requires rapid sequential state access), aggressive caching would be needed. For historical data distribution (era1 files), bulk transfer latency is acceptable.

### 8.4 Indexing

Ethereum data is naturally indexed by block number, tx hash, address, and log topics. Swarm's content addressing doesn't natively support these query patterns. Solutions:
- Feeds for block-number -> reference mapping
- Manifests for structured access
- Separate index structures built on Swarm

### 8.5 Persistence Economics

Keeping 1+ TB alive indefinitely requires ongoing postage stamp purchases. No natural economic incentive for Swarm nodes to store blockchain data unless specifically funded. This is an operational cost that needs a sustainability model.

### 8.6 Verification

Era1 files are self-verifying via accumulator roots. Individual chunks can be BMT-verified. But verifying that data represents valid Ethereum blocks requires the header chain context. A full trustless solution needs Merkle proofs against known block headers.

---

## 9. References

### Ethereum Data & History Expiry
- [EIP-4444: Bound Historical Data in Execution Clients](https://eips.ethereum.org/EIPS/eip-4444)
- [EIP-7927: History Expiry Meta](https://eips.ethereum.org/EIPS/eip-7927)
- [Ethereum Foundation: Partial History Expiry (July 2025)](https://blog.ethereum.org/en/2025/07/08/partial-history-exp)
- [Era1 Format Specification](https://github.com/eth-clients/e2store-format-specs/blob/main/formats/era1.md)
- [History Endpoints Registry](https://github.com/eth-clients/history-endpoints)
- [Geth Database Documentation](https://geth.ethereum.org/docs/fundamentals/databases)

### Portal Network
- [Portal Network Specs](https://github.com/ethereum/portal-network-specs)
- [Portal Network History Sub-protocol](https://github.com/ethereum/portal-network-specs/blob/master/history/history-network.md)
- [ethereum.org Portal Network](https://ethereum.org/developers/docs/networking-layer/portal-network/)

### Swarm + Ethereum Proposals
- [Ethereum Blockchain State on Swarm (zelig)](https://hackmd.io/@zelig/Bkt-c42YV)
- [Trustless Access to Ethereum State with Swarm](https://ethresear.ch/t/trustless-access-to-ethereum-state-with-swarm/17350)
- [Swarm Data Chain (jmozah)](https://hackmd.io/@jmozah/HyEBlTWmR)
- [Ethereum's Data Roadmap and Client Democratisation](https://hackmd.io/@tonytony/Hk0KtEvuj)

### Swarm Documentation
- [Swarm DISC Model](https://docs.ethswarm.org/docs/concepts/DISC/)
- [Swarm Erasure Coding](https://docs.ethswarm.org/docs/concepts/DISC/erasure-coding/)
- [Swarm Feeds](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds/)
- [Swarm Chunk Types](https://docs.ethswarm.org/docs/develop/tools-and-features/chunk-types/)
- [Bee API Reference](https://docs.ethswarm.org/api/)
- [The Book of Swarm](https://docs.ethswarm.org/the-book-of-swarm-viktor-tron-v1.0-pre-release7.pdf)

### Other Decentralized Storage Projects
- [Old Faithful: Solana on Filecoin](https://docs.triton.one/project-yellowstone/old-faithful-historical-archive/old-faithful-public-report)
- [IPLD Ethereum Codecs](https://ipld.io/specs/codecs/dag-eth/state/)

### Ethereum Data Structures
- [ethereum.org: Patricia Merkle Trie](https://ethereum.org/developers/docs/data-structures-and-encoding/patricia-merkle-trie/)
- [ethereum.org: RLP Encoding](https://ethereum.org/developers/docs/data-structures-and-encoding/rlp/)
- [ethereum.org: SSZ](https://ethereum.org/developers/docs/data-structures-and-encoding/ssz/)

### TypeScript Libraries
- [@ethereumjs/e2store (Era1 parsing)](https://www.npmjs.com/package/@ethereumjs/e2store)
- [@ethereumjs/block (Block parsing)](https://www.npmjs.com/package/@ethereumjs/block)
- [@ethereumjs/rlp (RLP encoding)](https://www.npmjs.com/package/@ethereumjs/rlp)
- [@chainsafe/ssz (SSZ for TypeScript)](https://github.com/ChainSafe/ssz)
- [viem (Ethereum RPC client)](https://viem.sh)
- [EthereumJS Monorepo](https://github.com/ethereumjs/ethereumjs-monorepo)

### Client Implementations
- [Erigon Documentation](https://docs.erigon.tech/get-started/readme/why-using-erigon)
- [Erigon v3 Architecture](https://erigon.tech/announcing-erigon-v3-beta-1-a-scalable-and-efficient-ethereum-integrated-client/)
