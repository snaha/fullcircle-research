# @fullcircle/pot

Pure-TypeScript port of the [Proximity Order Trie](https://github.com/ethersphere/proximity-order-trie), replacing the WASM-backed [potjs](https://github.com/brainiac-five/potjs) runtime. Same on-the-wire format — refs produced by either implementation are interchangeable.

## Why

`potjs` ships a ~2 MB WASM blob wrapping the Go POT. That adds a native-module load on Node and a network fetch on the browser, and makes debugging a black box. The algorithm is small enough to port directly, and doing so gets us:

- One language end-to-end; stack traces point at real TS source.
- No vendored `pot-node.js` + `pot.wasm`, no `createRequire` dance.
- Freedom to change serialisation, add new persisters, or extract sub-algorithms (e.g. for LSM-backed scale).

## Layout

- [src/elements/](src/elements/) — algorithm core: `MemNode`, `SwarmNode`, `SingleOrder` / `SwarmPot` modes, `Find` / `Update` / `Iterate`, the `Wedge` / `Whirl` / `Whack` ops.
- [src/persister/](src/persister/) — `LoadSaver` abstraction, `InmemLoadSaver` (SHA-256, tests), `BeeLoadSaver` (`/bytes` HTTP).
- [src/index.ts](src/index.ts) — `Index` (mutable POT with async write-mutex), public exports.
- [src/kvs.ts](src/kvs.ts), [src/swarm-entry.ts](src/swarm-entry.ts) — high-level `SwarmKvs` on top of `Index`.
- [src/compat.ts](src/compat.ts) — drop-in `globalThis.pot` shim matching the WASM surface.

## Key findings from the port

**1. JS signed modulo corrupts the bitmap for PO ≥ 8.**
The Go `SwarmNode.MarshalBinary` sets bits with `1 << ((7 - n) % 8)` where `n` is `uint8`, so the subtraction wraps into `[0, 255]` before the modulo. In JS `(7 - 12) % 8 === -5` and `1 << -5` shifts left by `27` — bits land in the wrong byte. Decoding uses the complementary `(i % 8)` form and happened to be right, so the bug only surfaced on save+reload with close-PO keys. Fix in [src/elements/swarm-node.ts](src/elements/swarm-node.ts) uses `1 << (7 - (n % 8))`. Regression: [test/close-po.integration.test.ts](test/close-po.integration.test.ts).

**2. `iterate()` needs a defensive `unpack` the Go version skips.**
Go's `iterate` recurses into `Slice` sibling forks without unpacking them. On in-memory trees that's fine (forks keep their `MemNode` after `Pack`); on trees freshly loaded from a reference, those siblings are packed and `Empty()` would panic. This port calls `mode.unpack` at the top of each recursion. No-op cost on `SingleOrder` / already-loaded nodes.

**3. Wire format: Bee's `/bytes`, not `/chunks`.**
Matches the Go `SwarmLoadSaver`. Bee handles chunk splitting internally and returns a 32-byte ref regardless of payload size, so the POT doesn't need a chunk-size policy. POST body = raw data, header `swarm-postage-batch-id`; expect HTTP 201 with `{"reference": "<64 hex>"}`.

**4. CJS loader shim for vendor WASM.**
The integration tests load the vendored WASM runtime via `createRequire` from ESM. Because `packages/era/package.json` is `"type": "module"`, Node applies ESM rules to `packages/era/vendor/pot/pot-node.js` even under `createRequire`. Adding a local [packages/era/vendor/pot/package.json](../era/vendor/pot/package.json) with `{"type": "commonjs"}` overrides it. Also fixes any latent breakage in era's tsx runtime path.

**5. Key/value coercion is exactly the Go `jsToKey` / `typeEncodedBytes`.**
Numbers → 8-byte BE IEEE-754, strings → UTF-8, `Uint8Array` ≤ 32 bytes; all right-padded with zeros to 32. Typed values (`put`/`get`) prepend a 1-byte tag: 0 null, 1 boolean, 2 number, 3 string, 4 bytes. Raw values (`putRaw`/`getRaw`) are stored verbatim. Byte-for-byte parity verified in [test/compat-parity.integration.test.ts](test/compat-parity.integration.test.ts).

**6. `new` in TS interfaces needs property syntax.**
`interface Foo { new(): Bar }` reads as a construct signature; `new: (...) => Bar` is the method. The WASM `pot.d.ts` already used the second form — I hit the first-form pitfall and copied the second.

**7. Empty-KVS save/load needs a WASM-specific sentinel.**
Go's `Index.Save` throws `root node is nil` when the pot has no entries. The WASM wrapper catches that and returns 32 zero bytes; on `load(ref)` with all-zeros it creates a fresh KVS instead of fetching. Era relies on this — era 0 has no transactions, so `byTx.save()` hits the empty case. The core [Index](src/index.ts) stays spec-faithful (throws); the translation lives on the [compat seam](src/compat.ts), matching `potjs.go _save` and `_load`.

## Status vs the WASM it replaces

Proven compatible, both directions, against a live Bee:

- TS writer → WASM reader ✓
- WASM writer → TS reader ✓
- Compat-layer writer → WASM reader ✓ (`putRaw(numericKey, refBytes)` + hex-ref `save()`)
- WASM writer → compat reader ✓
- All five typed-value shapes (null / bool / number / string / Uint8Array) round-trip ✓

Not yet covered:

- BMT hashing for `InmemLoadSaver` — uses SHA-256. Good enough for in-memory tests; irrelevant when `BeeLoadSaver` is the persister since Bee computes refs.
- In-memory mode for `pot.new()` / `pot.load()` (no `beeUrl` / `batchId`). Current compat requires both.
- Proof generation (`pkg/proof/` in the Go ref) — separate slice.
- `Index.Iterate` with prefix on reloaded trees: works in our tests, but the Go impl has latent gaps here that the test suite doesn't exercise. Worth re-auditing if we start using prefix iteration over persisted pots.

## Testing

```
pnpm test                    # offline: 45 tests
BEE_URL=http://127.0.0.1:1633 BEE_STAMP=<id> pnpm test   # + 9 integration tests
```

Integration tests auto-skip without env. Start a local stack with `pnpm bee:start && pnpm bee:stamp` from the repo root.

## API

```ts
import { Index, SingleOrder, SwarmKvs, BeeLoadSaver, createPotCompat } from '@fullcircle/pot'

// Low level
const idx = Index.create(new SingleOrder(256))
await idx.add({ key: () => k, ... })  // Entry interface

// High level
const ls = new BeeLoadSaver({ beeUrl, postageBatchId })
const kvs = SwarmKvs.create(ls)
await kvs.put(key32, value)
const ref = await kvs.save()                    // Uint8Array(32)
const reader = await SwarmKvs.fromReference(ls, ref)

// WASM-compat: drop-in for `globalThis.pot.new/load`
const pot = createPotCompat()
const k = await pot.new(beeUrl, batchIdHex)
await k.putRaw(42, refBytes)                     // number / string / Uint8Array keys
const refHex = await k.save()                    // hex string, matches WASM
```
