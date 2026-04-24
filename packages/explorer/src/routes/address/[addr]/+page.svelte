<script lang="ts">
  import { page } from '$app/state'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { formatEth } from '$lib/format'
  import { hasAddressIndex, hasSource, settings } from '$lib/settings.svelte'
  import { fetchAccount, type AccountRecord } from '$lib/swarm'
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'

  const EVENTS_PER_PAGE = 25

  let raw = $derived((page.params.addr ?? '').toLowerCase())
  let normalized = $derived(raw.startsWith('0x') ? raw : `0x${raw}`)
  let evPageNum = $derived(Math.max(0, Number(page.url.searchParams.get('p') ?? 0) || 0))

  let account = $state<AccountRecord | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    if (!hasSource()) {
      error = 'No source set — open Settings above.'
      return
    }
    if (!hasAddressIndex()) {
      error = 'Address lookup is not available for the current source.'
      return
    }
    loading = true
    error = null
    account = null
    try {
      account = await fetchAccount(normalized)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void raw
    void settings.beeUrl
    void settings.source
    void settings.manifestRef
    load()
  })

  function deltaLabel(pre: string, post: string): { text: string; positive: boolean } {
    const d = BigInt(post) - BigInt(pre)
    const positive = d >= 0n
    const abs = positive ? d : -d
    return { text: (positive ? '+' : '−') + formatEth(abs), positive }
  }
</script>

<main class="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8">
  <nav class="flex items-center gap-2 text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">/</a>
    <ChevronRightIcon class="size-4" />
    <span>address</span>
    <ChevronRightIcon class="size-4" />
    <span class="text-foreground font-mono break-all">{normalized}</span>
  </nav>

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading account…</p>
  {:else if error}
    <Card.Root class="border-destructive/50">
      <Card.Content>
        <p class="font-mono text-sm text-destructive">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else if account}
    {@const events = account.events}
    {@const first = events.length > 0 ? events[0] : null}
    {@const last = events.length > 0 ? events[events.length - 1] : null}

    <Card.Root>
      <Card.Header>
        <Card.Title>Overview</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt class="text-muted-foreground">Address</dt>
          <dd class="break-all font-mono">{account.addr}</dd>

          <dt class="text-muted-foreground">Balance</dt>
          <dd class="font-mono">
            {formatEth(BigInt(account.balance))}
            <span class="text-muted-foreground">({account.balance} wei)</span>
          </dd>

          <dt class="text-muted-foreground">Balance events</dt>
          <dd class="font-mono">{account.eventCount.toLocaleString()}</dd>

          {#if first && last}
            <dt class="text-muted-foreground">First change</dt>
            <dd class="font-mono">
              <a href="/block/{first.block}" class="underline hover:no-underline">
                block #{first.block}
              </a>
            </dd>

            <dt class="text-muted-foreground">Last change</dt>
            <dd class="font-mono">
              <a href="/block/{last.block}" class="underline hover:no-underline">
                block #{last.block}
              </a>
            </dd>
          {/if}
        </dl>
      </Card.Content>
    </Card.Root>

    {@const totalEvents = events.length}
    {@const totalPages = Math.max(1, Math.ceil(totalEvents / EVENTS_PER_PAGE))}
    {@const clampedPage = Math.min(evPageNum, totalPages - 1)}
    {@const evStart = clampedPage * EVENTS_PER_PAGE}
    {@const evEnd = Math.min(evStart + EVENTS_PER_PAGE, totalEvents)}
    {@const visible = events.slice(evStart, evEnd)}
    {@const prevHref = clampedPage > 0 ? `/address/${normalized}?p=${clampedPage - 1}` : undefined}
    {@const nextHref =
      clampedPage < totalPages - 1 ? `/address/${normalized}?p=${clampedPage + 1}` : undefined}

    <Card.Root>
      <Card.Header class="flex flex-row flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1.5">
          <Card.Title>Balance history ({totalEvents})</Card.Title>
          {#if totalEvents > 0}
            <Card.Description>
              Showing {evStart + 1}–{evEnd} of {totalEvents} · page {clampedPage + 1} of {totalPages}
            </Card.Description>
          {/if}
        </div>
        {#if totalEvents > EVENTS_PER_PAGE}
          <div class="flex items-center gap-2">
            <Button
              href={prevHref}
              disabled={!prevHref}
              variant="outline"
              size="sm"
              aria-label="Previous events"
            >
              <ChevronLeftIcon />
              Prev
            </Button>
            <Button
              href={nextHref}
              disabled={!nextHref}
              variant="outline"
              size="sm"
              aria-label="Next events"
            >
              Next
              <ChevronRightIcon />
            </Button>
          </div>
        {/if}
      </Card.Header>
      <Card.Content class="px-0">
        {#if totalEvents === 0}
          <p class="px-6 text-sm text-muted-foreground">No balance changes recorded.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th class="px-6 py-2 text-left font-medium">Block</th>
                  <th class="px-3 py-2 text-left font-medium">Pre</th>
                  <th class="px-3 py-2 text-left font-medium">Post</th>
                  <th class="px-6 py-2 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {#each visible as ev (ev.block + ':' + ev.pre + ':' + ev.post)}
                  {@const d = deltaLabel(ev.pre, ev.post)}
                  <tr class="border-b last:border-0 hover:bg-muted/50">
                    <td class="px-6 py-2 font-mono">
                      <a
                        href="/block/{ev.block}"
                        class="text-primary underline-offset-4 hover:underline"
                      >
                        {ev.block}
                      </a>
                    </td>
                    <td class="px-3 py-2 font-mono">{formatEth(BigInt(ev.pre))}</td>
                    <td class="px-3 py-2 font-mono">{formatEth(BigInt(ev.post))}</td>
                    <td class="px-6 py-2 text-right">
                      <Badge
                        variant="outline"
                        class="font-mono {d.positive
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-destructive'}"
                      >
                        {d.text}
                      </Badge>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Card.Content>
      {#if totalEvents > EVENTS_PER_PAGE}
        <Card.Footer class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">
            Page {clampedPage + 1} of {totalPages}
          </span>
          <div class="flex items-center gap-2">
            <Button href={prevHref} disabled={!prevHref} variant="outline" size="sm">
              <ChevronLeftIcon />
              Prev
            </Button>
            <Button href={nextHref} disabled={!nextHref} variant="outline" size="sm">
              Next
              <ChevronRightIcon />
            </Button>
          </div>
        </Card.Footer>
      {/if}
    </Card.Root>
  {/if}
</main>
