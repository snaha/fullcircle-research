# @fullcircle/rpc

A minimal Ethereum JSON-RPC 2.0 server that replays mainnet history from the
repo's [`data/`](../../data) directory. Stands in for Swarm while the project
is still a PoC — every endpoint that's mocked today is mocked against a
**real** erae file, not fake data.

```bash
pnpm rpc:start            # listens on http://127.0.0.1:8545
FULLCIRCLE_RPC_PORT=9000 pnpm rpc:start
FULLCIRCLE_DATA_DIR=/tmp/eras pnpm rpc:start
```

## Supported methods

| Method                                    | Notes                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `eth_blockNumber`                         | Highest block across all loaded eras.                                              |
| `eth_chainId`                             | Hardcoded to `0x1` (mainnet). Configurable once we support other chains.           |
| `net_version`                             | `"1"`. Kept in sync with `eth_chainId`.                                           |
| `web3_clientVersion`                      | `"fullcircle-rpc/0.0.1"`.                                                         |
| `eth_syncing`                             | Always `false` — we only ever serve archived history.                              |
| `eth_getBlockByNumber`                    | `earliest`/`latest`/`pending`/`safe`/`finalized` all map to bounds of loaded data. `fullTx=true` is **not** supported yet — request with `false` to get tx hashes. |
| `eth_getBlockByHash`                      | Same `fullTx` restriction as by-number.                                            |
| `eth_getBlockTransactionCountByNumber`    |                                                                                    |
| `eth_getBlockTransactionCountByHash`      |                                                                                    |
| `eth_getUncleCountByBlockNumber`          | Counts `body[1]` (ommers list). Works across all pre-merge eras.                   |
| `eth_getUncleCountByBlockHash`            |                                                                                    |

## Easy to add next (data is already on disk)

These need only decode bytes that erae files already carry — `rawBody`,
`rawReceipts`, and the in-memory `byTxHash` map.

| Method                                               | Effort | Needs                                                                            |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `eth_getTransactionByHash`                           | M      | Decode `rawBody` at the index from `byTxHash`. Needs full tx-envelope decoding (legacy + EIP-2718 types 0x01/0x02/0x03/0x04). |
| `eth_getTransactionByBlockHashAndIndex`              | M      | Same decoder, different lookup.                                                  |
| `eth_getTransactionByBlockNumberAndIndex`            | M      | Same.                                                                            |
| `eth_getUncleByBlockHashAndIndex`                    | M      | Decode the i-th ommer header like any other header.                              |
| `eth_getUncleByBlockNumberAndIndex`                  | M      | Same.                                                                            |
| `eth_getBlockByNumber` with `fullTx=true`            | M      | Requires the tx decoder above; straightforward once it exists.                   |
| `eth_getBlockReceipts` / `eth_getTransactionReceipt` | M–L    | `rawReceipts` is the **slim** form used by erae (logsBloom stripped and must be recomputed from logs). |
| `eth_getLogs` (historic, bounded ranges)             | L      | Needs receipts decoded above + a bloom filter per block. No live filters (`eth_newFilter`) since data is static. |
| `eth_feeHistory`                                     | M      | Headers already carry `baseFeePerGas` and `gasUsed`/`gasLimit`; just aggregate.  |

## Not implementable from erae alone

These require the **state trie**, which erae files deliberately do not carry.
They belong to a future `@fullcircle/state` layer that would fetch state from
Swarm (or Portal, or a state proof).

- `eth_getBalance`
- `eth_getCode`
- `eth_getStorageAt`
- `eth_getTransactionCount` (account nonce — note: different from the already-supported `eth_getBlockTransactionCount*`)
- `eth_call`
- `eth_estimateGas`
- `eth_getProof`
- `eth_createAccessList`
- `debug_traceTransaction` / `debug_traceCall` and friends (need full execution + state)

Anything mempool- or consensus-related (`eth_sendRawTransaction`,
`eth_newPendingTransactionFilter`, `eth_maxPriorityFeePerGas` as a live quote,
`eth_subscribe`) is also out of scope — this server only serves history.

## Environment variables

| Variable                  | Default                       | Purpose                              |
| ------------------------- | ----------------------------- | ------------------------------------ |
| `FULLCIRCLE_DATA_DIR`     | `<repo>/data`                 | Where to load `*.summary.json` etc. |
| `FULLCIRCLE_RPC_HOST`     | `127.0.0.1`                   | Bind host.                           |
| `FULLCIRCLE_RPC_PORT`     | `8545`                        | Bind port.                           |
