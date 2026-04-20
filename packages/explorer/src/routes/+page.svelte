<script lang="ts">
  import { hasManifest, settings } from '$lib/settings.svelte'
</script>

<main>
  <section class="hero">
    <h1>FullCircle block explorer</h1>
    <p class="muted">
      Browse Ethereum blocks served from Swarm. Block data is fetched directly from a Bee
      gateway through a Mantaray manifest uploaded by
      <code>@fullcircle/era</code>.
    </p>
  </section>

  <section class="card">
    <h2>Current source</h2>
    {#if hasManifest()}
      <dl>
        <dt>Bee gateway</dt>
        <dd class="mono">{settings.beeUrl}</dd>
        <dt>Manifest</dt>
        <dd class="mono break">{settings.manifestRef}</dd>
      </dl>
      <p class="muted">Use the search bar above — try block <a href="/block/0">0</a>.</p>
    {:else}
      <p>
        Open <strong>Settings</strong> and paste the manifest reference printed by
        <code>pnpm era:upload</code>.
      </p>
    {/if}
  </section>

  <section class="card">
    <h2>What's here</h2>
    <ul>
      <li>Block details by number (e.g. <a href="/block/1000">1000</a>) or hash.</li>
      <li>Transaction list per block, decoded client-side from the bundled body.</li>
      <li>Transaction detail pages (<code>/tx/&lt;hash&gt;</code>) with value, gas, and input data.</li>
    </ul>
  </section>
</main>

<style>
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .hero h1 {
    margin: 0 0 0.25rem;
    font-size: 1.75rem;
  }

  .hero p {
    margin: 0;
    max-width: 720px;
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

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 1rem;
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

  ul {
    margin: 0;
    padding-left: 1.25rem;
  }
</style>
