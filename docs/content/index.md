# payments-core

One payments sidecar for the `-core` ecosystem. `payments-core` is a gRPC service
that exposes a uniform payment, donation, and money-movement surface on top of a
swappable set of adapters (Stripe, OnvoPay, TiloPay, dLocal, Revolut Business,
Convera, Ripple/XRPL, Apple Pay, Google Pay). Every consumer — `dojo-os`,
`altrupets`, `habitanexus`, `vertivolatam`, `aduanext` — talks to the same
contract regardless of the underlying rail.

This site documents the contract, the state machines, the adapters, and the
integration story. Deep implementation docs live alongside their owning
OpenSpec changes; this site is the curated, published surface.

## Start here

<div class="grid cards" markdown>

- :material-gavel: **[Governance](docs/governance/index.md)**

    The rubric, decision log, and ADRs that drive what lands in this repo
    and what gets rejected.

- :material-sitemap: **[Architecture](docs/architecture/index.md)**

    Hexagonal layout: domain, application, ports, and adapters. How the
    pieces fit, and why the boundary is where it is.

- :material-api: **[API Reference](docs/api/reference.md)**

    Interactive renderer for `openapi/payments_core.yaml` via Stoplight
    Elements. The gRPC contract mirrored as OpenAPI for readability.

</div>

## Status

`payments-core` is in v0.1 bootstrap. The repository layout, OpenSpec
processes, and documentation site are being established before the first
adapter lands. See the [`openspec/changes/`](https://github.com/lapc506/payments-core/tree/main/openspec/changes)
directory for the current change stack.
