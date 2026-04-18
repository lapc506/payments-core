# Proposal — Tilopay adapter (P1)

## Context

Tilopay is a Costa-Rican payments gateway with a specific niche in the ecosystem's consumer set: **B2B card flows** for CR corporate merchants. Where OnvoPay leans consumer-card-oriented, Tilopay is the preferred rail for business-to-business card acceptance, including higher-ticket invoicing and recurring B2B arrangements. It publishes an SDK and a Postman collection for API exploration.

The immediate consumer committed for Tilopay is `vertivolatam-api` — a LATAM-focused vertical-SaaS serving CR corporate customers whose finance teams prefer a CR-native gateway with B2B tooling. `aduanext-api` also benefits from Tilopay for Flow B (subscription) when the customer is a CR customs agency that prefers Tilopay over Stripe.

## Why P1 (not P0)

Stripe and OnvoPay together cover the critical mass of consumer-facing flows at launch. Tilopay unlocks a specific B2B segment but no consumer is blocked on it the day Stripe + OnvoPay go live. Landing Tilopay as P1 lets us stabilize the port surface against two adapters before the third lands, reducing the risk of late-breaking port changes that would churn the early adopters.

## Scope

Adapter files under `src/adapters/outbound/tilopay/`:

- `tilopay-client-factory.ts` — single construction site.
- `tilopay-http-client.ts` — wrapper around Tilopay's SDK if a Node SDK is published (TODO: verify against Tilopay developer docs at implementation time), otherwise a hand-written HTTP client validated against the published Postman collection.
- `tilopay-adapter.ts` — implements `PaymentGatewayPort`.
- `tilopay-subscription-adapter.ts` — implements `SubscriptionPort` (B2B recurring).
- `tilopay-webhook-verifier.ts` — implements `WebhookVerifierPort` (TODO: verify signature mechanism).
- `tilopay-reconciliation-reader.ts` — implements `ReconciliationReaderPort`.
- `tilopay-error-mapper.ts`, `tilopay-event-translator.ts`.

### Source material

Implementation is driven by two artifacts:

1. **Tilopay SDK** — if a maintained Node SDK exists, it is the preferred path. Otherwise a hand-written HTTP client is used.
2. **Tilopay Postman collection** — Tilopay publishes a Postman collection for their REST API. The collection is the authoritative source for endpoint shapes, headers, and example payloads. The implementer imports it, runs the happy paths against Tilopay's sandbox, and reverse-models the types from successful responses.

Both must be re-verified at implementation time; TODOs in `design.md` mark every field shape that was assumed rather than verified.

## Out of scope

- B2C flows not already covered by OnvoPay. If a consumer needs a B2C CR rail, it uses OnvoPay. Tilopay + OnvoPay are deliberately segmented to avoid double-maintenance.
- Tilopay's invoicing / billing features (Tilopay has its own invoice module; `invoice-core` owns the ecosystem's fiscal documents).
- Merchant onboarding. Handled on Tilopay's dashboard.

## Alternatives rejected

- **Skip Tilopay, push B2B flows through Stripe** — rejected. Stripe's acceptance rates for CR B2B cards are lower than Tilopay's for the same volume; a CR-native B2B gateway materially improves conversion for Vertivolatam and AduaNext customers.
- **Combine Tilopay + OnvoPay into a single "CR-local" adapter** — rejected. Different merchant segments, different APIs, different onboarding; combining them would hide the routing decision rather than clarify it.
- **Defer Tilopay entirely until a second B2B consumer appears** — rejected. Vertivolatam is committed; deferring blocks their launch.

## Acceptance

1. `src/adapters/outbound/tilopay/` implements the five ports.
2. The Postman collection is imported, run against sandbox, and the successful-path payloads are the basis for every type in `tilopay-http-client.ts`.
3. Webhook signature verification tested with at least one valid + one tampered fixture.
4. Integration tests (gated by `TILOPAY_*` env vars) cover: successful B2B charge, refund, subscription create + renewal.
5. Documentation page `docs/content/docs/adapters/tilopay.md` includes the doc sources, the access date, and the specific B2B flows covered.
6. Composition root registers Tilopay under the `tilopay` key in `GatewayRegistry`.
7. Vertivolatam's B2B subscription flow and AduaNext's Flow B can route through Tilopay as an alternative to Stripe.
