<script lang="ts">
  import { page } from '$app/state'
  import { formatEth, formatGwei, formatTimestamp, hexByteLength, relativeTime, shortHash } from '$lib/format'
  import { hasManifest, settings } from '$lib/settings.svelte'
  import { fetchBlock, type FetchedBlock } from '$lib/swarm'
  import type { DecodedTransaction } from '@fullcircle/era/bundle'

  let hash = $derived((page.params.hash ?? '').toLowerCase())

  let block = $state<FetchedBlock | null>(null)
  let tx = $state<DecodedTransaction | null>(null)
  let txIndex = $state<number>(-1)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    if (!hasManifest()) {
      error = 'No manifest reference set — open Settings above.'
      return
    }
    loading = true
    error = null
    block = null
    tx = null
    txIndex = -1
    try {
      // /tx/<hash> in the manifest returns the bundle of the block containing
      // this tx. We then locate the tx within the bundle's body.
      block = await fetchBlock('tx', hash, settings)
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
    void settings.manifestRef
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

<main>
  <nav class="crumbs">
    <a href="/">Home</a>
    <span class="sep">›</span>
    <span>Transaction</span>
  </nav>

  {#if loading}
    <p class="muted">Loading transaction…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if tx && block}
    <header class="tx-head">
      <h1>Transaction</h1>
      <p class="muted mono break">{tx.hash}</p>
    </header>

    <section class="card">
      <h2>Overview</h2>
      <dl>
        <dt>Block</dt>
        <dd class="mono">
          <a href="/block/{block.header.number}">#{block.header.number}</a>
          <span class="muted"> · index {txIndex} of {block.body.transactions.length}</span>
        </dd>

        <dt>Timestamp</dt>
        <dd class="mono">
          {formatTimestamp(block.header.timestamp)}
          <span class="muted">({relativeTime(block.header.timestamp)})</span>
        </dd>

        <dt>Type</dt>
        <dd class="mono">{txTypeLabel(tx.type)} (type {tx.type})</dd>

        <dt>Nonce</dt>
        <dd class="mono">{tx.nonce}</dd>

        <dt>To</dt>
        <dd class="mono break">
          {#if tx.to === null}
            <span class="muted">contract creation</span>
          {:else}
            {tx.to}
          {/if}
        </dd>

        <dt>Value</dt>
        <dd class="mono">{formatEth(tx.value)}</dd>

        <dt>Gas limit</dt>
        <dd class="mono">{tx.gasLimit.toLocaleString()}</dd>

        {#if tx.gasPrice !== undefined}
          <dt>Gas price</dt>
          <dd class="mono">{formatGwei(tx.gasPrice)}</dd>
        {/if}

        {#if tx.maxFeePerGas !== undefined}
          <dt>Max fee / gas</dt>
          <dd class="mono">{formatGwei(tx.maxFeePerGas)}</dd>
        {/if}

        {#if tx.maxPriorityFeePerGas !== undefined}
          <dt>Max priority fee / gas</dt>
          <dd class="mono">{formatGwei(tx.maxPriorityFeePerGas)}</dd>
        {/if}

        {#if tx.chainId !== undefined}
          <dt>Chain ID</dt>
          <dd class="mono">{tx.chainId}</dd>
        {/if}
      </dl>
    </section>

    <section class="card">
      <h2>Input data ({hexByteLength(tx.input)} bytes)</h2>
      {#if tx.input === '0x' || tx.input === ''}
        <p class="muted">(empty)</p>
      {:else}
        <pre class="input">{tx.input}</pre>
      {/if}
    </section>

    <section class="card">
      <h2>Signature</h2>
      <dl>
        {#if tx.v !== undefined}
          <dt>v</dt>
          <dd class="mono">{tx.v}</dd>
        {/if}
        {#if tx.r !== undefined}
          <dt>r</dt>
          <dd class="mono break">{tx.r}</dd>
        {/if}
        {#if tx.s !== undefined}
          <dt>s</dt>
          <dd class="mono break">{tx.s}</dd>
        {/if}
      </dl>
      <details>
        <summary>Raw ({hexByteLength(tx.raw)} bytes)</summary>
        <pre class="input">{tx.raw}</pre>
      </details>
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .crumbs {
    font-size: 0.85rem;
    color: var(--muted);
    display: flex;
    gap: 0.4rem;
  }

  .tx-head h1 {
    margin: 0 0 0.25rem;
  }

  .tx-head p {
    margin: 0.25rem 0 0;
  }

  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--error);
    font-family: var(--mono);
    font-size: 0.9rem;
  }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .card h2 {
    margin: 0;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.4rem 1rem;
    margin: 0;
  }

  dt {
    color: var(--muted);
    font-size: 0.85rem;
  }

  dd {
    margin: 0;
  }

  .mono {
    font-family: var(--mono);
    font-size: 0.9rem;
  }

  .break {
    word-break: break-all;
  }

  .sep {
    color: var(--muted);
  }

  .input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem;
    overflow: auto;
    font-family: var(--mono);
    font-size: 0.78rem;
    max-height: 360px;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }
</style>
