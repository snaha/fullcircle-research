# FullCircle: Storing Ethereum State on Swarm

## Research Document

**Project:** [ethersphere/swarm-accelerator#5](https://github.com/ethersphere/swarm-accelerator/issues/5)
**Scope of this document:** Methods for extracting Ethereum state (accounts, balances, storage) from an execution client and putting it on Swarm. Focus is on the **balance-history-for-an-address** use case first, **periodic full-state snapshots** second.
**Related documents:** [RESEARCH.md](./RESEARCH.md) (state trie structure §2.2, hash mismatch §8.2, Viktor Tron's state-on-Swarm proposal §4.1), [PROPOSAL.md](./PROPOSAL.md) (state currently listed only as a stretch goal), [SCALE.md](./SCALE.md) (index-size ceiling carried over from block/tx indexing).

---

## Table of Contents

1. [Why State Is a Different Problem](#1-why-state-is-a-different-problem)
2. [The Easy Option: Geth's Live Tracer API](#2-the-easy-option-geths-live-tracer-api)
3. [Driving the Tracer From Archived History](#3-driving-the-tracer-from-archived-history)
4. [Tracer Design Sketch](#4-tracer-design-sketch)
5. [Swarm Upload: Address-Keyed Index](#5-swarm-upload-address-keyed-index)
6. [Stage 2: Progressive State Diffs + Sparse Baselines](#6-stage-2-progressive-state-diffs--sparse-baselines)
7. [Alternatives Compared](#7-alternatives-compared)
8. [Cross-Check and Oracle](#8-cross-check-and-oracle)
9. [Open Questions and TBDs](#9-open-questions-and-tbds)
10. [Recommended Path](#10-recommended-path)
11. [Primary Sources](#11-primary-sources)

---

## 1. Why State Is a Different Problem

The FullCircle tooling today archives **block and tx history**: immutable, sequential, naturally chunked into 8 192-block eras, each erae file self-verifying. State does not behave that way.

| Property | Blocks / tx history | State |
|---|---|---|
| Immutability | Immutable once sealed | Mutable — every block rewrites some of it |
| Access pattern | Sequential scan, by block number | Random access, by `keccak(address)` |
| Natural unit | Era (8 192 blocks) | Account, storage slot, or trie node |
| Current size | ~300-500 GB pre-merge bodies + receipts | ~400 GB flat state, ~2 TB with history (PBSS archive, 2026 figures) |
| Verifiability on Swarm | Header chain anchors it | Keccak state root ≠ Swarm BMT root (see [RESEARCH.md §8.2](./RESEARCH.md)) |

"State on Swarm" is not one thing; it's at least three:

- **(a) Event stream.** The sequence of balance / storage / code changes per block, keyed by address. Answers "what happened to `0xAbc…` between blocks A and B."
- **(b) Progressive state.** Per-block state diffs uploaded as they happen, plus sparse baseline snapshots so consumers don't have to replay from genesis. State at block N = `baseline_at_B + forward_diffs(B..N)`. Answers "what does the world look like now" and "how did it get there." This is the right shape for Swarm: you only upload what changed, and the index is block-addressable.
- **(c) Live state service with proofs.** A trustless light-client protocol where Swarm returns state slices with MPT proofs against a current header. Covered in [Viktor Tron's "Trustless access to Ethereum State with Swarm"](https://ethresear.ch/t/trustless-access-to-ethereum-state-with-swarm/17350); out of scope for this document.

This document scopes **(a) as Stage 1** and **(b) as Stage 2**. Stage 1 is actually a projection of Stage 2 (balance-only view), so the same tracer run produces both — we just pick which outputs to upload first.

---

## 2. The Easy Option: Geth's Live Tracer API

**Verdict on "hijacking geth":** you don't need to. Since geth v1.14.0 (mid-2024) the upstream tree ships a first-class [live tracer API](https://geth.ethereum.org/docs/developers/evm-tracing/live-tracing) that fires in-process per-block hooks while blocks are executed. Forking geth buys nothing; the tracer API *is* the supported plugin surface.

### The hooks that matter

From [`core/tracing/hooks.go`](https://github.com/ethereum/go-ethereum/blob/master/core/tracing/hooks.go) (exact current signatures):

```go
// State mutation hooks
OnBalanceChange  func(addr common.Address, prev, new *big.Int, reason BalanceChangeReason)
OnNonceChange    func(addr common.Address, prev, new uint64)
OnCodeChange     func(addr common.Address, prevCodeHash common.Hash, prevCode []byte,
                      codeHash common.Hash, code []byte)
OnStorageChange  func(addr common.Address, slot common.Hash, prev, new common.Hash)
OnStateUpdate    func(update *StateUpdate)   // post-commit, full mutation set
OnLog            func(log *types.Log)

// Block lifecycle
OnBlockStart     func(event BlockEvent)
OnBlockEnd       func(err error)
OnGenesisBlock   func(genesis *types.Block, alloc types.GenesisAlloc)
OnSkippedBlock   func(event BlockEvent)
OnBlockchainInit func(chainConfig *params.ChainConfig)
OnClose          func()
```

`BalanceChangeReason` is a byte enum. The relevant constants for Stage 1:

| Reason | Meaning |
|---|---|
| `BalanceIncreaseRewardMineBlock` | Block mining reward (pre-merge) |
| `BalanceIncreaseRewardMineUncle` | Uncle block reward |
| `BalanceIncreaseRewardTransactionFee` | Transaction tip to coinbase |
| `BalanceIncreaseWithdrawal` | Beacon-chain withdrawal |
| `BalanceIncreaseGenesisBalance` | Genesis allocation |
| `BalanceIncreaseSelfdestruct` / `BalanceDecreaseSelfdestruct` | SELFDESTRUCT recipient / sender |
| `BalanceDecreaseSelfdestructBurn` | SELFDESTRUCT to already-destroyed account |
| `BalanceChangeTransfer` | Ordinary CALL value transfer |
| `BalanceChangeTouchAccount` | Zero-value touch-create |
| `BalanceDecreaseGasBuy` / `BalanceIncreaseGasReturn` | Gas accounting |
| `BalanceIncreaseDaoContract` / `BalanceDecreaseDaoAccount` | One-shot DAO fork refund (block 1 920 000) |
| `BalanceChangeRevert` | Journal revert (a prior change was undone) |

Those 15 reasons cover every way ETH can move. An indexer that subscribes to `OnBalanceChange` and groups by address receives an exhaustive, reason-tagged balance history — the feature no single RPC method provides natively.

### How to compile a tracer into geth without a fork

Tracers register at `init()`-time against the `tracers.LiveDirectory`:

```go
package main

import (
    "github.com/ethereum/go-ethereum/core/tracing"
    "github.com/ethereum/go-ethereum/eth/tracers"
)

func init() {
    tracers.LiveDirectory.Register("fullcircle-state", newTracer)
}

func newTracer(cfg json.RawMessage) (*tracing.Hooks, error) { /* … */ }
```

Rather than forking geth to add this file, use Sina Mahmoodi's [`geth-builder`](https://github.com/s1na/geth-builder) — a tool that vendors your tracer into a geth build. You run `geth-builder build` and get a `geth` binary with your tracer statically linked. Activate at runtime with `--vmtrace fullcircle-state` (optionally `--vmtrace.jsonconfig '{"path":"data/state"}'`).

[Marius Van Der Wijden's worked example](https://mariusvanderwijden.github.io/blog/2024/05/06/LiveTracer/) is the canonical reference. His tracer is ~200 LOC and emits balance/storage/log events as CSV; ours will emit NDJSON and is structurally identical.

---

## 3. Driving the Tracer From Archived History

This is the load-bearing operational detail, and it is where the naive plan goes wrong. FullCircle targets the **first 20 eras ≈ 163 840 pre-Byzantium blocks**, which means historical replay, not tip-following.

### The trap: `geth importhistory` does NOT fire live tracers

The obvious-sounding command — `geth importhistory <era1 dir>` — imports era1 files but routes through [`core.BlockChain.InsertReceiptChain`](https://github.com/ethereum/go-ethereum/blob/master/cmd/utils/cmd.go) (see [`utils.ImportHistory`](https://github.com/ethereum/go-ethereum/blob/master/cmd/utils/cmd.go)). `InsertReceiptChain` **trusts the pre-computed receipts from era1 and skips EVM execution entirely**. Without EVM execution, the state hooks never fire.

This is a feature for the normal use case (snap-sync–style bulk header/body/receipt ingestion is supposed to be fast), but it makes `importhistory` unusable for state extraction.

### The right command: `geth import <rlp>`

`geth import chain.rlp` (singular, not `importhistory`) delegates to `utils.ImportChain`, which calls `chain.InsertChain(missing)` — the full execution path that re-executes every block, mutates state, and fires live tracers. Pipeline:

1. **Init the DB with mainnet genesis** (one-time):
   ```sh
   geth --datadir <dir> init /path/to/mainnet-genesis.json
   ```
2. **Convert `.erae` → plain RLP chain file.** Era files are `snappy(rlp(block))` with E2Store framing; geth's `import` expects a concatenated RLP stream of blocks. We already parse erae in [`packages/era/src/erae.ts`](../packages/era/src/erae.ts); a small helper extracts decompressed RLP-encoded `[header, body]` pairs and concatenates them into a `.rlp` file.
3. **Run import with the tracer attached:**
   ```sh
   geth --datadir <dir> --vmtrace fullcircle-state \
        --vmtrace.jsonconfig '{"path":"data/state"}' \
        import chain.rlp
   ```
4. **Pause and resume naturally.** `geth import` resumes from the tip of whatever is already in the DB — pass one era's RLP at a time, stop whenever, continue with the next era, tracer output appends to the same directory. This matches the "process a bounded batch, pause, resume" workflow the user asked for.

### Why not sync from genesis?

You *could* run `geth --vmtrace … --syncmode=full` from genesis peer-to-peer; it works but it's slower, requires network reliability, and for 163 840 blocks is overkill. `geth import` is faster (no peer round-trips), deterministic, and scoped to exactly the blocks you feed it.

### Archive vs full GC mode

For **Stage 1 only** (events, no snapshots): `--gcmode=full` is fine — we don't need historical state kept around, only the per-block deltas we emit. For **Stage 2**: `--gcmode=archive --state.scheme=path` (PBSS archive — ~2 TB at mainnet tip, ~10 GB for the first 20 eras).

---

## 4. Tracer Design Sketch

Not implementation — just what the Go tracer should produce so downstream TS tooling has a clean contract. Every record is one line of NDJSON, hex strings are 0x-prefixed, decimals are strings to survive JSON's 2^53 ceiling.

### Output files

Per invocation, written to `data/state/`:

- `balance-events.ndjson` — one record per balance mutation, block-ordered:
  ```json
  {"block":"18300000","txIndex":5,"addr":"0xabc…","pre":"123…","post":"124…","reason":"transfer"}
  ```
- `state-meta.ndjson` — one record per block, as a checkpoint / sentinel:
  ```json
  {"kind":"block","block":"18300000","hash":"0x…","events":42,"cumulative":192847}
  ```

For Stage 2 or if the reader wants to diff storage, equivalent `storage-events.ndjson` and `code-events.ndjson` files fall out of `OnStorageChange` / `OnCodeChange` for free.

### Checkpoint contract

On `OnBlockStart`: stash `(blockNumber, parentHash)`. On `OnBlockEnd`: fsync, then append the sentinel. Reader trusts everything up to the last sentinel and truncates any partial tail past it.

Separate `last-processed.json`: `{"block":"18300000","hash":"0x…","ndjsonBytes":<offset>}`. Read on resume, seek, continue.

### Reorg handling

For historical replay of sealed blocks — not applicable; no reorgs happen. Keep a `{"kind":"revert","from":"N","to":"M"}` marker defined for when Stage 3 (tip-following) lands, but don't build logic the historical pipeline never uses.

---

## 5. Swarm Upload: Address-Keyed Index

Reuse, don't rebuild. The era package already has:

- [`packages/era/src/swarm.ts`](../packages/era/src/swarm.ts) — Mantaray manifest builder with chunk caching and consolidated snapshot files. Good when keys are strings with meaningful structure.
- [`packages/era/src/swarm-pot.ts`](../packages/era/src/swarm-pot.ts) — POT-JS KVS variant with 32-byte fixed keys. Good when keys are hashes.

Address-keyed balance history is a **POT fit**: key = `keccak256(address)` (32 bytes; also makes sharing a prefix with state-trie addressing natural), value = reference to a per-address event log.

### Proposed manifest layout

Three trees, mirroring the existing era package's `number/hash/tx` split pattern:

1. `byAddress/<keccak(addr)>` → reference to an append-only chunk (or chunk tree, once it outgrows 4 KB) of balance events for that address. Query: "give me every balance change for 0xAbc…" is one POT lookup + one Swarm download.
2. `byBlock/<block>` → reference to a chunk listing all events at that block. **This is what answers "which addresses had a balance change at block N"** — one POT lookup, one chunk download, client-side filter by event kind. Also useful for reindexing and debugging.
3. `meta` → counters, range covered, tracer version, chain config hash.

When per-address logs outgrow a single 4 KB chunk, wrap them in a small Mantaray (`byAddress/<hash>/chunks/0`, `…/1`, …) or — if mutability is wanted — a Swarm feed keyed by `keccak(addr)` with a signer per owner. For the 163 840-block PoC scope, most addresses will fit in one chunk.

### Scale note

Per [SCALE.md](./SCALE.md), the existing in-memory Mantaray builder breaks past ~10M keys. The first 20 eras on pre-Byzantium mainnet see well under 10M unique addresses, so we sit below the cliff. Full mainnet (~300M addresses) requires the LSM-backed streaming-Mantaray path SCALE.md already sketches — out of scope here but a known cliff to flag.

### Verifiability

For Stage 1 **events**, verifiability piggybacks on the block headers the existing era pipeline publishes. An event at block N is trustable iff:

1. The block header at block N (already on Swarm via the era manifest) is canonical.
2. Re-executing the transactions in that block against the state at block N-1 produces the same `OnBalanceChange` event.

There is no Swarm-native way to prove (2) cheaply today; in practice consumers will trust the tracer output and use the block-header chain as a spot-check oracle. Full trustlessness requires either re-execution by the consumer (expensive) or a proof scheme (out of scope).

For Stage 2 **snapshots**, verifiability is harder — Swarm BMT ≠ Ethereum Keccak state root, so we cannot check account records against a block header without a proof layer. See [RESEARCH.md §8.2](./RESEARCH.md) and the CHALLENGES.md sketch of "SOC with Keccak ID wrapping," both deferred.

---

## 6. Stage 2: Progressive State Diffs + Sparse Baselines

The goal "store the full state on Swarm, progressively, uploading only changes" argues for a different architecture than "periodic full snapshots." The canonical artefact becomes the **per-block state diff**; **sparse baseline snapshots** exist only to bound the replay cost for a consumer. State at block N is reconstructed as:

```
state(N) = snapshot(B) + apply_forward(diff[B+1], diff[B+2], …, diff[N])
```

for the nearest baseline `B ≤ N`. This composes cleanly with Stage 1 — Stage 1's balance-events file is the balance-only projection of the same diff stream.

### The diff model

The geth live tracer's `OnStateUpdate` hook fires once per block, post-commit, with the full mutation set. The equivalent coarser hooks (`OnBalanceChange`, `OnNonceChange`, `OnCodeChange`, `OnStorageChange`) fire during execution. The tracer captures whichever is cleaner; the upload layer emits, per block:

- **Account diffs**: `{addr, pre:{balance,nonce,codeHash}, post:{balance,nonce,codeHash}}` — one entry per touched account
- **Code diffs**: `{addr, codeHash, code}` — only when `codeHash` changed (deployment or self-destruct rebirth)
- **Storage diffs**: `{addr, slot, pre, post}` — one entry per SSTORE that actually changed a value

Pre and post are both captured so a consumer can verify + replay without needing a neighbouring diff.

### Layout on Swarm

Two artefact classes:

**Diffs (per block, the hot path):**
- `diff/<block>` → chunk(s) containing the RLP-encoded account + code + storage diffs for that block. Most pre-Byzantium blocks fit in a single 4 KB chunk; recent mainnet blocks span many chunks (thousands of SSTOREs per block on a busy day).

**Baselines (sparse, the cold path):**
- `snapshot/<block>` → Mantaray keyed by `keccak(addr)` → RLP-encoded account record at block B. Generated via [`geth snapshot dump --iterative`](https://github.com/ethereum/go-ethereum/blob/master/cmd/geth/snapshot.go).
- Genesis is the cheap first baseline (~9 000 allocations, single-digit MB). Subsequent baseline cadence is a tuning knob: once per era (8 192 blocks) is fine for pre-Byzantium; sparser further along (e.g. once per 100 000 blocks) for modern blocks where a snapshot is hundreds of GB.

**Indexes on top (reuse Stage 1's):**
- `byAddress/<keccak(addr)>` → list of `diff/<block>` pointers where this address was touched
- `byBlock/<block>/addresses` → list of addresses touched at this block (subset of `diff/<block>` optimised for the "who changed at N" query from §5)

### Reconstruction recipes

"State of address A at block N" (client code, pseudocode):
```ts
const B     = nearestBaselineBelow(N)
let   state = download(`snapshot/${B}/${keccak(A)}`)
for (const block of walk(`byAddress/${keccak(A)}`, { from: B+1, to: N })) {
  const delta = download(`diff/${block}`).forAddress(A)
  state = apply(state, delta)
}
return state
```

"Every address that changed at block N" (the user's new query):
```ts
return download(`byBlock/${N}/addresses`)
```

"Every address whose *balance* changed at block N":
```ts
return download(`byBlock/${N}/addresses`).filter(e => e.fields.includes('balance'))
```

### Scale notes

- **Pre-Byzantium (the 163 840-block scope):** most blocks touch <20 addresses and handful of slots; total diff volume for 20 eras is in the hundreds of MB range. Well within the PoC budget.
- **Modern blocks:** post-Cancun mainnet blocks can carry tens to hundreds of KB of diff each. A full year's diffs would be multiple TB. Plan to exclude storage for initial phases (`exclude-storage`) and fold it in behind a separate manifest once the balance+code path is solid.
- **Baseline size:** the genesis baseline is trivial. A mid-history baseline (e.g. at block 10M) runs ~10-50 GB of account records — still tractable. Mainnet-tip baseline is ~400 GB flat and needs the LSM-backed streaming-Mantaray path from [SCALE.md](./SCALE.md).
- **`byAddress` cardinality:** same cliff as [SCALE.md](./SCALE.md) describes for tx indexing — breaks past ~10M keys. Fine for PoC, not fine for full mainnet without the streaming emitter.

### Verifiability

Per-block diffs can be checked against block state roots if the consumer re-executes (expensive, but every diff is independently auditable against `state_root_{N-1}` + `block_N`). Without re-execution, diffs are trusted — same constraint as Stage 1 events. The [Swarm BMT ≠ Ethereum Keccak state root](./RESEARCH.md#82-hash-mismatch) problem means we can't cheaply verify baseline snapshots against a header without a proof layer; deferred.

### Out of scope here

Exact chunk boundaries for multi-chunk diffs; trustless proof scheme; contract-code chunking (code can exceed 4 KB, Portal caps at 32 KB split across entries — see [Portal state sub-network spec](https://github.com/ethereum/portal-network-specs/blob/master/legacy/state/state-network.md)); baseline cadence policy; stamp / postage at scale.

---

## 7. Alternatives Compared

| # | Approach | Lang | Backfill for 163 840 blocks | Tip-following | Balance-of-address fit | Full-state fit | When to switch |
|---|---|---|---|---|---|---|---|
| 1 | **Geth live tracer + `geth import`** | Go | Excellent | Excellent | Excellent (`OnBalanceChange`) | Partial (deltas only) | — |
| 2 | **Reth ExEx** | Rust | Via `reth import` + `ChangedAccount` iter | Excellent (10× RPC perf, reorg-safe) | Excellent | Good (`ExecutionOutcome`) | Perf ceiling bites, or team writes Rust comfortably |
| 3 | **ethereumjs/vm re-execution in TypeScript** | TS | Good, stays in-workspace | OK | OK (hook `StateManager`) | OK | You want to avoid adding Go to the repo. Watch fork correctness on modern HFs; safe pre-Byzantium |
| 4 | **RPC `trace_replayBlockTransactions` via hosted archive** | TS | OK (slow, paid) | Slow | OK | OK | Backfill sanity-check or one-off data pull |
| 5 | **[`cryo`](https://github.com/paradigmxyz/cryo)** (`balance_diffs`, `storage_diffs`) | Rust CLI | Excellent for Parquet dumps | N/A | Excellent for one-shot | OK | You want a ready-made oracle dataset, not a pipeline |
| 6 | **`geth snapshot dump`** | shell | N/A (no deltas) | N/A | N/A | Yes, baseline | Stage 2 baselines only |
| 7 | **Erigon MDBX direct read** | Go/Rust | Good, schema-fragile | Good | Good | Good | Need Erigon-specific perf; schema coupling acceptable |
| 8 | **Portal Network state sub-net** | TS | Blocked — clients pre-production (Apr 2026) | Blocked | Blocked | Blocked | State sub-net ever stabilises |
| 9 | **Fork geth** | Go | Works but unnecessary | Works but unnecessary | Unnecessary | Unnecessary | Never — live tracer subsumes |

The user chose path 1 (geth live tracer). Path 3 (ethereumjs/vm) is worth a genuine re-consideration because it keeps everything in the existing TypeScript workspace: the erae parser already exists, `@ethereumjs/vm` + `@ethereumjs/statemanager` can re-execute blocks, and a subclassed `StateManager` can emit equivalents of `OnBalanceChange` without any Go. For pre-Byzantium mainnet blocks (the 163 840 scope) the EVM surface is very stable and compatibility is low-risk. The geth path stays the recommendation for production correctness and forward compatibility with modern hardforks, but if the "add Go to the repo" cost is real, flag that discussion before committing.

---

## 8. Cross-Check and Oracle

Whatever extraction path we pick, we need a second opinion to validate. Cheapest options:

- **[`cryo balance_diffs`](https://github.com/paradigmxyz/cryo)** against a hosted archive RPC (Alchemy, QuickNode, Chainnodes). Produces Parquet dumps of per-block balance deltas for a block range. Run on a few spot ranges:
  - Blocks 0..1 000 (genesis-era edge cases)
  - Blocks 1 920 000..1 920 500 (DAO fork — confirms `BalanceIncreaseDaoContract` / `BalanceDecreaseDaoAccount` get emitted)
  - A dense block (e.g. 4 370 000) as a stress test
- **Etherscan address pages** — eyeball check for a handful of addresses we care about. Full transaction history + balance timeline.
- **`eth_getBalance` at a historical block** against an archive node — matches our reconstructed running balance at block N.

Run all three on the same blocks, diff, expect zero discrepancies.

---

## 9. Open Questions and TBDs

To be resolved at implementation time, flagged here so we don't silently assume:

- [ ] **erae → RLP chain file converter**: we need a small utility that reads `.erae` from [`packages/era/src/erae.ts`](../packages/era/src/erae.ts) and emits a concatenated RLP stream suitable for `geth import`. Not hard, not yet written.
- [ ] **Which genesis file exactly?** Geth historically shipped `genesis.json` for mainnet; confirm the current canonical path / how to generate it (`geth dumpgenesis` on a running mainnet node, probably, or grab from the go-ethereum repo).
- [ ] **Stamp / postage strategy** at Stage 1 scale (163 840 blocks × ~N balance events/block × 3 indexes). Not addressed here; follow the existing era package's stamp handling.
- [ ] **`@ethereumjs/vm` viability re-check.** Before committing to the Go path, a half-day spike: can we subclass `StateManager`, capture balance deltas, and produce the same NDJSON? If yes, the whole project stays in TypeScript.
- [ ] **Stage 2 proof layer.** Deferred, but without it snapshot consumers are trusting the uploader.

---

## 10. Recommended Path

1. **Stage 1.a — prove the tracer.** Write the ~200 LOC Go tracer, build with `geth-builder`, run against one erae (8 192 blocks ≈ first 46 days of mainnet). Validate NDJSON output against `cryo balance_diffs` for the same range. No Swarm yet.
2. **Stage 1.b — wire up upload.** Add a TS CLI entry alongside [`packages/era/src/upload.ts`](../packages/era/src/upload.ts) that reads `balance-events.ndjson` and builds the `byAddress` / `byBlock` / `meta` POT manifests via [`packages/era/src/swarm-pot.ts`](../packages/era/src/swarm-pot.ts). End-to-end round trip: pick one address from one block, fetch its events from Swarm, reconstruct running balance, compare to `eth_getBalance` on an archive node.
3. **Stage 1.c — scale to 20 eras.** Process one era per run, checkpoint, resume. Spot-check against `cryo` for three sampled ranges. Document throughput and index-size.
4. **Stage 2 — progressive diffs + sparse baselines.** Same tracer, extended to emit `storage-events.ndjson` + `code-events.ndjson`. Add `diff/<block>` upload (per-block delta chunks) and a `snapshot/<block>` baseline at genesis, optionally later ones. Reconstruction = baseline + forward diffs. This single architecture answers both "every address whose balance changed at block N" (via `byBlock`) and "store the full state on Swarm progressively, only uploading changes" (via `diff/<block>` + sparse baselines).

---

## 11. Primary Sources

Geth live tracing:
- [Live tracing overview](https://geth.ethereum.org/docs/developers/evm-tracing/live-tracing)
- [`core/tracing/hooks.go`](https://github.com/ethereum/go-ethereum/blob/master/core/tracing/hooks.go)
- [`core/tracing/CHANGELOG.md`](https://github.com/ethereum/go-ethereum/blob/master/core/tracing/CHANGELOG.md)
- [Marius Van Der Wijden — "The go-ethereum live tracer"](https://mariusvanderwijden.github.io/blog/2024/05/06/LiveTracer/)
- [`geth-builder` (s1na)](https://github.com/s1na/geth-builder)

Geth import paths:
- [`cmd/geth/chaincmd.go` — `importhistory` & `import` commands](https://github.com/ethereum/go-ethereum/blob/master/cmd/geth/chaincmd.go)
- [`cmd/utils/cmd.go` — `ImportHistory` (via `InsertReceiptChain`, skips EVM) vs `ImportChain` (via `InsertChain`, re-executes)](https://github.com/ethereum/go-ethereum/blob/master/cmd/utils/cmd.go)
- [`cmd/geth/snapshot.go` — snapshot subcommands](https://github.com/ethereum/go-ethereum/blob/master/cmd/geth/snapshot.go)
- [Geth archive / PBSS docs](https://geth.ethereum.org/docs/fundamentals/archive)

Alternatives:
- [Reth ExEx overview](https://reth.rs/exex/overview/) · [Paradigm ExEx announcement](https://www.paradigm.xyz/2024/05/reth-exex) · [`reth-exex-examples`](https://github.com/paradigmxyz/reth-exex-examples)
- [Paradigm `cryo`](https://github.com/paradigmxyz/cryo)
- [`@ethereumjs/vm` and StateManager](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/vm)

Prior art:
- [Viktor Tron — Trustless access to Ethereum State with Swarm (ethresear.ch)](https://ethresear.ch/t/trustless-access-to-ethereum-state-with-swarm/17350)
- [Portal Network state sub-network spec](https://github.com/ethereum/portal-network-specs/blob/master/legacy/state/state-network.md) · [Portal client status](https://ethportal.net/clients)
- [EF blog, Dec 2025 — The Future of Ethereum State](https://blog.ethereum.org/2025/12/16/future-of-state)
- [EIP-7708 (Draft) — ETH transfers as logs](https://eips.ethereum.org/EIPS/eip-7708) — if finalised, replaces tracer-based balance indexing for future-block work
