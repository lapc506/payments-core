# Consumers

Consumer applications that speak the `payments-core` gRPC contract. Each gets
a dedicated page once its integration lands. Until then they are listed here
as plain-text references.

## Product surfaces

- dojo-os — learning platform; uses `payments-core` for tier upgrades, course
  purchases, and creator payouts.
- altrupets — pet welfare marketplace; uses `payments-core` for donation
  flows and marketplace settlements.
- habitanexus — real-estate connector; uses `payments-core` for deposit and
  rental collection.
- vertivolatam — LATAM verticals umbrella; uses `payments-core` for
  cross-vertical revenue consolidation.
- aduanext — customs compliance platform; uses `payments-core` for duty-fee
  collection and agent payouts.

Each consumer page will document: which ports it exercises, which adapters
it prefers per region, its idempotency strategy, and its failure-handling
story.
