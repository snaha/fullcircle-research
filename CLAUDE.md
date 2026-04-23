# CLAUDE.md

## Project Overview

**FullCircle** is a research project investigating how to store Ethereum blockchain data on Swarm decentralized storage, making it accessible to everyone.

Project issue: https://github.com/ethersphere/swarm-accelerator/issues/5

## Documents

- **[docs/RESEARCH.md](./docs/RESEARCH.md)** -- Technical research: Ethereum data structures, Swarm storage primitives, EIP-4444 history expiry, Portal Network, Era1 file format, prior art, and technical challenges
- **[docs/PROPOSAL.md](./docs/PROPOSAL.md)** -- Implementation proposal: TypeScript tooling, architecture options, and day-by-day PoC plan
- **[docs/INCENTIVIZATION.md](./docs/INCENTIVIZATION.md)** -- Sustainability research: funding models, endowment design, Data DAO structure, and hybrid approaches for perpetual storage
- **[docs/SCALE.md](./docs/SCALE.md)** -- PoC vs mainnet: scale ceiling of the current in-memory Mantaray design and the LSM-backed architecture needed for the full archive (25M blocks / 3.5B txs)
- **[README.md](./README.md)** -- How to run the erae-processing tooling

## Context

EIP-4444 (history expiry) is now live across all Ethereum clients. Nodes are actively dropping pre-merge history (~300-500 GB), creating urgent demand for decentralized alternatives to preserve and serve this data. Swarm is a natural fit due to its content-addressed chunk model, economic incentives, and erasure coding.

## Code Layout

pnpm workspace. Single package today; UI / other packages slot in under
`packages/` when needed.

- [packages/era/](./packages/era/) -- `@fullcircle/era`
  - [src/erae.ts](./packages/era/src/erae.ts) -- three pure functions for the erae archive format: `fetchEraeFile`, `parseEraeFile`, `buildEraeIndex`. Handles E2Store framing, snappy-framed decompression, RLP-decoded block hashes + tx hashes (legacy and EIP-2718 typed).
  - [src/cli-shared.ts](./packages/era/src/cli-shared.ts) -- shared CLI helpers: data-dir resolution, target resolution (era range / URL), download, parse-and-write.
  - [src/download.ts](./packages/era/src/download.ts) -- entry: fetch erae file(s) into [data/](./data/).
  - [src/process.ts](./packages/era/src/process.ts) -- entry: parse cached erae file(s), write `.summary.json` / `.blocks.ndjson` / `.index.ndjson`.
  - [src/download-and-process.ts](./packages/era/src/download-and-process.ts) -- entry: both, in one pass.
- [packages/proxy/](./packages/proxy/) -- `@fullcircle/proxy` — TypeScript forward HTTP proxy that sits between uploaders and any Bee node (local queen, remote self-hosted — point `--bee-url http://localhost:1733`). Not a dev-only tool: the primary value is **upload dedup** — `POST /bytes | /chunks | /bzz` responses are cached in SQLite keyed by `(sha256(body), batch_id, path)`, so repeat uploads short-circuit without a round-trip. Useful in production for POT `save()` re-uploading unchanged nodes, resumed era runs, retries. Also logs every request (method / path / status / latency / byte counts / postage batch id + running tally). Plain HTTP upstream only.
  - [src/bin.ts](./packages/proxy/src/bin.ts) -- CLI entry: `--listen`, `--upstream`, `--cache-db` (default `data/proxy-cache.db`, `off` disables caching).
  - [src/proxy.ts](./packages/proxy/src/proxy.ts) -- server: streams non-cacheable requests; buffers + dedups uploads through the cache.
  - [src/cache.ts](./packages/proxy/src/cache.ts) -- SQLite store using built-in `node:sqlite` (no native-module compile; Node 22+). Only stores 2xx responses.
- [data/](./data/) -- gitignored. Cached `.erae` downloads plus per-era output: `.summary.json`, `.blocks.ndjson` (full blocks as hex), `.index.ndjson` (interleaved `block` / `tx` records — scan to build number↔hash and txHash→location maps; append-friendly for an RPC tail). Also holds `proxy-cache.db` when the dev proxy runs.

Package manager: **pnpm** (not npm). Root scripts:
- `pnpm era:download [range|url]` -- download only
- `pnpm era:process [range|url]` -- parse cached files only
- `pnpm era:download-and-process [range|url]` -- both
- `pnpm bee:start` -- boot the local Bee stack (geth dev chain + queen) via [`docker/compose.yml`](./docker/compose.yml); queen API on `:1633`, chain RPC on `:9545`. Also `bee:start:workers` (4 workers behind a profile), `bee:stop`, `bee:logs`, `bee:fresh`, `bee:stamp`.
- `pnpm proxy:start` / `proxy:dev` -- run `@fullcircle/proxy` in front of any Bee (default upstream `127.0.0.1:1633`; override via `-- --upstream HOST:PORT`). Uploaders opt in by pointing at `http://localhost:1733` instead of `:1633`.
- `pnpm lint` / `pnpm format` / `pnpm knip` / `pnpm check:all` -- forward via `pnpm -r --if-present` to every package that defines the matching script.

## Tooling (prettier, eslint, knip)

Each package owns its own configs (`.prettierrc` where needed, `.prettierignore`, `eslint.config.mjs`, `knip.ts`) and exposes a uniform script surface: `lint`, `format`, `knip`, `check`, `check:all`. Root `.prettierrc` / `.prettierignore` act as baseline fallbacks for packages that don't need overrides.

- `pnpm check:all` at root = lint + typecheck + knip across every package
- Per-package: `pnpm --filter <pkg> check:all` (or `cd packages/<pkg> && pnpm check:all`)
- `format` runs prettier + `eslint --fix`; `lint` is check-only

## Key Research Areas

- **Ethereum data formats**: Blocks, state tries, RLP/SSZ encoding, Era1/erae archive format
- **Swarm primitives**: 4KB chunks, BMT hashing, feeds, Mantaray manifests, postage stamps
- **Prior proposals**: Viktor Tron's state-on-Swarm, Swarm Data Chain, trustless state access
- **Comparison**: Portal Network (altruistic, Ethereum-specific) vs Swarm (incentivized, general-purpose)
- **Challenges**: Data scale (~1 TB+), hash function mismatch (BMT vs Keccak256), retrieval latency, persistence economics
- **Incentivization**: Endowment models, public goods funding, Data DAOs, hybrid funding approaches for perpetual storage

## Related Repos in Workspace

- `../bee-js/` -- Swarm JavaScript SDK (TypeScript, `@ethersphere/bee-js`)
- `../bee/` -- Swarm Bee node (Go)
- `../bee-docs/` -- Swarm documentation (Docusaurus)
