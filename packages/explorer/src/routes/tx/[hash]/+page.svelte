<script lang="ts">
  import { page } from '$app/state'
  import * as Card from '$lib/components/ui/card'
  import {
    formatEth,
    formatGwei,
    formatTimestamp,
    hexByteLength,
    relativeTime,
    shortHash,
  } from '$lib/format'
  import { hasSource, hasTxIndex, settings } from '$lib/settings.svelte'
  import { fetchBlock, type FetchedBlock } from '$lib/swarm'
  import type { DecodedTransaction } from '@fullcircle/era/bundle'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'

  let hash = $derived((page.params.hash ?? '').toLowerCase())

  let block = $state<FetchedBlock | null>(null)
  let tx = $state<DecodedTransaction | null>(null)
  let txIndex = $state<number>(-1)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    if (!hasSource()) {
      error = 'No source set — open Settings above.'
      return
    }
    if (!hasTxIndex()) {
      error = 'Transaction lookup is not available on this source (no byTx index).'
      return
    }
    loading = true
    error = null
    block = null
    tx = null
    txIndex = -1
    try {
      block = await fetchBlock('tx', hash)
      const idx = block.body.transactions.findIndex((t) => t.hash === hash)
      if (idx < 0) {
        error = 'Transaction not found in returned block bundle.'
      } else {
        tx = block.body.transactions[idx]
        txIndex = idx
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void hash
    void settings.beeUrl
    void settings.source
    void settings.manifestRef
    void settings.potByTx
    load()
  })

  function txTypeLabel(t: number): string {
    if (t === 0) return 'legacy'
    if (t === 1) return '2930'
    if (t === 2) return '1559'
    if (t === 3) return 'blob'
    return `0x${t.toString(16)}`
  }

  // Per-tx gas used from receipts; undefined when context is missing.
  let gasUsed = $derived.by(() => {
    if (!block || txIndex < 0) return undefined
    const cum = block.receipts[txIndex]?.cumulativeGasUsed
    if (cum === undefined) return undefined
    const prev = txIndex > 0 ? (block.receipts[txIndex - 1]?.cumulativeGasUsed ?? 0n) : 0n
    return cum - prev
  })

  // EIP-1559 effective gas price: baseFee + min(maxPriorityFee, maxFee - baseFee).
  let effectiveGasPrice = $derived.by(() => {
    if (!tx || !block) return undefined
    if (tx.gasPrice !== undefined) return tx.gasPrice
    if (tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined) {
      const baseFee = block.header.baseFeePerGas ?? 0n
      const room = tx.maxFeePerGas > baseFee ? tx.maxFeePerGas - baseFee : 0n
      const priority = tx.maxPriorityFeePerGas < room ? tx.maxPriorityFeePerGas : room
      return baseFee + priority
    }
    return undefined
  })

  let txFee = $derived.by(() =>
    gasUsed !== undefined && effectiveGasPrice !== undefined
      ? gasUsed * effectiveGasPrice
      : undefined,
  )

  let burntFee = $derived.by(() => {
    if (gasUsed === undefined || !block) return undefined
    const baseFee = block.header.baseFeePerGas
    return baseFee === undefined ? undefined : gasUsed * baseFee
  })
</script>

<main class="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8">
  <nav class="flex items-center gap-2 text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">/</a>
    <ChevronRightIcon class="size-4" />
    <span>tx</span>
    <ChevronRightIcon class="size-4" />
    <span class="text-foreground font-mono">{shortHash(hash)}</span>
  </nav>

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading transaction…</p>
  {:else if error}
    <Card.Root class="border-destructive/50">
      <Card.Content>
        <p class="font-mono text-sm text-destructive">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if tx && block}
    <Card.Root>
      <Card.Header>
        <Card.Title>Overview</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt class="text-muted-foreground">Transaction hash</dt>
          <dd class="break-all font-mono">{tx.hash}</dd>

          <dt class="text-muted-foreground">Block</dt>
          <dd class="font-mono">
            <a href="/block/{block.header.number}" class="underline hover:no-underline"
              >#{block.header.number}</a
            >
            <span class="text-muted-foreground">
              · index {txIndex} of {block.body.transactions.length}</span
            >
          </dd>

          <dt class="text-muted-foreground">Timestamp</dt>
          <dd class="font-mono">
            {formatTimestamp(block.header.timestamp)}
            <span class="text-muted-foreground">({relativeTime(block.header.timestamp)})</span>
          </dd>

          <dt class="text-muted-foreground">Type</dt>
          <dd class="font-mono">{txTypeLabel(tx.type)} (type {tx.type})</dd>

          <dt class="text-muted-foreground">Nonce</dt>
          <dd class="font-mono">{tx.nonce}</dd>

          <dt class="text-muted-foreground">From</dt>
          <dd class="break-all font-mono">
            {#if tx.from === null}
              <span class="text-muted-foreground">(recovery failed)</span>
            {:else}
              {tx.from}
            {/if}
          </dd>

          <dt class="text-muted-foreground">To</dt>
          <dd class="break-all font-mono">
            {#if tx.to === null}
              <span class="text-muted-foreground">contract creation</span>
            {:else}
              {tx.to}
            {/if}
          </dd>

          <dt class="text-muted-foreground">Value</dt>
          <dd class="font-mono">{formatEth(tx.value)}</dd>

          <dt class="text-muted-foreground">Gas used / limit</dt>
          <dd class="font-mono">
            {#if gasUsed !== undefined}
              {gasUsed.toLocaleString()} / {tx.gasLimit.toLocaleString()}
              {#if tx.gasLimit > 0n}
                <span class="text-muted-foreground"
                  >({Number((gasUsed * 10000n) / tx.gasLimit) / 100}%)</span
                >
              {/if}
            {:else}
              {tx.gasLimit.toLocaleString()}
            {/if}
          </dd>

          {#if tx.gasPrice !== undefined}
            <dt class="text-muted-foreground">Gas price</dt>
            <dd class="font-mono">{formatGwei(tx.gasPrice)}</dd>
          {/if}

          {#if tx.maxFeePerGas !== undefined}
            <dt class="text-muted-foreground">Max fee / gas</dt>
            <dd class="font-mono">{formatGwei(tx.maxFeePerGas)}</dd>
          {/if}

          {#if tx.maxPriorityFeePerGas !== undefined}
            <dt class="text-muted-foreground">Max priority fee / gas</dt>
            <dd class="font-mono">{formatGwei(tx.maxPriorityFeePerGas)}</dd>
          {/if}

          {#if effectiveGasPrice !== undefined && tx.gasPrice === undefined}
            <dt class="text-muted-foreground">Effective gas price</dt>
            <dd class="font-mono">{formatGwei(effectiveGasPrice)}</dd>
          {/if}

          {#if txFee !== undefined}
            <dt class="text-muted-foreground">Transaction fee</dt>
            <dd class="font-mono">
              {formatEth(txFee)}
              {#if burntFee !== undefined && burntFee > 0n}
                <span class="text-muted-foreground"
                  >({formatEth(burntFee)} burnt · {formatEth(txFee - burntFee)} to miner)</span
                >
              {/if}
            </dd>
          {/if}

          {#if tx.chainId !== undefined}
            <dt class="text-muted-foreground">Chain ID</dt>
            <dd class="font-mono">{tx.chainId}</dd>
          {/if}
        </dl>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Input data</Card.Title>
        <Card.Description>{hexByteLength(tx.input)} bytes</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if tx.input === '0x' || tx.input === ''}
          <p class="text-sm text-muted-foreground">(empty)</p>
        {:else}
          <pre
            class="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-all">{tx.input}</pre>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Signature</Card.Title>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
          {#if tx.v !== undefined}
            <dt class="text-muted-foreground">v</dt>
            <dd class="font-mono">{tx.v}</dd>
          {/if}
          {#if tx.r !== undefined}
            <dt class="text-muted-foreground">r</dt>
            <dd class="break-all font-mono">{tx.r}</dd>
          {/if}
          {#if tx.s !== undefined}
            <dt class="text-muted-foreground">s</dt>
            <dd class="break-all font-mono">{tx.s}</dd>
          {/if}
        </dl>
        <details class="text-sm">
          <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
            Raw ({hexByteLength(tx.raw)} bytes)
          </summary>
          <pre
            class="mt-2 max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-all">{tx.raw}</pre>
        </details>
      </Card.Content>
    </Card.Root>
  {/if}
</main>
