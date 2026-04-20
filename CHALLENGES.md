# Technical Challenges: solution notes

The canonical description of the technical challenges lives in [RESEARCH.md](./RESEARCH.md) section 8.
This file keeps only the incremental solution/implementation notes so the challenge statements do not drift out of sync.

## 8.1 Data Scale

See [RESEARCH.md §8.1](./RESEARCH.md#81-data-scale) for the problem statement.

Additional note: if we want not only historical data but also live access, latency is part of the challenge.

Solution:

- assume header chain
- have a balanced staked subnetwork serving as a Swarm Bridge service (nodes simultaneously running an Eth node with at least a Swarm API client) save data pinned locally to their extended cold store (see 8.2 on how)
- use a DSN registry contract as the source for block -> overlay mapping; optional network location retrieval can be used to pull these out to hot storage (mechanism described in the SWIP on global pinning)
- solves cheap/free storage
- popular nodes go to hot storage only
- no real-time network I/O, just client-local save initially
- closest node to ID read from SBS DSN contract

## 8.2 Hash Function Mismatch

See [RESEARCH.md §8.2](./RESEARCH.md#82-hash-function-mismatch) for the problem statement.

Proposed approach:

- use SOC with `ID = keccak` and `Owner = Closest_SBS(ID)` wrapping the trie node (`CAC ~~ EPAC`)
- basically O(1) index
- mapping validated (only protocol change) whenever retrieved
- preserves pointer-based linking
- provable values all the way through inclusion proofs
- in fact all historical and current data becomes CCIP-able

## 8.3 Retrieval Latency

See [RESEARCH.md §8.3](./RESEARCH.md#83-retrieval-latency) for the problem statement.

Additional note:

- only sync and stamp when repushed to hot storage after retrieval

## 8.4 Indexing

See [RESEARCH.md §8.4](./RESEARCH.md#84-indexing) for the problem statement.

Proposed solution structures:

- Feeds for block-number -> reference mapping
- Manifests for structured access
- Separate index structures built on Swarm

[POT](https://github.com/ethersphere/proximity-order-trie) to the rescue.

## 8.5 Persistence Economics

See [RESEARCH.md §8.5](./RESEARCH.md#85-persistence-economics) for the problem statement.

Additional note:

- see cold store + opportunistic caching of popular nodes + repush hot with stamps

## 8.6 Verification

See [RESEARCH.md §8.6](./RESEARCH.md#86-verification) for the problem statement.

Additional note:

- block headers are supposed to be known
