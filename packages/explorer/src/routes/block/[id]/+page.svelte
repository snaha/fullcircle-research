<script lang="ts">
  import { page } from '$app/state'
  import { formatEth, formatGwei, formatTimestamp, hexByteLength, relativeTime, shortHash } from '$lib/format'
  import { hasManifest, settings } from '$lib/settings.svelte'
  import { fetchBlock, type FetchedBlock } from '$lib/swarm'

  let id = $derived(page.params.id ?? '')
  let index = $derived<'number' | 'hash'>(/^\d+$/.test(id) ? 'number' : 'hash')

  let block = $state<FetchedBlock | null>(null)
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
    try {
      block = await fetchBlock(index, id, settings)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void id
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
    <span>Block {id}</span>
  </nav>

  {#if loading}
    <p class="muted">Loading block…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if block}
    {@const h = block.header}
    <header class="block-head">
      <h1>Block <span class="mono">#{h.number}</span></h1>
      <p class="muted mono break">{block.hash}</p>
      <p class="muted">
        {formatTimestamp(h.timestamp)}
        <span class="sep">·</span>
        {relativeTime(h.timestamp)}
      </p>
    </header>

    <section class="card">
      <h2>Overview</h2>
      <dl>
        <dt>Block height</dt>
        <dd class="mono">{h.number}</dd>

        <dt>Timestamp</dt>
        <dd class="mono">{formatTimestamp(h.timestamp)} ({h.timestamp})</dd>

        <dt>Transactions</dt>
        <dd class="mono">{block.body.transactions.length}</dd>

        <dt>Miner / fee recipient</dt>
        <dd class="mono break">{h.miner}</dd>

        <dt>Gas used / limit</dt>
        <dd class="mono">
          {h.gasUsed.toLocaleString()} / {h.gasLimit.toLocaleString()}
          {#if h.gasLimit > 0n}
            <span class="muted">({Number((h.gasUsed * 10000n) / h.gasLimit) / 100}%)</span>
          {/if}
        </dd>

        {#if h.baseFeePerGas !== undefined}
          <dt>Base fee</dt>
          <dd class="mono">{formatGwei(h.baseFeePerGas)}</dd>
        {/if}

        <dt>Difficulty</dt>
        <dd class="mono">{h.difficulty.toLocaleString()}</dd>

        {#if block.totalDifficulty !== null}
          <dt>Total difficulty</dt>
          <dd class="mono">{block.totalDifficulty.toLocaleString()}</dd>
        {/if}

        {#if h.number > 0n}
          <dt>Parent hash</dt>
          <dd class="mono break"><a href="/block/{h.number - 1n}">{h.parentHash}</a></dd>
        {:else}
          <dt>Parent hash</dt>
          <dd class="mono break">{h.parentHash}</dd>
        {/if}

        <dt>State root</dt>
        <dd class="mono break">{h.stateRoot}</dd>

        <dt>Transactions root</dt>
        <dd class="mono break">{h.transactionsRoot}</dd>

        <dt>Receipts root</dt>
        <dd class="mono break">{h.receiptsRoot}</dd>

        <dt>Nonce</dt>
        <dd class="mono">{h.nonce}</dd>

        <dt>Extra data</dt>
        <dd class="mono break">
          {h.extraData}
          <span class="muted">({hexByteLength(h.extraData)} bytes)</span>
        </dd>

        {#if h.withdrawalsRoot !== undefined}
          <dt>Withdrawals root</dt>
          <dd class="mono break">{h.withdrawalsRoot}</dd>
        {/if}
        {#if h.blobGasUsed !== undefined}
          <dt>Blob gas used</dt>
          <dd class="mono">{h.blobGasUsed.toLocaleString()}</dd>
        {/if}
        {#if h.excessBlobGas !== undefined}
          <dt>Excess blob gas</dt>
          <dd class="mono">{h.excessBlobGas.toLocaleString()}</dd>
        {/if}
      </dl>
    </section>

    <section class="card">
      <h2>Transactions ({block.body.transactions.length})</h2>
      {#if block.body.transactions.length === 0}
        <p class="muted">No transactions in this block.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th>Hash</th>
              <th>To</th>
              <th>Value</th>
              <th>Gas limit</th>
              <th class="t-right">Type</th>
            </tr>
          </thead>
          <tbody>
            {#each block.body.transactions as tx (tx.hash)}
              <tr>
                <td class="mono">
                  <a href="/tx/{tx.hash}">{shortHash(tx.hash)}</a>
                </td>
                <td class="mono">
                  {#if tx.to === null}
                    <span class="muted">contract creation</span>
                  {:else}
                    {shortHash(tx.to, 10, 6)}
                  {/if}
                </td>
                <td class="mono">{formatEth(tx.value)}</td>
                <td class="mono">{tx.gasLimit.toLocaleString()}</td>
                <td class="t-right mono">{txTypeLabel(tx.type)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
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

  .block-head h1 {
    margin: 0 0 0.25rem;
  }

  .block-head p {
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

  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }

  th,
  td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  th {
    font-weight: 600;
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .t-right {
    text-align: right;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }
</style>
