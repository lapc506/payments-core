# Architecture

`payments-core` follows a hexagonal (ports-and-adapters) architecture. The
domain model knows nothing about Stripe, OnvoPay, TiloPay, dLocal, Revolut,
Convera, Ripple, or Apple/Google Pay. All those live as adapters on the outside
edge, behind ports defined in the application layer.

## The layers

- **Domain** — pure types and invariants: `Payment`, `Donation`, `Transfer`,
  `Refund`, and their state machines. No I/O.
- **Application** — use-cases that orchestrate domain operations. Defines the
  port interfaces every adapter must satisfy.
- **Ports** — abstract interfaces (gRPC-facing on the inbound side, adapter
  contracts on the outbound side).
- **Adapters** — concrete implementations: payment providers, wallets, KYC
  hooks, outbox writers, webhook receivers.

## What lands here

Detailed pages for the domain model, the application layer, and each port
land with their owning OpenSpec changes (`domain-model-v1`,
`application-core-v1`, `ports-*`). This index page stays as an orientation
map; deep-dive pages link from here as they arrive.
