# Proposal — OnvoPay adapter (P0)

## Context

OnvoPay is a Costa-Rican payments gateway specialized in the local card-acquisition market. It covers CR-domestic Visa / Mastercard acquiring with settlement in CRC and USD, supports recurring billing (`cargos-recurrentes`), and is the highest-priority CR-local gateway for the ecosystem. All five consumers of `payments-core` have at least one flow where OnvoPay is the preferred gateway:

- `dojo-os` — CR-domestic subscriptions for the local tier.
- `altrupets-api` — CR donors paying with CR-issued cards.
- `habitanexus-api` — CR HOA fees (recurring).
- `vertivolatam-api` — some CR corporate customers prefer a CR-native gateway.
- `aduanext-api` — Flow B (subscription) for CR customs agencies.

This change implements the OnvoPay adapter alongside Stripe as a second P0 so that the gateway registry has two live providers from day one, proving the port surface generalizes.

## Why now

Stripe alone makes the sidecar look like a Stripe wrapper. Landing OnvoPay concurrently forces the port surface to stay gateway-neutral and catches premature Stripe-specific assumptions (`return_url`, `confirmation_method`, Connect semantics) before they become structural.

Additionally, CR merchants have observed higher acceptance rates on CR-issued cards through OnvoPay than through Stripe for the same transaction (a domestic-vs-cross-border acquirer preference), so landing OnvoPay early maximizes conversion for the consumer backends that ship first.

## Scope

Adapter files under `src/adapters/outbound/onvopay/`:

- `onvopay-client-factory.ts` — single construction point, mirroring the Stripe pattern.
- `onvopay-http-client.ts` — thin wrapper around `fetch`; OnvoPay does not publish an official Node SDK (TODO: verify against https://docs.onvopay.com/ — if an official SDK exists and is maintained, switch to it in this change).
- `onvopay-adapter.ts` — implements `PaymentGatewayPort`.
- `onvopay-subscription-adapter.ts` — implements `SubscriptionPort` against OnvoPay's recurring billing (`cargos-recurrentes`, https://docs.onvopay.com/#/Cargos-recurrentes if the page resolves).
- `onvopay-webhook-verifier.ts` — implements `WebhookVerifierPort` per OnvoPay's HMAC signing (TODO: verify algorithm against https://docs.onvopay.com/ webhook section).
- `onvopay-error-mapper.ts`, `onvopay-event-translator.ts`.
- `onvopay-reconciliation-reader.ts` — paginated daily-transaction fetch.

### API references

The adapter is implemented against the public docs at https://docs.onvopay.com/ (root spec) and the recurring-billing page cited above. Both URLs must be visited at implementation time because OnvoPay's docs have evolved between 2025 and 2026. If either page has changed substantially, the adapter author notes the gap in `design.md` as a TODO rather than guessing.

## Out of scope

- OnvoPay's merchant onboarding flow (KYC, bank account verification). Consumer backends onboard via OnvoPay's merchant dashboard.
- Card tokenization on the frontend (handled by consumer frontends using OnvoPay's card widget).
- USD-settled merchants without a CR tax ID. Those are covered by Stripe.
- Any legacy OnvoPay API version pre-2025. We target the current docs only.

## Alternatives rejected

- **Only Stripe as P0, add OnvoPay later** — rejected. Risks port drift; see "Why now".
- **Wait for OnvoPay to publish an official Node SDK** — rejected. Months of blocking; a hand-written HTTP client with typed inputs is low-risk.
- **Use Tilopay instead of OnvoPay for CR-local** — rejected. Tilopay is equally valid for CR but targets B2B card issuing (see `tilopay-adapter-p1`). The two cover different subsets of CR merchant needs; we ship both, in different priority waves.

## Acceptance

1. `src/adapters/outbound/onvopay/` implements the five ports listed above.
2. Integration tests (gated by `ONVOPAY_*` env vars) exercise: successful CRC charge, successful USD charge, recurring-billing creation, webhook delivery.
3. OnvoPay's HMAC webhook signature is verified on the raw body (before any parse).
4. OnvoPay's `onvopay-client-factory.ts` follows the same single-instantiation pattern as Stripe's.
5. `docs/content/docs/adapters/onvopay.md` documents flows, env vars, supported currencies, and the `docs.onvopay.com` references with access dates.
6. The composition root wires OnvoPay under the `onvopay` key in `GatewayRegistry`.
