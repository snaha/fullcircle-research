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

# three root scripts — each takes the same arg
pnpm era:download                   # fetch default range (0..6) into data/
pnpm era:process 0..6               # parse cached files → .summary.json / .blocks.ndjson / .index.ndjson
pnpm era:download-and-process 7     # both, one pass
```

### Argument forms

Every script accepts the same single argument:

| form | meaning |
|---|---|
| *(omitted)* | eras 0..6 (default) |
| `42` | single era 42 |
| `0..99` | inclusive range of eras |
| `https://…/mainnet-NNNNN-….erae` | explicit file URL (bypasses the checksums lookup) |

Ranges process eras strictly in order, sequentially — no parallelism yet. That
means a range of 100 eras will download ~100 files one after another (each
~4 MiB; network is the dominant cost).

```bash
pnpm era:download 0..99                                                # 100 eras, sequential
pnpm era:process 0..99                                                 # reparse all cached
pnpm era:download-and-process 0..99                                    # fetch + process each

pnpm era:download-and-process \
  https://data.ethpandaops.io/erae/mainnet/mainnet-00000-a6860fef.erae # one file by URL
```

Era numbers are resolved via the public
[`checksums_sha256.txt`](https://data.ethpandaops.io/erae/mainnet/checksums_sha256.txt)
(cached in `data/` after first fetch). Downloaded `.erae` files are cached on
disk — rerunning `era:process` against an already-downloaded range reparses
locally without re-downloading. Override the output directory with
`FULLCIRCLE_DATA_DIR=…`.

### Outputs

Everything lands in [`data/`](./data/) (gitignored). Filenames follow the
upstream convention `mainnet-NNNNN-<short-hash>.<ext>`, where `NNNNN` is the
zero-padded era number and `<short-hash>` is the first 4 bytes of the era's
last-block hash (self-checking against the file's contents).

Per era you get four files:

| file | contents |
|---|---|
| `mainnet-NNNNN-<hash>.erae` | raw download from ethPandaOps |
| `mainnet-NNNNN-<hash>.summary.json` | one-object overview (see below) |
| `mainnet-NNNNN-<hash>.blocks.ndjson` | one JSON record per block (see below) |
| `mainnet-NNNNN-<hash>.index.ndjson` | interleaved `block` + `tx` lookup records (see below) |

All numeric fields that can exceed `Number.MAX_SAFE_INTEGER` (block numbers,
total difficulty) are serialised as **decimal strings** so they round-trip
through any JSON parser. All byte fields are lowercase `0x`-prefixed hex.

#### `…summary.json`

A single JSON object, pretty-printed. Useful as a cheap "what's in this
file?" probe without touching the big NDJSONs.

```json
{
  "sourceUrl":        "https://data.ethpandaops.io/erae/mainnet/mainnet-00007-fbd10bce.erae",
  "version":          "0x3265",
  "startingBlock":    "57344",
  "blockCount":       8192,
  "accumulatorRoot":  "0xd9bc682b…",
  "firstBlock":       { "number": "57344", "hash": "0x523f5beb…", "txCount": 0 },
  "lastBlock":        { "number": "65535", "hash": "0xfbd10bce…", "txCount": 0 },
  "totalTxs":         2676
}
```

| field | type | notes |
|---|---|---|
| `sourceUrl` | string | upstream URL the `.erae` was fetched from |
| `version` | hex string | erae format magic (`0x3265`) |
| `startingBlock` | decimal string | first block number, from the `BlockIndex` trailer |
| `blockCount` | number | always `8192` for complete eras |
| `accumulatorRoot` | `0x…` hex or `null` | HTR of HeaderRecords — pre-merge only, `null` post-merge |
| `firstBlock`, `lastBlock` | object | `{ number, hash, txCount }` for the bookends |
| `totalTxs` | number | sum of `txCount` across all 8192 blocks |

#### `…blocks.ndjson`

Newline-delimited JSON, 8192 lines per full era, one line per block in
block-number order. Each line is a standalone JSON object:

```jsonc
{
  "number":          "60343",                                 // decimal string
  "hash":            "0x60b9fec9…",                           // keccak256(rawHeader)
  "totalDifficulty": "65229745891189391",                     // decimal string or null (post-merge)
  "txHashes":        ["0xbc77efd4…"],                         // keccak256 per tx, block order
  "rawHeader":       "0xf90219a02…",                          // RLP-encoded header bytes
  "rawBody":         "0xf87cf879…",                           // RLP-encoded [txs, uncles, withdrawals?]
  "rawReceipts":     "0xe7e680a0…",                           // RLP-encoded slim receipts (erae variant)
  "proof":           null                                      // optional Portal Network proof
}
```

| field | type | notes |
|---|---|---|
| `number` | decimal string | block number |
| `hash` | `0x…` hex (32 bytes) | canonical block hash, equal to `keccak256(rawHeader)` |
| `totalDifficulty` | decimal string or `null` | cumulative PoW difficulty; `null` post-merge |
| `txHashes` | `string[]` | per-tx `keccak256` hashes in block order; `[]` for empty blocks |
| `rawHeader` | `0x…` hex | RLP-encoded header — the bytes that hash to `hash` |
| `rawBody` | `0x…` hex | RLP-encoded `[transactions, uncles, withdrawals?]` |
| `rawReceipts` | `0x…` hex | RLP-encoded *slim* receipts (no bloom filters — erae variant) |
| `proof` | `0x…` hex or `null` | optional Portal Network historical-proof blob |

The `raw*` fields are the exact decompressed record payloads from the erae
file, ready to feed into any RLP decoder (ethers, viem, ethereumjs) when
fully-typed blocks are needed. Keeping them raw avoids decoding 8192 full
blocks at parse time. Empty pre-tx blocks store minimal 3-byte bodies
(`0xc2c0c0` = RLP of `[[],[]]`) and 1-byte receipts (`0xc0` = RLP of `[]`).

#### `…index.ndjson`

Newline-delimited JSON with **two record kinds**, emitted in block-number
order. A block record is followed immediately by its transaction records:

```jsonc
{"kind":"block","number":"57344","hash":"0x523f5beb…"}
{"kind":"block","number":"57345","hash":"0xa20c9161…"}
{"kind":"block","number":"57346","hash":"0xa39508eb…"}
{"kind":"tx","hash":"0x54841944…","blockNumber":"57346","txIndex":0}
{"kind":"tx","hash":"0x704b14c2…","blockNumber":"57346","txIndex":1}
```

Block record:

| field | type | notes |
|---|---|---|
| `kind` | `"block"` | record-type discriminator |
| `number` | decimal string | block number |
| `hash` | `0x…` hex | block hash |

Transaction record:

| field | type | notes |
|---|---|---|
| `kind` | `"tx"` | record-type discriminator |
| `hash` | `0x…` hex | transaction hash |
| `blockNumber` | decimal string | block this tx is in |
| `txIndex` | number | 0-based position within the block |

Total record count per full era: `8192 + totalTxs`. A consumer scans the
file once to build `byNumber` / `byBlockHash` / `byTxHash` lookup maps
(`byBlockHash` is trivially the inverse of `byNumber` — that's why it
isn't stored). The shape is append-friendly on purpose — when an RPC tail
(or any later-arriving data) needs to be stitched on, it's a single
`fs.appendFile` per new block + tx, with no file rewrite.

### Ballpark sizes (per era)

| artefact | pre-tx eras (0–4) | early-tx eras (5–6) |
|---|---|---|
| `.erae` | ~3.7 MiB | ~4.0–4.4 MiB |
| `.blocks.ndjson` | ~11 MiB | ~11.3–12.5 MiB |
| `.index.ndjson` | ~880 KiB | ~1.0–1.3 MiB |

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

## Local Bee node

A local single-node Swarm setup (queen only) via
[`@fairdatasociety/fdp-play`](https://www.npmjs.com/package/@fairdatasociety/fdp-play).
Requires Docker.

```bash
pnpm bee:start          # queen only, foreground (streams logs)
pnpm bee:start:detach   # same, background
pnpm bee:stop           # stop node
pnpm bee:logs           # follow queen logs
pnpm bee:fresh          # clean start: purge data + pull latest images
```

Endpoints: queen API at `http://localhost:1633`, local blockchain RPC at
`http://localhost:9545`.

## Scripts

- `pnpm run typecheck` — `tsc -b`
- `pnpm run build` — `tsc -b`
- `pnpm era:download [range|url]` — fetch only
- `pnpm era:process [range|url]` — parse cached files only
- `pnpm era:download-and-process [range|url]` — both
- `pnpm bee:start` / `bee:stop` / `bee:logs` / `bee:fresh` — local Bee node
- `pnpm lint` / `pnpm format` / `pnpm knip` / `pnpm check:all` — run tooling
  across every package that defines the matching script

## Linting & formatting

Each package under `packages/` has its own `.prettierrc` (where needed),
`eslint.config.mjs`, and `knip.ts`, and exposes a uniform script surface:

- `pnpm lint` — `prettier --check` + `eslint`
- `pnpm format` — `prettier --write` + `eslint --fix`
- `pnpm knip` — dead-code / unused-dep scan
- `pnpm check` — type-check (package-specific: `tsc --noEmit` or `svelte-check`)
- `pnpm check:all` — `lint` + `check` + `knip`

Run `pnpm check:all` at the repo root to run all of the above across every
package in one go. Root `.prettierrc` / `.prettierignore` serve as baseline
fallbacks for any package that doesn't override them locally.

## Dependencies

- [`@ethereumjs/rlp`](https://www.npmjs.com/package/@ethereumjs/rlp) — RLP codec
- [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes) — keccak256
- [`snappyjs`](https://www.npmjs.com/package/snappyjs) — raw snappy decode (framing implemented inline)
