<script lang="ts">
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import * as Card from '$lib/components/ui/card'
  import { hasManifest, settings } from '$lib/settings.svelte'

  let hash = $derived((page.params.hash ?? '').toLowerCase())
  let error = $state<string | null>(null)

  async function resolve() {
    if (!hasManifest()) {
      error = 'No manifest reference set — open Settings above.'
      return
    }
    error = null

    // Try block hash first, then tx hash. HEAD is cheaper than GET; fall back
    // to GET if the gateway doesn't support it.
    const asBlock = probe(`hash/${hash}`)
    const asTx = probe(`tx/${hash}`)
    const [b, t] = await Promise.all([asBlock, asTx])
    if (b) {
      await goto(`/block/${hash}`, { replaceState: true })
      return
    }
    if (t) {
      await goto(`/tx/${hash}`, { replaceState: true })
      return
    }
    error = `${hash} is not indexed as a block hash or tx hash in this manifest.`
  }

  async function probe(path: string): Promise<boolean> {
    try {
      // We can't do a cheap HEAD through mantaray manifests reliably, so just
      // try fetching a tiny range. If not 404, it exists.
      const res = await fetch(`${settings.beeUrl}/bzz/${settings.manifestRef}/${path}`, {
        headers: { Range: 'bytes=0-0' },
      })
      return res.status !== 404
    } catch {
      return false
    }
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
