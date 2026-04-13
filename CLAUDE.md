# CLAUDE.md

## Project Overview

**FullCircle** is a research project investigating how to store Ethereum blockchain data on Swarm decentralized storage, making it accessible to everyone.

Project issue: https://github.com/ethersphere/swarm-accelerator/issues/5

## Documents

- **[RESEARCH.md](./RESEARCH.md)** -- Technical research: Ethereum data structures, Swarm storage primitives, EIP-4444 history expiry, Portal Network, Era1 file format, prior art, and technical challenges
- **[PROPOSAL.md](./PROPOSAL.md)** -- Implementation proposal: TypeScript tooling, architecture options, and day-by-day PoC plan

## Context

EIP-4444 (history expiry) is now live across all Ethereum clients. Nodes are actively dropping pre-merge history (~300-500 GB), creating urgent demand for decentralized alternatives to preserve and serve this data. Swarm is a natural fit due to its content-addressed chunk model, economic incentives, and erasure coding.

## Key Research Areas

- **Ethereum data formats**: Blocks, state tries, RLP/SSZ encoding, Era1 archive format
- **Swarm primitives**: 4KB chunks, BMT hashing, feeds, Mantaray manifests, postage stamps
- **Prior proposals**: Viktor Tron's state-on-Swarm, Swarm Data Chain, trustless state access
- **Comparison**: Portal Network (altruistic, Ethereum-specific) vs Swarm (incentivized, general-purpose)
- **Challenges**: Data scale (~1 TB+), hash function mismatch (BMT vs Keccak256), retrieval latency, persistence economics

## Related Repos in Workspace

- `../bee-js/` -- Swarm JavaScript SDK (TypeScript, `@ethersphere/bee-js`)
- `../bee/` -- Swarm Bee node (Go)
- `../bee-docs/` -- Swarm documentation (Docusaurus)
