<script lang="ts">
  import { page } from '$app/state'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { formatEth, relativeTime, shortHash } from '$lib/format'
  import { hasSource, settings } from '$lib/settings.svelte'
  import {
    fetchBlock,
    fetchMeta,
    hasGaps,
    type FetchedBlock,
    type SourceMeta,
  } from '$lib/swarm'
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'

  const PER_PAGE = 25

  const numberFormatter = new Intl.NumberFormat('en-US')
  function formatBlock(n: string | bigint | number): string {
    try {
      if (typeof n === 'bigint') return numberFormatter.format(n)
      if (typeof n === 'number') return numberFormatter.format(n)
      return numberFormatter.format(BigInt(n))
    } catch {
      return String(n)
    }
  }

  function intervalSecs(a: bigint, b: bigint): number {
    const diff = a - b
    return diff >= 0n ? Number(diff) : 0
  }

  let pageNum = $derived(Math.max(0, Number(page.url.searchParams.get('p') ?? 0) || 0))

  let meta = $state<SourceMeta | null>(null)
  // PER_PAGE rows plus one extra predecessor for the interval of the last row.
  let blocks = $state<FetchedBlock[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)

  let rows = $derived(blocks.slice(0, PER_PAGE))

  let totalPages = $derived.by(() => {
    if (!meta) return 0
    const last = BigInt(meta.lastBlock)
    const first = BigInt(meta.firstBlock)
    const total = last - first + 1n
    return Number((total + BigInt(PER_PAGE) - 1n) / BigInt(PER_PAGE))
  })

  let topOfPage = $derived.by(() => {
    if (!meta) return null
    const last = BigInt(meta.lastBlock)
    return last - BigInt(pageNum) * BigInt(PER_PAGE)
  })

  $effect(() => {
    void settings.beeUrl
    void settings.source
    void settings.manifestRef
    void settings.potByNumber
    void settings.potMeta
    if (!hasSource()) {
      meta = null
      blocks = []
      error = null
      return
    }
    const currentPage = pageNum
    let cancelled = false
    error = null
    ;(async () => {
      const metaResult = meta ?? (await fetchMeta())
      if (cancelled) return
      if (!meta) meta = metaResult
      const last = BigInt(metaResult.lastBlock)
      const first = BigInt(metaResult.firstBlock)
      const top = last - BigInt(currentPage) * BigInt(PER_PAGE)
      if (top < first) {
        blocks = []
        return
      }
      loading = true
      blocks = []
      try {
        const available = top - first + 1n
        const want = BigInt(PER_PAGE + 1)
        const count = Number(available < want ? available : want)
        const numbers: bigint[] = []
        for (let i = 0; i < count; i++) numbers.push(top - BigInt(i))
        const results = await Promise.all(numbers.map((n) => fetchBlock('number', n.toString())))
        if (!cancelled) blocks = results
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    })()
    return () => {
      cancelled = true
    }
  })

  let prevHref = $derived(pageNum > 0 ? `/block?p=${pageNum - 1}` : undefined)
  let nextHref = $derived(
    totalPages > 0 && pageNum < totalPages - 1 ? `/block?p=${pageNum + 1}` : undefined,
  )
</script>

<main class="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8">
  <nav class="flex items-center gap-2 text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">/</a>
    <ChevronRightIcon class="size-4" />
    <span class="text-foreground">block</span>
  </nav>

  <Card.Root>
    <Card.Header class="flex flex-row flex-wrap items-start justify-between gap-4">
      <div class="flex flex-col gap-1.5">
        <Card.Title>Blocks</Card.Title>
        <Card.Description>
          {#if meta}
            {formatBlock(meta.firstBlock)} – {formatBlock(meta.lastBlock)} · {formatBlock(
              meta.blockCount,
            )} blocks · {formatBlock(meta.txCount)} txns
            {#if totalPages > 0}
              · page {pageNum + 1} of {formatBlock(totalPages)}
            {/if}
            {#if hasGaps(meta)}
              <Badge variant="destructive" class="ml-2 font-mono">gaps</Badge>
            {/if}
          {:else if hasSource()}
            Reading <code class="font-mono">/meta</code>…
          {:else}
            No source set.
          {/if}
        </Card.Description>
      </div>

      {#if meta}
        <div class="flex items-center gap-2">
          <Button
            href={prevHref}
            disabled={!prevHref}
            variant="outline"
            size="sm"
            aria-label="Newer blocks"
          >
            <ChevronLeftIcon />
            Newer
          </Button>
          <Button
            href={nextHref}
            disabled={!nextHref}
            variant="outline"
            size="sm"
            aria-label="Older blocks"
          >
            Older
            <ChevronRightIcon />
          </Button>
        </div>
      {/if}
    </Card.Header>
    <Card.Content class="px-0">
      {#if !hasSource()}
        <p class="px-6 text-sm text-muted-foreground">
          Open <Badge variant="outline">Settings</Badge> and paste a manifest or POT reference.
        </p>
      {:else if loading && rows.length === 0}
        <p class="px-6 text-sm text-muted-foreground">Loading blocks…</p>
      {:else if error}
        <p class="px-6 font-mono text-sm text-destructive">{error}</p>
      {:else if rows.length === 0 && topOfPage !== null}
        <p class="px-6 text-sm text-muted-foreground">
          No blocks on this page (top would be {topOfPage}).
        </p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th class="px-6 py-2 text-left font-medium">Block</th>
                <th class="px-3 py-2 text-left font-medium">Age</th>
                <th class="px-3 py-2 text-left font-medium">Miner</th>
                <th class="px-3 py-2 text-left font-medium">Txns</th>
                <th class="px-3 py-2 text-left font-medium">Interval</th>
                <th class="px-3 py-2 text-left font-medium">Gas used</th>
                <th class="px-6 py-2 text-right font-medium">Reward</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as block, i (block.hash)}
                {@const h = block.header}
                {@const prev = blocks[i + 1]}
                {@const interval = prev ? intervalSecs(h.timestamp, prev.header.timestamp) : null}
                <tr class="border-b last:border-0 hover:bg-muted/50">
                  <td class="px-6 py-2 font-mono">
                    <a
                      href="/block/{h.number}"
                      class="text-primary underline-offset-4 hover:underline"
                    >
                      {h.number}
                    </a>
                  </td>
                  <td
                    class="px-3 py-2 font-mono text-muted-foreground"
                    title={new Date(Number(h.timestamp) * 1000).toISOString()}
                  >
                    {relativeTime(h.timestamp)}
                  </td>
                  <td class="px-3 py-2 font-mono">{shortHash(h.miner, 10, 8)}</td>
                  <td class="px-3 py-2 font-mono">{block.body.transactions.length}</td>
                  <td class="px-3 py-2 font-mono text-muted-foreground">
                    {interval !== null ? `${interval}s` : '—'}
                  </td>
                  <td class="px-3 py-2 font-mono">
                    {h.gasUsed.toLocaleString()}
                    {#if h.gasLimit > 0n}
                      <span class="text-muted-foreground"
                        >({Number((h.gasUsed * 10000n) / h.gasLimit) / 100}%)</span
                      >
                    {/if}
                  </td>
                  <td class="px-6 py-2 text-right font-mono">{formatEth(block.reward.total)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card.Content>
    {#if meta && rows.length > 0}
      <Card.Footer class="flex items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">
          Page {pageNum + 1} of {formatBlock(totalPages)}
        </span>
        <div class="flex items-center gap-2">
          <Button href={prevHref} disabled={!prevHref} variant="outline" size="sm">
            <ChevronLeftIcon />
            Newer
          </Button>
          <Button href={nextHref} disabled={!nextHref} variant="outline" size="sm">
            Older
            <ChevronRightIcon />
          </Button>
        </div>
      </Card.Footer>
    {/if}
  </Card.Root>
</main>
