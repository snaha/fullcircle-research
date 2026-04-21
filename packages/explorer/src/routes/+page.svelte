<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { formatEth, relativeTime, shortHash } from '$lib/format'
  import { hasSource, settings } from '$lib/settings.svelte'
  import { fetchBlock, fetchMeta, hasGaps, type FetchedBlock, type SourceMeta } from '$lib/swarm'
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right'

  const LATEST_COUNT = 10

  const numberFormatter = new Intl.NumberFormat('en-US')
  function formatBlock(n: string | bigint): string {
    try {
      return numberFormatter.format(typeof n === 'bigint' ? n : BigInt(n))
    } catch {
      return String(n)
    }
  }

  function intervalSecs(a: bigint, b: bigint): number {
    const diff = a - b
    return diff >= 0n ? Number(diff) : 0
  }

  let meta = $state<SourceMeta | null>(null)
  // We fetch one extra block so every displayed row has a predecessor to
  // compute the per-block interval ("N txns in Δs").
  let latest = $state<FetchedBlock[]>([])
  let latestError = $state<string | null>(null)
  let latestLoading = $state(false)

  let rows = $derived(latest.slice(0, LATEST_COUNT))

  $effect(() => {
    // touch reactive deps so the effect re-runs when any changes
    void settings.beeUrl
    void settings.source
    void settings.manifestRef
    void settings.potByNumber
    void settings.potMeta
    if (!hasSource()) {
      meta = null
      latest = []
      latestError = null
      return
    }
    let cancelled = false
    meta = null
    latest = []
    latestError = null
    ;(async () => {
      const result = await fetchMeta()
      if (cancelled) return
      meta = result
      latestLoading = true
      try {
        const last = BigInt(result.lastBlock)
        const first = BigInt(result.firstBlock)
        // +1 so the oldest row also has a previous block for interval calc.
        const available = last - first + 1n
        const want = BigInt(LATEST_COUNT + 1)
        const count = Number(available < want ? available : want)
        const numbers: bigint[] = []
        for (let i = 0; i < count; i++) numbers.push(last - BigInt(i))
        const blocks = await Promise.all(numbers.map((n) => fetchBlock('number', n.toString())))
        if (!cancelled) latest = blocks
      } catch (err) {
        if (!cancelled) latestError = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) latestLoading = false
      }
    })()
    return () => {
      cancelled = true
    }
  })
</script>

<main class="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
  <section class="flex flex-col gap-2">
    <h1 class="text-3xl font-semibold tracking-tight">FullCircle block explorer</h1>
    <p class="max-w-2xl text-muted-foreground">
      Browse Ethereum blocks served from Swarm. Block data is fetched directly from a Bee gateway
      through either a Mantaray manifest or a POT index uploaded by <code
        class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">@fullcircle/era</code
      >.
    </p>
  </section>

  <div class="grid gap-4 md:grid-cols-2">
    <Card.Root>
      <Card.Header>
        <Card.Title>Current source</Card.Title>
        <Card.Description>Where this explorer is reading from.</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if hasSource()}
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Bee gateway</dt>
            <dd class="font-mono break-all">{settings.beeUrl}</dd>
            <dt class="text-muted-foreground">Source</dt>
            <dd class="font-mono">
              {#if settings.source === 'manifest'}
                manifest
              {:else}
                pot
              {/if}
            </dd>
            {#if settings.source === 'manifest'}
              <dt class="text-muted-foreground">Manifest</dt>
              <dd class="font-mono break-all">{settings.manifestRef}</dd>
            {:else}
              <dt class="text-muted-foreground">byNumber</dt>
              <dd class="font-mono break-all">{settings.potByNumber}</dd>
              <dt class="text-muted-foreground">byHash</dt>
              <dd class="font-mono break-all">{settings.potByHash}</dd>
              {#if /^[0-9a-f]{64}$/.test(settings.potByTx) && settings.potByTx !== '0'.repeat(64)}
                <dt class="text-muted-foreground">byTx</dt>
                <dd class="font-mono break-all">{settings.potByTx}</dd>
              {/if}
            {/if}
            <dt class="text-muted-foreground">Block range</dt>
            <dd class="font-mono">
              {#if meta}
                {formatBlock(meta.firstBlock)} – {formatBlock(meta.lastBlock)}
                {#if hasGaps(meta)}
                  <Badge variant="destructive" class="ml-2 font-mono">gaps</Badge>
                {/if}
              {:else}
                <span class="text-muted-foreground">loading…</span>
              {/if}
            </dd>
            <dt class="text-muted-foreground">Blocks</dt>
            <dd class="font-mono">
              {#if meta}
                {formatBlock(meta.blockCount)}
              {:else}
                <span class="text-muted-foreground">loading…</span>
              {/if}
            </dd>
            <dt class="text-muted-foreground">Transactions</dt>
            <dd class="font-mono">
              {#if meta}
                {formatBlock(meta.txCount)}
              {:else}
                <span class="text-muted-foreground">loading…</span>
              {/if}
            </dd>
          </dl>
        {:else}
          <p class="text-sm text-muted-foreground">
            Open <Badge variant="outline">Settings</Badge> and paste a manifest reference (from
            <code class="font-mono">pnpm era:upload</code>) or the POT refs (from
            <code class="font-mono">pnpm era:upload-pot</code>).
          </p>
        {/if}
      </Card.Content>
      {#if hasSource()}
        <Card.Footer class="flex flex-wrap gap-2">
          <Button
            href={meta ? `/block/${meta.lastBlock}` : undefined}
            disabled={!meta}
            variant="secondary"
            size="sm"
          >
            Jump to last block
            <ArrowRightIcon />
          </Button>
          <Button href="/block" variant="ghost" size="sm">Browse all blocks</Button>
        </Card.Footer>
      {/if}
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>What's here</Card.Title>
        <Card.Description>Everything the selected source currently serves.</Card.Description>
      </Card.Header>
      <Card.Content>
        <ul class="flex flex-col gap-2 text-sm">
          <li class="flex items-start gap-2">
            <span class="mt-1 size-1.5 rounded-full bg-primary"></span>
            <span>
              Block details by number (e.g. <a
                href="/block/1000"
                class="underline hover:no-underline">1000</a
              >) or hash.
            </span>
          </li>
          <li class="flex items-start gap-2">
            <span class="mt-1 size-1.5 rounded-full bg-primary"></span>
            <span>Transaction list per block, decoded client-side from the bundled body.</span>
          </li>
          <li class="flex items-start gap-2">
            <span class="mt-1 size-1.5 rounded-full bg-primary"></span>
            <span>
              Transaction detail pages (<code class="rounded bg-muted px-1 font-mono text-xs"
                >/tx/&lt;hash&gt;</code
              >) with value, gas, and input data.
            </span>
          </li>
        </ul>
      </Card.Content>
    </Card.Root>
  </div>

  {#if hasSource()}
    <Card.Root>
      <Card.Header class="flex flex-row items-start justify-between gap-4">
        <div class="flex flex-col gap-1.5">
          <Card.Title>Latest blocks</Card.Title>
          <Card.Description>
            {#if meta}
              Newest {LATEST_COUNT} blocks ending at
              <span class="font-mono">{formatBlock(meta.lastBlock)}</span>.
            {:else}
              Reading <code class="font-mono">/meta</code>…
            {/if}
          </Card.Description>
        </div>
        <Button href="/block" variant="ghost" size="sm">View all →</Button>
      </Card.Header>
      <Card.Content class="px-0">
        {#if latestLoading && rows.length === 0}
          <p class="px-6 text-sm text-muted-foreground">Loading blocks…</p>
        {:else if latestError}
          <p class="px-6 font-mono text-sm text-destructive">{latestError}</p>
        {:else if rows.length > 0}
          <ul class="divide-y">
            {#each rows as block, i (block.hash)}
              {@const h = block.header}
              {@const prev = latest[i + 1]}
              {@const interval = prev ? intervalSecs(h.timestamp, prev.header.timestamp) : null}
              <li class="flex flex-wrap items-center gap-x-6 gap-y-1 px-6 py-3 hover:bg-muted/50">
                <div class="flex w-28 flex-col">
                  <a
                    href="/block/{h.number}"
                    class="font-mono text-sm text-primary underline-offset-4 hover:underline"
                  >
                    {h.number}
                  </a>
                  <span
                    class="text-xs text-muted-foreground"
                    title={new Date(Number(h.timestamp) * 1000).toISOString()}
                  >
                    {relativeTime(h.timestamp)}
                  </span>
                </div>
                <div class="flex min-w-[14rem] flex-1 flex-col gap-0.5">
                  <span class="text-sm">
                    <span class="text-muted-foreground">Miner </span>
                    <span class="font-mono">{shortHash(h.miner, 10, 8)}</span>
                  </span>
                  <span class="font-mono text-sm">
                    {block.body.transactions.length} txns
                    {#if interval !== null}
                      <span class="text-muted-foreground">in {interval} secs</span>
                    {/if}
                  </span>
                </div>
                <div class="ml-auto">
                  <Badge variant="secondary" class="font-mono"
                    >{formatEth(block.reward.total)}</Badge
                  >
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>
  {/if}
</main>
