<script lang="ts">
  import '../app.css'
  import { goto } from '$app/navigation'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { hasSource, saveSettings, settings, sourceLabel, type Source } from '$lib/settings.svelte'
  import SearchIcon from '@lucide/svelte/icons/search'
  import SettingsIcon from '@lucide/svelte/icons/settings-2'

  let { children } = $props()

  let beeInput = $state(settings.beeUrl)
  let sourceInput = $state<Source>(settings.source)
  let manifestInput = $state(settings.manifestRef)
  let potByNumberInput = $state(settings.potByNumber)
  let potByHashInput = $state(settings.potByHash)
  let potByTxInput = $state(settings.potByTx)
  let potMetaInput = $state(settings.potMeta)
  let settingsOpen = $state(!hasSource())

  function submitSettings(e: SubmitEvent) {
    e.preventDefault()
    saveSettings({
      beeUrl: beeInput,
      source: sourceInput,
      manifestRef: manifestInput,
      potByNumber: potByNumberInput,
      potByHash: potByHashInput,
      potByTx: potByTxInput,
      potMeta: potMetaInput,
    })
    settingsOpen = false
  }

  let query = $state('')

  function submitSearch(e: SubmitEvent) {
    e.preventDefault()
    const q = query.trim()
    if (q === '') return
    if (/^\d+$/.test(q)) {
      goto(`/block/${q}`)
      return
    }
    const hex = q.toLowerCase().startsWith('0x') ? q.toLowerCase() : `0x${q.toLowerCase()}`
    if (/^0x[0-9a-f]{64}$/.test(hex)) {
      goto(`/lookup/${hex}`)
      return
    }
    alert('Enter a block number, block hash, or transaction hash.')
  }
</script>

<div class="min-h-screen bg-background text-foreground">
  <header
    class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
  >
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
      <a href="/" class="flex items-center gap-2 text-sm font-semibold">
        <span
          class="inline-flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold"
          >FC</span
        >
        <span>FullCircle</span>
        <span class="text-muted-foreground font-normal">explorer</span>
      </a>

      <form class="flex min-w-0 flex-1 items-center gap-2" onsubmit={submitSearch}>
        <div class="relative flex-1">
          <SearchIcon
            class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            placeholder="Block # / block hash / tx hash"
            class="pl-8 font-mono"
            bind:value={query}
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <Button type="submit" size="sm">Search</Button>
      </form>

      <Button type="button" variant="outline" size="sm" onclick={() => (settingsOpen = true)}>
        <SettingsIcon />
        Settings
      </Button>
    </div>

    {#if hasSource()}
      <div class="border-t">
        <div
          class="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-5 py-1.5 text-xs text-muted-foreground"
        >
          <Badge variant="outline" class="font-mono">
            bee · {settings.beeUrl.replace(/^https?:\/\//, '')}
          </Badge>
          <Badge variant="secondary" class="font-mono">
            {sourceLabel()}
          </Badge>
        </div>
      </div>
    {/if}
  </header>

  <Dialog.Root bind:open={settingsOpen}>
    <Dialog.Content class="max-h-[90vh] overflow-y-auto">
      <form onsubmit={submitSettings} class="flex flex-col gap-4">
        <Dialog.Header>
          <Dialog.Title>Source</Dialog.Title>
          <Dialog.Description>
            Point the explorer at a Bee gateway and either a Mantaray manifest or a POT index.
          </Dialog.Description>
        </Dialog.Header>

        <div class="flex flex-col gap-2">
          <Label for="bee-url">Bee gateway URL</Label>
          <Input
            id="bee-url"
            type="url"
            bind:value={beeInput}
            placeholder="http://localhost:1633"
          />
        </div>

        <div class="flex flex-col gap-2">
          <Label>Index type</Label>
          <div class="flex gap-4 text-sm">
            <label class="flex items-center gap-2">
              <input
                type="radio"
                name="source"
                value="manifest"
                checked={sourceInput === 'manifest'}
                onchange={() => (sourceInput = 'manifest')}
              />
              <span>Mantaray manifest</span>
            </label>
            <label class="flex items-center gap-2">
              <input
                type="radio"
                name="source"
                value="pot"
                checked={sourceInput === 'pot'}
                onchange={() => (sourceInput = 'pot')}
              />
              <span>POT indexes</span>
            </label>
          </div>
        </div>

        {#if sourceInput === 'manifest'}
          <div class="flex flex-col gap-2">
            <Label for="manifest-ref">Manifest reference</Label>
            <Input
              id="manifest-ref"
              type="text"
              bind:value={manifestInput}
              placeholder="64-character hex"
              spellcheck="false"
              class="font-mono"
            />
          </div>
        {:else}
          <div class="flex flex-col gap-3 rounded-md border p-3">
            <p class="text-xs text-muted-foreground">
              Paste the four refs printed by <code class="font-mono">pnpm era:upload-pot</code> (or
              read from <code class="font-mono">eras-*.pot.json</code>).
            </p>
            <div class="flex flex-col gap-2">
              <Label for="pot-by-number">byNumber</Label>
              <Input
                id="pot-by-number"
                type="text"
                bind:value={potByNumberInput}
                placeholder="64-character hex"
                spellcheck="false"
                class="font-mono"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="pot-by-hash">byHash</Label>
              <Input
                id="pot-by-hash"
                type="text"
                bind:value={potByHashInput}
                placeholder="64-character hex"
                spellcheck="false"
                class="font-mono"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="pot-by-tx"
                >byTx <span class="text-muted-foreground">(optional)</span></Label
              >
              <Input
                id="pot-by-tx"
                type="text"
                bind:value={potByTxInput}
                placeholder="64-character hex (all-zeros when no tx indexed)"
                spellcheck="false"
                class="font-mono"
              />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="pot-meta"
                >meta <span class="text-muted-foreground">(optional)</span></Label
              >
              <Input
                id="pot-meta"
                type="text"
                bind:value={potMetaInput}
                placeholder="64-character hex"
                spellcheck="false"
                class="font-mono"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              First load of a POT session downloads ~15 MB of WASM.
            </p>
          </div>
        {/if}

        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={() => (settingsOpen = false)}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>

  {@render children()}
</div>
