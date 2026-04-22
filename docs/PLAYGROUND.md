# FullCircle Playground

A self-hosted Swarm + Ethereum dev cluster, tailored to FullCircle's upload /
indexing workload. Replaces our dependency on `@fairdatasociety/fdp-play`.

Goals, roughly in order of importance:

1. **Current Bee.** Run the latest upstream `ethersphere/bee` release within
   days of publication. FDP's published images lag by months.
2. **Durable data.** Named volumes so a version bump never detaches the
   localstore or statestore (as the anon-volume fdp-play setup does today).
3. **Minimal surface.** Just Bee + the chain it needs for postage stamps.
   Drop FairOS, FDP contracts, dev auth shells, and everything else we don't
   use.
4. **Queen always; workers on demand.** Queen alone is enough for PoC upload
   and retrieval testing. Workers are opt-in via a compose profile for when
   we want to exercise syncing / multi-peer retrieval.
5. **Automated image pipeline.** A GitHub Action watches upstream Bee releases
   and publishes a matching `fullcircle-bee` image within hours.

---

## What we keep from fdp-play (and what we drop)

| Component | Status | Reason |
|---|---|---|
| `ethersphere/bee` upstream image | **keep** (as base) | The actual node binary. |
| Pre-generated keys per role | **drop** | Generate at first boot in an entrypoint — keeps images identity-free and reusable. |
| Multi-role pre-built images (queen/worker-1..N) | **drop** | One image, role selected by env var. |
| `fairdatasociety/fdp-play-blockchain` | **keep (as-is, reuse)** | It's a geth node with custom genesis + pre-deployed Swarm contracts at known addresses. Rebuilding this is a whole subproject. Use their published image verbatim until forced to fork. |
| FairOS / FDP-contracts layer | **drop** | Unused. |
| `fdp-play` CLI (dockerode orchestration) | **drop** | Plain `docker compose` does everything we need. |
| Anonymous Docker volumes | **drop** | Named volumes, always. |
| `--fresh` / `--pull` / `--detach` flags | **keep (via compose)** | `docker compose pull`, `docker compose down -v`, `docker compose up -d`. |

The one risky assumption is item 4: we're betting that FDP keeps publishing
their blockchain image at a usable cadence. If it stalls, we'd need to rebuild
it — see "Risks" below for the escape hatch.

---

## Architecture

```
docker-compose.yml
├── blockchain              fairdatasociety/fdp-play-blockchain:latest
│                           geth, custom chain (id 4020), Swarm contracts pre-deployed
│                           ports: 127.0.0.1:9545 (RPC)
│                           volume: fullcircle-chain (persisted)
│
├── queen                   ghcr.io/<owner>/fullcircle-bee:<bee-version>
│                           depends_on: blockchain
│                           ports: 127.0.0.1:1633 (API), 127.0.0.1:1634 (P2P)
│                           volume: fullcircle-queen
│                           env: ROLE=queen
│
└── worker-{1..N}           ghcr.io/<owner>/fullcircle-bee:<bee-version>
    (profile: workers)      depends_on: queen
                            ports: 127.0.0.1:1733+N (API)
                            volume: fullcircle-worker-{N}
                            env: ROLE=worker, BOOTNODE=queen
```

Default `docker compose up -d` brings up blockchain + queen. `docker compose
--profile workers up -d` adds 4 workers. Number of workers configurable via
a single env var (`WORKERS=2`) that gates compose profile activation + scales
— we'll wire this with `deploy.replicas` or a `scripts/up.sh` helper.

---

## Our Bee image

A thin layer on upstream. Dockerfile sketch:

```dockerfile
ARG BEE_VERSION
FROM ethersphere/bee:${BEE_VERSION}

COPY entrypoint.sh /entrypoint.sh
COPY bee.yaml.tpl /etc/bee/bee.yaml.tpl

ENTRYPOINT ["/entrypoint.sh"]
CMD ["start"]
```

`entrypoint.sh`:

1. Read `ROLE` (queen | worker), `BOOTNODE`, `BLOCKCHAIN_RPC`, `CHAIN_ID`.
2. If `/home/bee/.bee/keys/` is empty, run `bee init` to generate node identity.
3. Render `/etc/bee/bee.yaml` from the template, substituting:
   - `swap-endpoint`: `http://blockchain:9545`
   - `blockchain-rpc-endpoint`: same
   - `postage-stamp-start-block`, contract addresses (match the FDP chain)
   - `bootnodes`: empty for queen, queen's P2P address for workers
   - `full-node: false` for workers (light node), `true` for queen
4. `exec bee start --config /etc/bee/bee.yaml`

Everything is parametric via env vars — no pre-baked state, no role-specific
Dockerfiles. One image, published per upstream Bee version.

### Image tags

- `ghcr.io/<owner>/fullcircle-bee:<bee-version>` — pinned (e.g. `2.7.1`)
- `ghcr.io/<owner>/fullcircle-bee:latest` — moving, points at newest upstream
- `ghcr.io/<owner>/fullcircle-bee:<bee-version>-<short-sha>` — reproducible
  rebuild trail when we change `entrypoint.sh` without a Bee bump

---

## CI: auto-publish on Bee release

Two GitHub Actions workflows:

### `build-bee-image.yml` — the builder

Triggers:
- `workflow_dispatch` with input `bee_version` (manual override, e.g. to
  rebuild with an `entrypoint.sh` fix)
- `repository_dispatch` event `new-bee-release` dispatched by the watcher

Steps:
- Checkout this repo
- `docker buildx` for linux/amd64 + linux/arm64 (Macs need arm64)
- Build `ghcr.io/<owner>/fullcircle-bee:${BEE_VERSION}` with `--build-arg
  BEE_VERSION=${BEE_VERSION}`
- Also tag `:latest` if the input version equals the latest upstream tag
- Push to GHCR using `GITHUB_TOKEN` (no extra secret needed)
- Smoke test: `docker run --rm image bee version` matches expected

### `watch-bee-releases.yml` — the watcher

Triggers:
- `schedule: cron: '0 */6 * * *'` (every 6 hours)
- `workflow_dispatch` for manual poll

Steps:
- `gh api repos/ethersphere/bee/releases/latest` → extract `tag_name`
- Compare against our `ghcr.io/<owner>/fullcircle-bee:latest` manifest label
- If different: `gh api /repos/<us>/.../dispatches` with
  `event_type=new-bee-release` and `client_payload.bee_version`

Skip release candidates (`-rc`, `-beta`) by default; only publish on clean
semver tags. A separate manual dispatch covers the RC case when we want to
test pre-releases.

Both workflows live in `.github/workflows/`. No external CI, no third-party
secrets.

---

## Postage stamp bootstrap

The FDP chain starts with Swarm contracts at fixed addresses, but no stamps
are pre-purchased. Our current flow is: node boots → user `curl`s
`/stamps/<amount>/<depth>` to buy one → 5-second wait for on-chain settlement
→ stamp ID ready.

Add `scripts/buy-stamp.sh` that does this for the queen and prints the
resulting batch ID. Not auto-run — it's still faster than getting DNS
resolution on "why is my upload hanging" after the stamp expires.

Optional later: a `stamps` compose service with a healthcheck that polls the
queen's `/stamps` endpoint and buys one if missing. Not needed for PoC.

---

## Data layout

Named volumes under a `fullcircle-` prefix so they're easy to spot:

```
fullcircle-chain              /root           (geth data dir)
fullcircle-queen              /home/bee/.bee  (localstore + statestore + keys)
fullcircle-worker-1           /home/bee/.bee
fullcircle-worker-2           /home/bee/.bee
...
```

Backup convenience: `scripts/backup-bee.sh <service-name>` wraps `docker run
--rm -v fullcircle-<name>:/src -v "$PWD/backups:/dst" alpine tar czf
/dst/<name>-$(date +%F).tgz -C /src .`. Cheap insurance before a version
bump.

---

## Migration from fdp-play

One-time script: `scripts/migrate-from-fdp-play.sh`.

1. Stop fdp-play: `pnpm bee:stop`
2. Copy data out of the anonymous volume: `docker cp
   fdp-play-queen:/home/bee/.bee ./backups/fdp-play-queen`
3. Bring up our compose: `docker compose up -d blockchain queen`
4. Stop our queen before it writes much: `docker compose stop queen`
5. Restore: `docker run --rm -v fullcircle-queen:/dst -v
   "$PWD/backups/fdp-play-queen:/src" alpine cp -a /src/. /dst/`
6. Start: `docker compose start queen`

Caveat already discussed elsewhere: crossing multiple Bee minors runs
auto-migrations. Keep the backup until the new version has booted clean and
one upload round-trip has succeeded.

---

## Repository layout

```
docker/
├── compose.yml                docker-compose definition
├── bee/
│   ├── Dockerfile             one image, parametric role
│   ├── entrypoint.sh
│   └── bee.yaml.tpl
├── scripts/
│   ├── up.sh                  wrapper: reads WORKERS=N, activates profile
│   ├── down.sh
│   ├── buy-stamp.sh
│   ├── backup-bee.sh
│   └── migrate-from-fdp-play.sh
└── .github/workflows/
    ├── build-bee-image.yml
    └── watch-bee-releases.yml
```

Replace root `package.json` scripts:

```json
"bee:start":        "docker compose -f docker/compose.yml up -d"
"bee:start:full":   "WORKERS=4 docker compose -f docker/compose.yml --profile workers up -d"
"bee:stop":         "docker compose -f docker/compose.yml down"
"bee:logs":         "docker compose -f docker/compose.yml logs -f queen"
"bee:fresh":        "docker compose -f docker/compose.yml down -v && pnpm bee:start"
"bee:stamp":        "docker/scripts/buy-stamp.sh"
```

The `fdp-play` devDependency goes away.

---

## Implementation order

1. **Bee image + compose, queen only.** Dockerfile, entrypoint, bee.yaml
   template, compose with blockchain + queen. Verify upload works end-to-end
   against current Bee release. This is the minimum replacement for `pnpm
   bee:start`.
2. **CI: manual dispatch.** `build-bee-image.yml` with manual input. Publish
   first version to GHCR. Prove the pipeline works before automating.
3. **CI: scheduled watcher.** Add `watch-bee-releases.yml`. Verify it detects
   a new upstream version and triggers a build.
4. **Workers profile.** Add worker service(s), verify they discover the queen
   and sync.
5. **Helper scripts.** `buy-stamp.sh`, `backup-bee.sh`, `migrate-from-fdp-play.sh`.
6. **Kill fdp-play dep.** Drop from `package.json`, update CLAUDE.md and
   README.

Each step is independently mergeable; the project is usable with just steps 1
+ 2.

---

## Risks and escape hatches

- **FDP blockchain image goes stale.** Contract ABIs change, new Bee refuses
  to start. Mitigation: fork `fdp-play/orchestrator/builder/blockchain/` —
  it's a geth Dockerfile + genesis.json + a hardhat deploy against geth's
  dev mode. ~1 day of work, not a blocker but a meaningful forklift. Flag
  early if we see deprecation warnings in queen logs.
- **arm64 base image missing.** `ethersphere/bee` publishes arm64 builds;
  verify during step 1. If not, we drop to amd64-only and note it.
- **GHCR pull rate limits for unauthenticated CI.** Unlikely given the
  volume, but fallback is Docker Hub under a personal namespace.
- **Config drift between our `bee.yaml.tpl` and upstream defaults.** New
  Bee versions may add required settings. Mitigation: the CI smoke test
  should try `bee start --help` against the new image and fail fast, plus
  we review changelogs on the release that the watcher picked up.
