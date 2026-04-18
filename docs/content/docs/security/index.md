# Security

Security posture for `payments-core`. Payments code is a high-value target:
the bar is higher than for the rest of the ecosystem.

## Scope

- **Secrets management** — how adapter credentials are sourced, rotated, and
  scoped. (landing with `security-secrets-v1`)
- **Webhook verification** — signature validation per provider, replay
  prevention, and timestamp windows. (landing with `security-webhooks-v1`)
- **Idempotency** — request-level and operation-level guarantees; how
  duplicate webhook deliveries are collapsed. (landing with
  `security-idempotency-v1`)
- **PCI scope** — where card data flows, and why `payments-core` never
  touches a PAN directly.
- **Audit + observability** — structured event log and correlation IDs
  across the request → adapter → provider round trip.

Until those pages land, threat modeling lives inline in each change's
`design.md`.
