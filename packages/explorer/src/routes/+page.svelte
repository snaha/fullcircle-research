<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { hasManifest, settings } from '$lib/settings.svelte'
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right'
</script>

<main class="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
  <section class="flex flex-col gap-2">
    <h1 class="text-3xl font-semibold tracking-tight">FullCircle block explorer</h1>
    <p class="max-w-2xl text-muted-foreground">
      Browse Ethereum blocks served from Swarm. Block data is fetched directly from a Bee gateway
      through a Mantaray manifest uploaded by <code
        class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">@fullcircle/era</code
      >.
    </p>
  </section>

  <div class="grid gap-4 md:grid-cols-2">
    <Card.Root>
      <Card.Header>
        <Card.Title>Current source</Card.Title>
        <Card.Description>Where this explorer is reading from.</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if hasManifest()}
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Bee gateway</dt>
            <dd class="font-mono break-all">{settings.beeUrl}</dd>
            <dt class="text-muted-foreground">Manifest</dt>
            <dd class="font-mono break-all">{settings.manifestRef}</dd>
          </dl>
        {:else}
          <p class="text-sm text-muted-foreground">
            Open <Badge variant="outline">Settings</Badge> and paste the manifest reference printed by
            <code class="font-mono">pnpm era:upload</code>.
          </p>
        {/if}
      </Card.Content>
      {#if hasManifest()}
        <Card.Footer>
          <Button href="/block/0" variant="secondary" size="sm">
            Jump to block 0
            <ArrowRightIcon />
          </Button>
        </Card.Footer>
      {/if}
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>What's here</Card.Title>
        <Card.Description>Everything the manifest currently serves.</Card.Description>
      </Card.Header>
      <Card.Content>
        <ul class="flex flex-col gap-2 text-sm">
          <li class="flex items-start gap-2">
            <span class="mt-1 size-1.5 rounded-full bg-primary"></span>
            <span>
              Block details by number (e.g. <a
                href="/block/1000"
                class="underline hover:no-underline">1000</a
              >) or hash.
            </span>
          </li>
          <li class="flex items-start gap-2">
            <span class="mt-1 size-1.5 rounded-full bg-primary"></span>
            <span>Transaction list per block, decoded client-side from the bundled body.</span>
          </li>
          <li class="flex items-start gap-2">
            <span class="mt-1 size-1.5 rounded-full bg-primary"></span>
            <span>
              Transaction detail pages (<code class="rounded bg-muted px-1 font-mono text-xs"
                >/tx/&lt;hash&gt;</code
              >) with value, gas, and input data.
            </span>
          </li>
        </ul>
      </Card.Content>
    </Card.Root>
  </div>
</main>
