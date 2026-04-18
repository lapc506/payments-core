# Proposal — dLocal adapter (P2)

## Context

dLocal is a LATAM-focused payments gateway specialized in cross-border acceptance, alternative payment methods (boletos, PIX, OXXO, etc.), and payouts to local beneficiaries across Latin America. dLocal publishes a **Go integration API** and a REST API used by partners across the region.

The committed consumer for dLocal is `aduanext-api` — specifically AduaNext Flow E (cross-border broker/consultant payments), where non-resident importers pay CR freelance brokers or CR pymes pay international consultants. dLocal's strength is corridor coverage (specifically LATAM-to-LATAM and LATAM-inbound cross-border) combined with local payment methods that Stripe and Revolut do not cover as natively.

## Why P2

Stripe (P0) covers most cross-border flows adequately. Revolut and Convera adapters (this wave) cover B2B FX corridors. dLocal differentiates on **alternative payment methods** (PIX, boleto, OXXO, SPEI) and on **payout-to-local-bank** corridors that Stripe does not optimize for. Until AduaNext has a committed non-resident importer using one of those methods, the incremental value is limited. Landing it as P2 keeps it in the roadmap while the P0/P1 changes prove the core pattern.

## Scope

Adapter files under `src/adapters/outbound/dlocal/`:

- `dlocal-client-factory.ts` — single instantiation site.
- `dlocal-http-client.ts` — HTTP wrapper. dLocal's Go integration API is the authoritative reference; the REST endpoints it wraps are documented at https://docs.dlocal.com/ (TODO: verify canonical URL).
- `dlocal-adapter.ts` — implements `PaymentGatewayPort` for cards + alternative payment methods.
- `dlocal-payout-adapter.ts` — implements `PayoutPort`. dLocal's payout corridors are the primary reason to adopt it.
- `dlocal-webhook-verifier.ts` — HMAC verification per dLocal's docs (TODO: verify).
- `dlocal-reconciliation-reader.ts`, `dlocal-error-mapper.ts`, `dlocal-event-translator.ts`.

### Why the Go integration API matters to a TypeScript adapter

dLocal does not publish an official Node SDK (TODO: verify). The Go integration API is the most complete reference implementation and is used internally by dLocal's partner integrations. The adapter author reads the Go source to understand:

- Idempotency header conventions.
- Retry and backoff expectations.
- Webhook verification mechanics.
- Payment-method-specific request shapes (PIX has different fields from boleto from OXXO from card).

The TypeScript adapter is then hand-written against dLocal's REST API, using the Go code as the authoritative reference for edge cases the public REST docs do not cover.

## Out of scope

- **dLocal's dashboard / merchant onboarding** — handled by consumer backends directly with dLocal.
- **Alternative payment methods outside the corridors AduaNext uses** — we ship card + one or two dLocal-preferred APMs relevant to LATAM cross-border. Full APM coverage (every country's local method) is a further-deferred change.
- **Donation flow on dLocal** — not in v1; `DonationPort` supports it additively if Altrupets later needs dLocal for a non-covered country.
- **dLocal's subscription primitive** — corridor coverage for subscriptions is weaker than for one-time; we skip the `SubscriptionPort` impl in v1.

## Alternatives rejected

- **Skip dLocal entirely, route LATAM APMs through Stripe Tax + Stripe's limited LATAM APM coverage** — rejected. Stripe's LATAM APM coverage is incomplete; dLocal's strength is the full corridor map.
- **Build a corridor-abstracting meta-gateway** — rejected. Premature. Each cross-border gateway has specific strengths; a meta-layer would obscure them.
- **Wait for dLocal to publish a Node SDK** — rejected. dLocal has not signaled one; waiting blocks AduaNext's international flows.

## Acceptance

1. `src/adapters/outbound/dlocal/` implements `PaymentGatewayPort` and `PayoutPort`.
2. The dLocal Go integration API (linked in `docs/content/docs/adapters/dlocal.md`) is documented as the reference source, with an access-date log.
3. Webhook verification tested with both a valid and a tampered fixture.
4. Integration tests (gated by `DLOCAL_*` env vars) cover: successful card charge in at least one LATAM corridor, successful payout, webhook delivery for both.
5. Documentation page `docs/content/docs/adapters/dlocal.md` lists the supported corridors and payment methods in v1.
6. AduaNext Flow E can route through dLocal as an alternative to Revolut / Convera when the corridor fits.
7. Composition root registers dLocal under the `dlocal` key in `GatewayRegistry`.
