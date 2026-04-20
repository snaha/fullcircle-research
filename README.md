# FullCircle

Research + tooling for storing Ethereum execution-layer history on [Swarm](https://www.ethswarm.org/). Background:
[swarm-accelerator#5](https://github.com/ethersphere/swarm-accelerator/issues/5).

Research documents live in [docs/](./docs):
[RESEARCH](./docs/RESEARCH.md) · [PROPOSAL](./docs/PROPOSAL.md) · [INCENTIVIZATION](./docs/INCENTIVIZATION.md).

## Layout

pnpm workspace. All current code lives in a single package; UI / other
packages will be added alongside when needed.

```
packages/
  era/                           @fullcircle/era — erae parser + CLI
    src/erae.ts                  library: fetchEraeFile, parseEraeFile, buildEraeIndex
    src/download.ts              CLI entry: fetch erae file(s) to data/
    src/process.ts               CLI entry: parse cached erae file(s) → JSON artefacts
    src/download-and-process.ts  CLI entry: both in one pass
    src/cli-shared.ts            shared helpers (targets, writers, range parsing)
docs/              research (RESEARCH, PROPOSAL, INCENTIVIZATION)
data/              gitignored artefact cache (downloads + processed output)
```

## What's here

A TypeScript library + CLI for turning [ethPandaOps erae archives](https://ethpandaops.io/data/history/?history-format=erae&history-erae-network=mainnet)
into parsed Ethereum blocks and lookup indexes.

The erae format packages 8,192 blocks per file using
[E2Store framing](https://github.com/eth-clients/e2store-format-specs/blob/main/formats/era1.md)
with snappy-framed RLP payloads. Compared to era1 it also carries slim receipts
and optional Portal Network proofs ([spec](https://hackmd.io/pIZlxnitSciV5wUgW6W20w)).

## Library

[`packages/era/src/erae.ts`](./packages/era/src/erae.ts) exposes
three pure functions:

| function | signature | notes |
|---|---|---|
| `fetchEraeFile` | `(url, init?) => Promise<Uint8Array>` | Plain `fetch` wrapper; throws on non-2xx. |
| `parseEraeFile` | `(bytes) => EraeFile` | Reads records, decompresses snappy-framed header/body/receipts, computes block hashes and tx hashes (legacy + EIP-2718). |
| `buildEraeIndex` | `(file) => EraeIndex` | Builds `byNumber`, `byBlockHash`, `byTxHash` lookup maps. |

Each `EraeBlock` keeps its raw RLP bytes (header/body/receipts) alongside the
decoded number, block hash, per-tx hashes, and (pre-merge only) total difficulty.

Importable as `@fullcircle/era` from sibling workspace packages.

## CLI

```bash
pnpm install

# three root scripts — each takes the same arg (range, era number, or URL)
pnpm era:download                   # fetch eras 0..6 into data/
pnpm era:process 0..6               # parse cached files → .summary.json / .blocks.ndjson / .index.json
pnpm era:download-and-process 7     # both, one pass

pnpm era:download 42                # single era
pnpm era:download 0..99             # range
pnpm era:download https://data.ethpandaops.io/erae/mainnet/mainnet-00000-a6860fef.erae
```

Era numbers are resolved via the public
[`checksums_sha256.txt`](https://data.ethpandaops.io/erae/mainnet/checksums_sha256.txt)
(cached in `data/` after first fetch). Downloaded `.erae` files are cached on
disk — rerunning reparses locally without re-downloading. Override the output
directory with `FULLCIRCLE_DATA_DIR=…`.

### Outputs

Everything lands in [`data/`](./data/) (gitignored). Per era:

| file | contents |
|---|---|
| `mainnet-NNNNN-<hash>.erae` | raw download |
| `…summary.json` | version, block range, accumulator root, first/last block, tx total |
| `…blocks.ndjson` | one JSON line per block: `number`, `hash`, `totalDifficulty`, `txHashes`, `rawHeader`, `rawBody`, `rawReceipts`, `proof` (bytes as `0x…` hex) |
| `…index.json` | `numberToHash`, `hashToNumber`, `txHashToLoc` (→ `[blockNumber, txIndex]`) |

### Ballpark sizes (per era)

| artefact | pre-tx eras (0–4) | early-tx eras (5–6) |
|---|---|---|
| `.erae` | ~3.7 MiB | ~4.0–4.4 MiB |
| `.blocks.ndjson` | ~11 MiB | ~11.3–12.5 MiB |
| `.index.json` | ~1.2 MiB | ~1.3–1.6 MiB |

Eras 0–4 contain zero transactions: the first mainnet transaction was block
46,147 (in era 5). That's a real chain property, not a parser bug.

## Format notes learned the hard way

vs. the [erae spec page](https://hackmd.io/pIZlxnitSciV5wUgW6W20w):

- Records are **grouped by type** (all `CompressedHeader`s, then all
  `CompressedBody`s, …), not interleaved per block the way the spec reads.
  The `BlockIndex` trailer ties them back together.
- `BlockIndex` type ID in the on-disk bytes is `0x3267`, not `0x6732` as the
  hackmd doc reads. Trust the file.
- Payloads are snappy **framed** (stream identifier + chunked with CRC32C),
  not raw snappy. A small framed decoder is inlined in `erae.ts`.

## Scripts

- `pnpm run typecheck` — `tsc -b`
- `pnpm run build` — `tsc -b`
- `pnpm era:download [range|url]` — fetch only
- `pnpm era:process [range|url]` — parse cached files only
- `pnpm era:download-and-process [range|url]` — both

## Dependencies

- [`@ethereumjs/rlp`](https://www.npmjs.com/package/@ethereumjs/rlp) — RLP codec
- [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes) — keccak256
- [`snappyjs`](https://www.npmjs.com/package/snappyjs) — raw snappy decode (framing implemented inline)
