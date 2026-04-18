# Integrations

How `payments-core` plugs into the rest of the `-core` ecosystem and into
external consumer applications.

## Sibling `-core` services

- **agentic-core** — agent orchestration surface; uses `payments-core` to
  charge for agent actions and to pay out creator revenue. (landing with
  `integration-agentic-core`)
- **marketplace-core** — marketplace primitives (listings, orders); uses
  `payments-core` for escrow-backed split payments. (landing with
  `integration-marketplace-core`)
- **invoice-core** — invoicing + receivables; uses `payments-core` as the
  collection rail. (landing with `integration-invoice-core`)
- **compliance-core** — KYC/AML orchestration; `payments-core` calls it via
  the `KycPort` for high-value transactions. (landing with
  `integration-compliance-core`)

## Consumer applications

See [Consumers](consumers/index.md) for the five product surfaces that
currently speak to `payments-core`: dojo-os, altrupets, habitanexus,
vertivolatam, aduanext.
