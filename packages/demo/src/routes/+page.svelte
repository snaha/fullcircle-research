<script lang="ts">
  import { onMount } from 'svelte'

  import { DEFAULT_RPC_URL, makeClient } from '$lib/client'

  type BlockResult = Awaited<ReturnType<ReturnType<typeof makeClient>['getBlock']>>

  let rpcUrl = $state(DEFAULT_RPC_URL)
  let client = $derived(makeClient(rpcUrl))

  let latest = $state<bigint | null>(null)
  let latestError = $state<string | null>(null)
  let latestLoading = $state(false)

  let blockInput = $state('0')
  let hashInput = $state('')
  let block = $state<BlockResult | null>(null)
  let blockError = $state<string | null>(null)
  let blockLoading = $state(false)

  async function refreshLatest() {
    latestLoading = true
    latestError = null
    try {
      latest = await client.getBlockNumber({ cacheTime: 0 })
    } catch (err) {
      latestError = err instanceof Error ? err.message : String(err)
    } finally {
      latestLoading = false
    }
  }

  async function fetchByNumber() {
    blockLoading = true
    blockError = null
    block = null
    try {
      const n = BigInt(blockInput)
      block = await client.getBlock({ blockNumber: n })
    } catch (err) {
      blockError = err instanceof Error ? err.message : String(err)
    } finally {
      blockLoading = false
    }
  }

  async function fetchByHash() {
    blockLoading = true
    blockError = null
    block = null
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hashInput)) {
        throw new Error('hash must be a 0x-prefixed 32-byte hex string')
      }
      block = await client.getBlock({ blockHash: hashInput as `0x${string}` })
    } catch (err) {
      blockError = err instanceof Error ? err.message : String(err)
    } finally {
      blockLoading = false
    }
  }

  function stringify(value: unknown): string {
    return JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    )
  }

  onMount(() => {
    void refreshLatest()
  })
</script>

<main>
  <header>
    <h1>FullCircle RPC demo</h1>
    <p class="muted">
      SvelteKit + viem client talking to a local <code>@fullcircle/rpc</code> server that
      replays mainnet history from <code>data/</code>.
    </p>
  </header>

  <section class="card">
    <h2>RPC endpoint</h2>
    <label class="row">
      <span>URL</span>
      <input type="url" bind:value={rpcUrl} placeholder="http://127.0.0.1:8545" />
    </label>
  </section>

  <section class="card">
    <h2>eth_blockNumber</h2>
    <div class="row">
      <button type="button" onclick={refreshLatest} disabled={latestLoading}>
        {latestLoading ? 'fetching…' : 'Refresh'}
      </button>
      {#if latest !== null}
        <span class="mono">{latest.toString()} (0x{latest.toString(16)})</span>
      {/if}
    </div>
    {#if latestError}
      <p class="error">{latestError}</p>
    {/if}
  </section>

  <section class="card">
    <h2>Fetch a block</h2>
    <div class="row">
      <label class="grow">
        <span>By number</span>
        <input type="text" bind:value={blockInput} placeholder="0" />
      </label>
      <button type="button" onclick={fetchByNumber} disabled={blockLoading}>
        eth_getBlockByNumber
      </button>
    </div>
    <div class="row">
      <label class="grow">
        <span>By hash</span>
        <input type="text" bind:value={hashInput} placeholder="0x…" />
      </label>
      <button type="button" onclick={fetchByHash} disabled={blockLoading}>
        eth_getBlockByHash
      </button>
    </div>

    {#if blockError}
      <p class="error">{blockError}</p>
    {/if}
    {#if block}
      <dl class="summary">
        <dt>number</dt>
        <dd class="mono">{block.number?.toString()}</dd>
        <dt>hash</dt>
        <dd class="mono break">{block.hash}</dd>
        <dt>timestamp</dt>
        <dd class="mono">{block.timestamp?.toString()}</dd>
        <dt>miner</dt>
        <dd class="mono break">{block.miner}</dd>
        <dt>transactions</dt>
        <dd class="mono">{block.transactions.length}</dd>
        <dt>gasUsed / gasLimit</dt>
        <dd class="mono">{block.gasUsed?.toString()} / {block.gasLimit?.toString()}</dd>
      </dl>
      <details>
        <summary>Full response</summary>
        <pre>{stringify(block)}</pre>
      </details>
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 860px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.75rem;
  }

  header p {
    margin: 0;
  }

  .muted {
    color: var(--muted);
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
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .row label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .row label.grow {
    flex: 1 1 320px;
  }

  .row label span {
    font-size: 0.85rem;
    color: var(--muted);
    min-width: 72px;
  }

  .row label input {
    flex: 1 1 auto;
  }

  .mono {
    font-family: var(--mono);
    font-size: 0.9rem;
  }

  .break {
    word-break: break-all;
  }

  .error {
    color: #b91c1c;
    margin: 0;
    font-family: var(--mono);
    font-size: 0.85rem;
  }

  .summary {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 1rem;
    margin: 0;
  }

  .summary dt {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .summary dd {
    margin: 0;
  }

  pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem;
    overflow: auto;
    font-family: var(--mono);
    font-size: 0.8rem;
    max-height: 420px;
  }
</style>
