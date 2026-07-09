# Storing Ethereum Blockchain Data on Swarm — Approaches & Feasibility Summary

_A summary of the approaches researched and built in the FullCircle project, intended as
input for Business Development evaluation and a subsequent full feasibility study. Each
section links to the underlying research document for drill-down._

---

## 1. Executive summary

Ethereum is deleting its own history. EIP-4444 (history expiry) is now live across all
major execution clients: nodes may drop ~300–500 GB of pre-merge block data, and rolling
expiry of newer data is planned. The chain keeps working, but anyone who needs historical
blocks, transactions, or balances — explorers, wallets, auditors, indexers, researchers —
must get them from somewhere else. Today that "somewhere else" is a handful of centralized
providers.

**Swarm is a natural home for this data.** It is content-addressed (data is identified by
its hash, so it is self-verifying), economically incentivized (storage is paid for with
BZZ postage stamps, so persistence is a funded guarantee rather than a volunteer effort),
and erasure-coded for durability. Ethereum's own attempt at an answer, the Portal
Network, has not reached production — as of 2026 it is not a live network — which leaves
the persistence gap open and strengthens the case for a funded, guaranteed alternative
(see [RESEARCH.md §4](./RESEARCH.md)).

**Status:** FullCircle has a working end-to-end proof of concept. Standardized era archive
files are downloaded, parsed into per-block bundles, uploaded to Swarm, and served through
a web block explorer with lookups by block number, block hash, transaction hash, and
address — backed by **three interchangeable index implementations built and running in
parallel** (Mantaray manifests, Proximity Order Trie, SQLite-on-Swarm). A state-history
extractor re-executes early mainnet blocks and reproduces balance histories verified to
the wei. The remaining questions for a production system are scale engineering,
cryptographic verification, and funding — all mapped, none showstoppers (§5).

---

## 2. What has been built

The proof of concept (pnpm workspace, TypeScript) covers the full pipeline
(see [PIPELINE.md](./PIPELINE.md)):

1. **Download** — fetch `.erae` era archive files (8,192 blocks each; ~4 MiB for the
   earliest, transaction-free eras, growing to ~700–1,000 MB for recent ones) from public
   endpoints.
2. **Process** — parse E2Store framing, decompress, RLP-decode blocks and transactions.
3. **Upload** — store each block as a compact bundle (header ‖ body ‖ receipts ‖ total
   difficulty) on Swarm, then build lookup indexes over the bundles. An upload proxy
   (`@fullcircle/proxy`) adds deduplication and retry so uploads survive flaky nodes.
4. **Browse** — a SvelteKit explorer (`@fullcircle/explorer`) reads everything back from
   Swarm in the browser: blocks, transactions, address balance history. A runtime
   selector switches between the three index backends, so they are directly comparable
   on the same data.

State history is covered by a separate extractor
([STATE.md §11](./STATE.md)): it re-executes the first 65,536 mainnet blocks with
`@ethereumjs/vm` in ~85 seconds, emitting 152,769 balance-change events, spot-checked to
the wei against block 46,147 (the first-ever ETH transfer).

All status labels below are honest: **Built** means code in this repo runs end-to-end;
**Prototyped** means partial code; **Researched** means design and analysis only.

---

## 3. Storage & indexing approaches

Two layers matter: how the _data_ is stored (bundles, era files, diffs) and how it is
_found_ (the index mapping a key like a tx hash to a Swarm reference). The three built
indexes share the same stored data and differ only in the lookup layer.

### 3.1 Era archive files as blobs — **Built**

Store the standardized era files themselves (8,192 blocks, self-verifying via an embedded
accumulator root, already compressed) as opaque objects on Swarm.

- **Strengths:** simplest possible model; files are immutable and verify themselves;
  directly consumable by node software (`geth import-history`) for bulk history recovery.
- **Limitations:** no random access — answering "give me transaction X" means downloading
  and scanning a whole era. Right for archival/bulk sync, wrong for interactive use.
- **Role:** the foundation layer; every approach below builds on data extracted from
  these files.

### 3.2 Block bundles + Mantaray manifest index — **Built** (default)

Swarm's native filesystem-like manifest format. Keys become paths
(`number/123`, `hash/0x…`, `tx/0x…`, `address/0x…`), and the Bee node resolves them
server-side: a lookup is a single HTTP request, and the client needs no index logic at
all. Implementation: `packages/era/src/swarm.ts` + a custom streaming manifest builder
(`packages/mantaray-stream/`).

- **Strengths:** thinnest possible client (plain HTTP); most mature and documented path;
  content-address dedup means the three block indexes share one stored copy of each block.
- **Limitations:** the current in-memory build process ceilings at roughly 10⁷ index
  entries ([SCALE.md](./SCALE.md)); mainnet needs ~3.55 billion. The scaling path
  (disk-backed key store, streaming emission, split indexes) is designed but not built.

### 3.3 Block bundles + Proximity Order Trie (POT) index — **Built**

A pure-TypeScript port of Swarm's native key-value trie (`packages/pot/`), byte-compatible
with the Go/WASM reference implementation. Five independent key-value stores (by number,
hash, tx, address, balance-block), each addressed by a single 32-byte root reference.

- **Strengths:** Swarm-native data structure aligned with the network's addressing model;
  the most rigorously correctness-validated of the three (bidirectional compatibility
  proven against the reference implementation, 50+ tests, several upstream bugs found and
  fixed during the port — see [packages/pot/README.md](../packages/pot/README.md)).
- **Limitations:** lookups run client-side (browser loads the trie logic); keys are capped
  at 32 bytes, forcing one store per key type; no iteration over stored keys.

### 3.4 Block bundles + SQLite-on-Swarm index — **Built** (newest)

A real SQLite database whose 4 KB pages match Swarm's 4 KB chunks exactly. The database is
uploaded as a content-addressed page tree; the browser queries it lazily via
`sql.js-httpvfs`, fetching only the pages a query touches. Implementation:
`packages/era/src/swarm-sqlite.ts`.

- **Strengths:** full SQL over the index (range queries, joins, future analytics) — the
  other two only do exact-key lookup; build-side it is an ordinary database, which is
  exactly the disk-backed, streaming-friendly direction [SCALE.md](./SCALE.md) recommends
  for mainnet scale.
- **Limitations:** newest and least battle-tested of the three; client needs a WASM SQLite
  runtime; the database must be re-published (or paged incrementally) as data grows.

### 3.5 Real-time archival via Swarm feeds — **Researched**

A daemon follows the chain head, uploads each new block, and updates a Swarm _feed_ (a
mutable pointer) to "latest block", giving live dashboards and a continuously growing
archive rather than a static snapshot ([PROPOSAL.md](./PROPOSAL.md), Option B).

- **Strengths:** turns the archive from a snapshot into a living service; small,
  well-understood engineering effort on top of what is built.
- **Limitations:** needs an always-on operator with an Ethereum RPC and ongoing stamp
  budget.

### 3.6 Geth freezer backend on Swarm — **Researched**

Implement Geth's `AncientStore` interface over Swarm so an Ethereum node reads its
historical data directly from the network instead of local disk
([PROPOSAL.md](./PROPOSAL.md), Option C).

- **Strengths:** deepest possible integration — nodes transparently outsource history.
- **Limitations:** requires Go development against Geth internals and acceptable retrieval
  latency; highest-effort, highest-payoff option. A candidate for the feasibility study,
  not the PoC.

### 3.7 State on Swarm — **Prototyped → Researched** (staged)

Historical _state_ (balances, contracts, storage) is a separate, harder problem than
history, tackled in stages ([STATE.md](./STATE.md)):

- **Stage 1 — balance-event stream: Built (extractor).** Re-execute blocks, emit every
  balance change as an event keyed by address. The extractor is shipped and verified
  (§2); uploading the event index to Swarm is the next step.
- **Stage 2 — progressive state diffs + sparse baselines: Researched.** Store per-block
  state deltas plus occasional full snapshots; state at any block = nearest baseline +
  replayed diffs. Upload cost tracks what actually changed — the right shape for Swarm.
- **Stage 3 — trustless state access with Merkle proofs: Researched.** Viktor Tron's
  proposal for Swarm as a verifiable state cache. Blocked on the hash-function mismatch
  (§4.2); long-term direction, out of current scope.

### Comparison

| Approach                    | Status                  | Lookup model                    | Client complexity     | Scale outlook                              | Best for                                  |
| --------------------------- | ----------------------- | ------------------------------- | --------------------- | ------------------------------------------ | ----------------------------------------- |
| 3.1 Era files as blobs      | **Built**               | none (whole-file)               | trivial               | unlimited                                  | bulk archival, node re-sync               |
| 3.2 Mantaray index          | **Built**               | server-side path (1 HTTP call)  | none                  | ~10⁷ entries now; LSM redesign for mainnet | simplest consumers, default explorer path |
| 3.3 POT index               | **Built**               | client-side trie walk           | trie logic in browser | comparable; Swarm-native                   | Swarm-aligned key-value lookup            |
| 3.4 SQLite index            | **Built**               | client-side SQL over lazy pages | WASM SQLite           | best aligned with mainnet plan             | rich queries, analytics, scaling path     |
| 3.5 Feed-based live archive | Researched              | feed pointer + any index        | low                   | follows chain (~7,200 blocks/day)          | live tail, dashboards                     |
| 3.6 Geth freezer backend    | Researched              | node-internal                   | none (inside geth)    | full history                               | client integration                        |
| 3.7 State on Swarm          | Prototyped / Researched | address- and block-keyed        | varies by stage       | staged                                     | balance history → full state              |

The three built indexes are deliberately maintained as parallel experiments, switchable at
runtime in the explorer. No quantitative head-to-head benchmark exists yet — that is a
named work item for the feasibility study (§5).

---

## 4. Feasibility factors

### 4.1 Scale — [SCALE.md](./SCALE.md)

Full mainnet is ~25 million blocks and ~3.5 billion transactions ≈ 3.55 billion index
entries. The PoC's in-memory index build is a dead end past ~10⁷ entries; the required
architecture is known: a disk-backed (LSM/SQLite) source of truth with the Swarm index
emitted as a stream, indexes split per key type (transactions are ~99% of entries —
splitting alone buys 10–100×), and multi-node upload orchestration. Precedent that this
scale works on decentralized storage: Triton One's "Old Faithful" archives Solana's full
~250 TB ledger on Filecoin/IPFS. Ethereum's pre-merge history is far smaller (300–500 GB).

### 4.2 Verification — [VALIDATION.md](./VALIDATION.md)

The structural challenge: Swarm addresses data by BMT hash, Ethereum by Keccak256, so a
Swarm address does not natively prove Ethereum authenticity. Working today: era files'
embedded accumulator roots make bulk history self-verifying. Six strengthening options are
mapped, from single-owner-chunk Keccak addressing (needs Bee protocol work) through
CCIP-Read on-chain verification to ZK proofs (long-horizon R&D). Verification depth is a
dial, not a blocker: bulk data verifies today; per-item trustlessness is roadmap.

### 4.3 Economics — verified May 2026 ([detailed calculations](https://claude.ai/share/265b7a2d-0e04-49dd-89a3-b77f9e782642))

A detailed business-prospect analysis re-derived the cost model from verified inputs
(CoinGecko BZZ price ≈ $0.10, official bee-js storage pricing of ~0.021 xBZZ/day/GB at
1 TB scale, real era file sizes of 700 MB–1 GB for recent eras). Key corrected numbers —
these supersede the older ~$10–50/TB/year estimate in
[INCENTIVIZATION.md](./INCENTIVIZATION.md), which is roughly 30× too low at current
network prices:

| Metric                                          | Value             |
| ----------------------------------------------- | ----------------- |
| Total archive size (erae, genesis → block ~25M) | ~1.24 TB          |
| New data per month                              | ~20 GB (~26 eras) |
| Swarm postage, full archive                     | ~$950/year        |
| Infrastructure (Ethereum node + Bee + ops)      | $150–300/month    |
| Total operating cost                            | $235–380/month    |
| Endowment for perpetual archive (4% yield)      | ~$25,000          |

Costs are infrastructure-dominated, not storage-dominated, and the endowment target sits
comfortably inside a single Ethereum Foundation ESP grant ($10K–100K range). The demand
side: EIP-4444 pushes explorers, analytics platforms, and L2s off free P2P history and
into paid archive access — the most expensive tier at every RPC provider (archive add-ons
run $250–5,000/month at incumbents). The modeled offering is tiered subscriptions (Seed
$20 / Protocol $75 / Archive $300 / Infrastructure $1,000 per month), with 10% of revenue
flowing into an on-chain endowment. **Break-even is 7–12 customers**; the recommended
go-to-market lead is the Archive tier, whose buyers are the ones EIP-4444 just put under
pressure. Ten funding models for the public-good side are analyzed in
[INCENTIVIZATION.md](./INCENTIVIZATION.md) (grants, protocol fees, Data DAO, …), with a
phased recommendation: grants/sponsors to bootstrap, then endowment + subscription
revenue, then DAO governance. The headline for BD: **operating costs are a few hundred
dollars a month, the perpetual archive is a ~$25K endowment (one grant), and the paying
customers already exist — they are today's archive-RPC subscribers.**

### 4.4 Positioning

The Portal Network was designed as Ethereum's own history-distribution answer — free,
altruistic, best-effort retrieval with deep client integration — but it has not shipped:
as of 2026 it is not a live network, and its clients remain pre-production. That leaves
no funded, operational decentralized home for expired history. Swarm's incentivized,
guaranteed persistence fills exactly that gap today; if Portal eventually launches, the
two remain complementary (Swarm as the funded persistence layer of record, Portal as a
free distribution channel)
([RESEARCH.md §4](./RESEARCH.md), [INCENTIVIZATION.md](./INCENTIVIZATION.md)).

---

## 5. Recommendation & next steps toward the feasibility study

**Promotable today:** a working, browsable Ethereum history archive on Swarm with three
independent index implementations, a verified state-history extractor, and a costed,
credible sustainability story. This is a demo BD can show, not a slideware concept.

**For the feasibility study:**

1. **Benchmark the three indexes head-to-head** (lookup latency, upload cost, index size)
   on identical era ranges — the data exists; the numbers do not yet.
2. **Validate the mainnet scaling design** from [SCALE.md](./SCALE.md) with a pilot at
   ~10⁷–10⁸ entries using the SQLite/LSM-backed build path.
3. **Pick the verification target** (era-accumulator-only vs SOC/CCIP-Read) with Swarm
   core team input, since the stronger options need protocol work.
4. **Fund the endowment** — the sizing is done (~$25K for the full archive, §4.3); the
   next step is an EF ESP grant application, and updating
   [INCENTIVIZATION.md](./INCENTIVIZATION.md)'s stale $10–50/TB/year figure to the
   verified network pricing.
5. **Decide the live-tail question** (§3.5): a static archive is preservation; a feed-fed
   archive is a product.
