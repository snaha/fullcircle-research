import { createPublicClient, defineChain, http } from 'viem'

// Standalone chain definition. viem requires a chainId but never needs to
// round-trip it to the RPC — skipping eth_chainId keeps the wire log clean
// and means we don't have to implement the method server-side.
export const fullcircleChain = defineChain({
  id: 1,
  name: 'FullCircle (mainnet replay)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
})

export const DEFAULT_RPC_URL =
  import.meta.env.VITE_FULLCIRCLE_RPC_URL ?? 'http://127.0.0.1:8545'

export function makeClient(url: string = DEFAULT_RPC_URL) {
  return createPublicClient({
    chain: fullcircleChain,
    transport: http(url, { retryCount: 0 }),
  })
}

export type FullcircleClient = ReturnType<typeof makeClient>
