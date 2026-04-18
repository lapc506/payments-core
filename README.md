# payments-core

**One payments sidecar for the whole `-core` ecosystem.**

gRPC sidecar that centralizes payment intents, subscriptions, escrow, refunds, disputes, reconciliation, and agentic commerce across a portfolio of LATAM startups. Written in TypeScript, deployed as a Kubernetes sidecar or standalone Docker container.

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](LICENSE.md)
[![Status: design](https://img.shields.io/badge/status-design-orange)]()

## The problem

Every startup in the `-core` ecosystem is re-implementing the same flows against Stripe, OnvoPay, Tilopay, dLocal, Apple Pay, Google Pay, Revolut, Convera, and a growing list of rails. The duplication breaks three things at once:

- **Rate limits and retries** collide because each backend speaks to the gateway independently.
- **PCI scope** expands because every backend holds its own Stripe credentials and webhook secrets.
- **Reconciliation** is impossible because there is no single ledger of intents across startups.

## The solution

A single `-core` that speaks gRPC to every backend, owns the state machines (intent, subscription, escrow, payout, refund, dispute), and delegates out to gateway-specific adapters. Backends deploy it as a sidecar (K8s pod) or point to a standalone Docker container.

### Consumers (as of 2026-04-18)

| Consumer | Primary use case |
|---|---|
| `dojo-os` | Subscriptions, org billing, Stripe webhook |
| `altrupets-api` | Donations (one-time + recurring), potential crowdfunding |
| `habitanexus-api` | Escrow (rental deposits), ACH/SINPE future |
| `vertivolatam-api` | B2B subscriptions, Tilopay CR, Convera cross-border |
| `aduanext-api` | Broker escrow payments, customs duty rails (future) |

## Governance

This repository passed the `-core` governance rubric with a score of **5/5**. The full verdict and the decision trail are in `openspec/changes/governance-rubric-adoption/`. The rubric itself lives at `docs/content/docs/governance/rubric.md` and mirrors the ecosystem-wide governance document.

## Architecture

Hexagonal (Explicit Architecture by Herberto Graça), mirroring `agentic-core`, `invoice-core`, and `marketplace-core`:

```
proto/payments_core.proto     ← single public contract
src/
  domain/       entities, value objects, state machines, ports
  application/  use cases (InitiateCheckout, ProcessWebhook, ReleaseEscrow, ...)
  adapters/
    inbound/grpc/   payments_core.v1 server
    outbound/
      gateways/     stripe/ onvopay/ tilopay/ dlocal/ revolut/ convera/ ripple/
      events/       Kafka/NATS emitter (PaymentSucceeded, RefundIssued, ...)
      persistence/  Postgres repos (idempotency, webhook log, reconciliation)
  shared_kernel/  errors, OTel, logging, circuit breakers
```

See `docs/content/docs/architecture/` for diagrams and the full reasoning.

## Documentation

This repository ships a Material-for-MkDocs site under `docs/`, modeled after the `aduanext` documentation structure. API reference is rendered with [Stoplight Elements](https://stoplight.io/open-source/elements) from the generated OpenAPI descriptor in `openapi/`.

```bash
cd docs
pip install -r requirements.txt
mkdocs serve
```

## OpenSpec workflow

Every significant change lives as an OpenSpec proposal in `openspec/changes/{name}/` with three files: `proposal.md` (why), `design.md` (how), and `tasks.md` (what). Approved changes are applied by subagents dispatched via `/make-no-mistakes:implement` with worktree isolation and full reviewer loops.

See `openspec/AGENTS.md` for the convention.

## License

BSL 1.1 with a Change Date of 2031-04-18 and Change License Apache 2.0. See [LICENSE.md](LICENSE.md).
