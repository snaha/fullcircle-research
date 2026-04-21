<script lang="ts">
  import '../app.css'
  import { goto } from '$app/navigation'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { hasManifest, saveSettings, settings } from '$lib/settings.svelte'
  import SearchIcon from '@lucide/svelte/icons/search'
  import SettingsIcon from '@lucide/svelte/icons/settings-2'

  let { children } = $props()

  let beeInput = $state(settings.beeUrl)
  let manifestInput = $state(settings.manifestRef)
  let settingsOpen = $state(!hasManifest())

  function submitSettings(e: SubmitEvent) {
    e.preventDefault()
    saveSettings(beeInput, manifestInput)
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

    {#if hasManifest()}
      <div class="border-t">
        <div
          class="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-5 py-1.5 text-xs text-muted-foreground"
        >
          <Badge variant="outline" class="font-mono">
            bee · {settings.beeUrl.replace(/^https?:\/\//, '')}
          </Badge>
          <Badge variant="secondary" class="font-mono">
            manifest · {settings.manifestRef.slice(0, 10)}…{settings.manifestRef.slice(-6)}
          </Badge>
        </div>
      </div>
    {/if}
  </header>

  <Dialog.Root bind:open={settingsOpen}>
    <Dialog.Content>
      <form onsubmit={submitSettings} class="flex flex-col gap-4">
        <Dialog.Header>
          <Dialog.Title>Source</Dialog.Title>
          <Dialog.Description>
            Point the explorer at a Bee gateway and a Mantaray manifest reference.
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
