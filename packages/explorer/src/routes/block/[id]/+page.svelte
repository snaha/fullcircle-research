<script lang="ts">
  import { page } from '$app/state'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import {
    formatEth,
    formatGwei,
    formatTimestamp,
    hexByteLength,
    relativeTime,
    shortHash,
  } from '$lib/format'
  import { hasSource, settings } from '$lib/settings.svelte'
  import { fetchBlock, type FetchedBlock } from '$lib/swarm'
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'

  let id = $derived(page.params.id ?? '')
  let index = $derived<'number' | 'hash'>(/^\d+$/.test(id) ? 'number' : 'hash')

  let block = $state<FetchedBlock | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    if (!hasSource()) {
      error = 'No source set — open Settings above.'
      return
    }
    loading = true
    error = null
    block = null
    try {
      block = await fetchBlock(index, id)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void id
    void settings.beeUrl
    void settings.source
    void settings.manifestRef
    void settings.potByNumber
    void settings.potByHash
    load()
  })

  function txTypeLabel(t: number): string {
    if (t === 0) return 'legacy'
    if (t === 1) return '2930'
    if (t === 2) return '1559'
    if (t === 3) return 'blob'
    return `0x${t.toString(16)}`
  }
</script>

<main class="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8">
  <nav class="flex items-center gap-2 text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">/</a>
    <ChevronRightIcon class="size-4" />
    <a href="/block" class="hover:text-foreground">block</a>
    <ChevronRightIcon class="size-4" />
    <span class="text-foreground font-mono">{block ? block.header.number : id}</span>
    {#if block}
      {@const n = block.header.number}
      <div class="ml-1 flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          href={n > 0n ? `/block/${n - 1n}` : undefined}
          disabled={n === 0n}
          aria-label="Previous block"
          title="Previous block"
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-xs"
          href={`/block/${n + 1n}`}
          aria-label="Next block"
          title="Next block"
        >
          <ChevronRightIcon />
        </Button>
      </div>
    {/if}
  </nav>

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading block…</p>
  {:else if error}
    <Card.Root class="border-destructive/50">
      <Card.Content>
        <p class="font-mono text-sm text-destructive">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if block}
    {@const h = block.header}

    <Card.Root>
      <Card.Header>
        <Card.Title>Overview</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt class="text-muted-foreground">Block height</dt>
          <dd class="font-mono">{h.number}</dd>

          <dt class="text-muted-foreground">Timestamp</dt>
          <dd class="font-mono">
            {formatTimestamp(h.timestamp)}
            <span class="text-muted-foreground">· {relativeTime(h.timestamp)} ({h.timestamp})</span>
          </dd>

          <dt class="text-muted-foreground">Transactions</dt>
          <dd class="font-mono">{block.body.transactions.length}</dd>

          <dt class="text-muted-foreground">Miner</dt>
          <dd class="break-all font-mono">{h.miner}</dd>

          <dt class="text-muted-foreground">Gas used / limit</dt>
          <dd class="font-mono">
            {h.gasUsed.toLocaleString()} / {h.gasLimit.toLocaleString()}
            {#if h.gasLimit > 0n}
              <span class="text-muted-foreground"
                >({Number((h.gasUsed * 10000n) / h.gasLimit) / 100}%)</span
              >
            {/if}
          </dd>

          <dt class="text-muted-foreground">Block reward</dt>
          <dd class="font-mono">
            {formatEth(block.reward.total)}
            <span class="text-muted-foreground">
              ({formatEth(block.reward.staticReward)} subsidy
              {#if block.reward.uncleBonus > 0n}
                + {formatEth(block.reward.uncleBonus)} uncles
              {/if}
              + {formatEth(block.reward.fees)} fees)
            </span>
          </dd>

          {#if h.baseFeePerGas !== undefined}
            <dt class="text-muted-foreground">Base fee</dt>
            <dd class="font-mono">{formatGwei(h.baseFeePerGas)}</dd>
          {/if}

          <dt class="text-muted-foreground">Difficulty</dt>
          <dd class="font-mono">{h.difficulty.toLocaleString()}</dd>

          {#if block.totalDifficulty !== null}
            <dt class="text-muted-foreground">Total difficulty</dt>
            <dd class="font-mono">{block.totalDifficulty.toLocaleString()}</dd>
          {/if}

          <dt class="text-muted-foreground">Hash</dt>
          <dd class="break-all font-mono">{block.hash}</dd>

          <dt class="text-muted-foreground">Parent hash</dt>
          <dd class="break-all font-mono">
            {#if h.number > 0n}
              <a href="/block/{h.number - 1n}" class="underline hover:no-underline"
                >{h.parentHash}</a
              >
            {:else}
              {h.parentHash}
            {/if}
          </dd>

          <dt class="text-muted-foreground">State root</dt>
          <dd class="break-all font-mono">{h.stateRoot}</dd>

          <dt class="text-muted-foreground">Transactions root</dt>
          <dd class="break-all font-mono">{h.transactionsRoot}</dd>

          <dt class="text-muted-foreground">Receipts root</dt>
          <dd class="break-all font-mono">{h.receiptsRoot}</dd>

          <dt class="text-muted-foreground">Nonce</dt>
          <dd class="font-mono">{h.nonce}</dd>

          <dt class="text-muted-foreground">Extra data</dt>
          <dd class="break-all font-mono">
            {h.extraData}
            <span class="text-muted-foreground">({hexByteLength(h.extraData)} bytes)</span>
          </dd>

          {#if h.withdrawalsRoot !== undefined}
            <dt class="text-muted-foreground">Withdrawals root</dt>
            <dd class="break-all font-mono">{h.withdrawalsRoot}</dd>
          {/if}
          {#if h.blobGasUsed !== undefined}
            <dt class="text-muted-foreground">Blob gas used</dt>
            <dd class="font-mono">{h.blobGasUsed.toLocaleString()}</dd>
          {/if}
          {#if h.excessBlobGas !== undefined}
            <dt class="text-muted-foreground">Excess blob gas</dt>
            <dd class="font-mono">{h.excessBlobGas.toLocaleString()}</dd>
          {/if}
        </dl>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Transactions ({block.body.transactions.length})</Card.Title>
      </Card.Header>
      <Card.Content class="px-0">
        {#if block.body.transactions.length === 0}
          <p class="px-6 text-sm text-muted-foreground">No transactions in this block.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th class="px-6 py-2 text-left font-medium">Hash</th>
                  <th class="px-3 py-2 text-left font-medium">From</th>
                  <th class="px-3 py-2 text-left font-medium">To</th>
                  <th class="px-3 py-2 text-left font-medium">Value</th>
                  <th class="px-3 py-2 text-left font-medium">Gas limit</th>
                  <th class="px-6 py-2 text-right font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {#each block.body.transactions as tx (tx.hash)}
                  <tr class="border-b last:border-0 hover:bg-muted/50">
                    <td class="px-6 py-2 font-mono">
                      <a
                        href="/tx/{tx.hash}"
                        class="text-primary underline-offset-4 hover:underline"
                      >
                        {shortHash(tx.hash)}
                      </a>
                    </td>
                    <td class="px-3 py-2 font-mono">
                      {#if tx.from === null}
                        <span class="text-muted-foreground">—</span>
                      {:else}
                        {shortHash(tx.from, 10, 6)}
                      {/if}
                    </td>
                    <td class="px-3 py-2 font-mono">
                      {#if tx.to === null}
                        <span class="text-muted-foreground">contract creation</span>
                      {:else}
                        {shortHash(tx.to, 10, 6)}
                      {/if}
                    </td>
                    <td class="px-3 py-2 font-mono">{formatEth(tx.value)}</td>
                    <td class="px-3 py-2 font-mono">{tx.gasLimit.toLocaleString()}</td>
                    <td class="px-6 py-2 text-right">
                      <Badge variant="outline" class="font-mono">{txTypeLabel(tx.type)}</Badge>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}
</main>
