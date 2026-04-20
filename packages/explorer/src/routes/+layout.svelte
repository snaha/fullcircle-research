<script lang="ts">
  import '../app.css'
  import { goto } from '$app/navigation'
  import { hasManifest, saveSettings, settings } from '$lib/settings.svelte'

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
      // Ambiguous between block hash and tx hash — /lookup disambiguates.
      goto(`/lookup/${hex}`)
      return
    }
    alert('Enter a block number, block hash, or transaction hash.')
  }
</script>

<header class="topbar">
  <div class="brand">
    <a href="/"><strong>FullCircle</strong> <span class="muted">explorer</span></a>
  </div>

  <form class="search" onsubmit={submitSearch}>
    <input
      type="text"
      placeholder="Block # / hash / tx hash"
      bind:value={query}
      autocomplete="off"
      spellcheck="false"
    />
    <button type="submit">Search</button>
  </form>

  <button type="button" class="gear" onclick={() => (settingsOpen = !settingsOpen)}>
    ⚙ Settings
  </button>
</header>

{#if settingsOpen}
  <div class="settings-panel">
    <form onsubmit={submitSettings}>
      <label>
        <span>Bee gateway URL</span>
        <input type="url" bind:value={beeInput} placeholder="http://localhost:1633" />
      </label>
      <label>
        <span>Manifest reference (64 hex chars)</span>
        <input
          type="text"
          bind:value={manifestInput}
          placeholder="<manifest hex>"
          spellcheck="false"
        />
      </label>
      <button type="submit">Save</button>
    </form>
  </div>
{/if}

{@render children()}

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    position: sticky;
    top: 0;
    z-index: 1;
    flex-wrap: wrap;
  }

  .brand a {
    color: inherit;
    text-decoration: none;
  }

  .brand .muted {
    color: var(--muted);
  }

  .search {
    display: flex;
    gap: 0.5rem;
    flex: 1 1 320px;
  }

  .search input {
    flex: 1 1 auto;
    font-family: var(--mono);
    font-size: 0.9rem;
  }

  .gear {
    white-space: nowrap;
  }

  .settings-panel {
    padding: 1rem 1.25rem;
    background: var(--card);
    border-bottom: 1px solid var(--border);
  }

  .settings-panel form {
    display: grid;
    grid-template-columns: 1fr 2fr auto;
    gap: 0.75rem;
    align-items: end;
    max-width: 1100px;
    margin: 0 auto;
  }

  .settings-panel label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .settings-panel label span {
    font-size: 0.8rem;
    color: var(--muted);
  }

  @media (max-width: 720px) {
    .settings-panel form {
      grid-template-columns: 1fr;
    }
  }
</style>
