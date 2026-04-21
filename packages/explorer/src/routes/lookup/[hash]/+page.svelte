<script lang="ts">
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import * as Card from '$lib/components/ui/card'
  import { hasSource, hasTxIndex } from '$lib/settings.svelte'
  import { probeIndex } from '$lib/swarm'

  let hash = $derived((page.params.hash ?? '').toLowerCase())
  let error = $state<string | null>(null)

  async function resolve() {
    if (!hasSource()) {
      error = 'No source set — open Settings above.'
      return
    }
    error = null

    // Try block hash first. If a tx index exists on this source, also try tx.
    const [asBlock, asTx] = await Promise.all([
      probeIndex('hash', hash),
      hasTxIndex() ? probeIndex('tx', hash) : Promise.resolve(false),
    ])
    if (asBlock) {
      await goto(`/block/${hash}`, { replaceState: true })
      return
    }
    if (asTx) {
      await goto(`/tx/${hash}`, { replaceState: true })
      return
    }
    error = `${hash} is not indexed as a block hash${hasTxIndex() ? ' or tx hash' : ''} on this source.`
  }

  $effect(() => {
    void hash
    resolve()
  })
</script>

<main class="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-10">
  <p class="break-all font-mono text-sm text-muted-foreground">Resolving {hash}…</p>
  {#if error}
    <Card.Root class="border-destructive/50">
      <Card.Content>
        <p class="font-mono text-sm text-destructive">{error}</p>
      </Card.Content>
    </Card.Root>
  {/if}
</main>
