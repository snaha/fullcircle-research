// Display helpers: wei → ETH, unix seconds → relative + absolute time,
// hash shortening.

const WEI_PER_ETH = 10n ** 18n
const WEI_PER_GWEI = 10n ** 9n

export function formatEth(wei: bigint): string {
  if (wei === 0n) return '0 ETH'
  const whole = wei / WEI_PER_ETH
  const frac = wei % WEI_PER_ETH
  if (frac === 0n) return `${whole} ETH`
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole}.${fracStr} ETH`
}

export function formatGwei(wei: bigint): string {
  if (wei === 0n) return '0 gwei'
  const whole = wei / WEI_PER_GWEI
  const frac = wei % WEI_PER_GWEI
  if (frac === 0n) return `${whole} gwei`
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '')
  return `${whole}.${fracStr} gwei`
}

export function formatTimestamp(unix: bigint): string {
  const ms = Number(unix) * 1000
  const d = new Date(ms)
  return d.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

export function relativeTime(unix: bigint): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - Number(unix)
  if (diff < 0) return 'in the future'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 31536000) return `${Math.floor(diff / 86400)}d ago`
  return `${Math.floor(diff / 31536000)}y ago`
}

export function shortHash(hash: string, head = 8, tail = 6): string {
  if (hash.length <= head + tail + 3) return hash
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`
}

// Number of decoded bytes in a 0x-prefixed hex string.
export function hexByteLength(hex: string): number {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  return Math.floor(h.length / 2)
}
