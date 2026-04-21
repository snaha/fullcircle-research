// Public surface: which JSON-RPC method names this archive replay server
// handles today and which well-known ones it doesn't. Consumed by the demo
// UI; kept as plain string arrays with no imports so it stays cheap to
// import from a browser bundle.

export const SUPPORTED_METHODS = [
  'eth_blockNumber',
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getUncleCountByBlockNumber',
  'eth_getUncleCountByBlockHash',
  'eth_syncing',
  'net_version',
  'web3_clientVersion',
] as const

export type SupportedMethod = (typeof SUPPORTED_METHODS)[number]

export const UNSUPPORTED_METHODS = [
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getProof',
  'eth_call',
  'eth_estimateGas',
  'eth_sendRawTransaction',
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleByBlockHashAndIndex',
  'net_listening',
  'net_peerCount',
] as const
