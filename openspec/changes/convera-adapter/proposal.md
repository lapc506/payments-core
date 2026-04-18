# Proposal — Convera adapter

## Context

Convera (formerly Western Union Business Solutions) is a specialist in **cross-border B2B payments** covering 140+ currencies and payout corridors that general-purpose gateways (Stripe, Revolut) reach less comprehensively. Documentation lives at https://convera.readme.io/ (TODO: verify canonical URL at implementation time).

In 2025 Convera publicly announced a partnership with Ripple to use Ripple's **RLUSD stablecoin** and XRP on-chain settlement rails for faster cross-border payments. This positions Convera as both a traditional SWIFT-rail B2B payments provider and a bridge into on-chain settlement — relevant to our long-horizon `ripple-xrpl-adapter` change.

The committed consumer is `aduanext-api` Flow E (cross-border broker/consultant payments) for corridors where Convera's coverage exceeds Revolut's or dLocal's. `vertivolatam-api` also benefits for the B2B cross-border subset of its volume.

## Why this change (timing)

Convera is the second cross-border B2B gateway in the roadmap (Revolut being the first). Convera's strength is **corridor breadth** — countries and currencies that Revolut does not reach. Consumers that route by corridor benefit from having both adapters available.

Priority is after the P0/P1 wave. Convera + Revolut land as a pair, possibly in parallel change dirs, because the `PayoutPort` implementations for each push on the same port surface simultaneously. This proposal is intentionally written so that Convera can ship without Revolut and vice versa.

## Scope

Adapter files under `src/adapters/outbound/convera/`:

- `convera-client-factory.ts` — single construction site; handles OAuth (TODO: verify Convera's auth model against convera.readme.io).
- `convera-http-client.ts` — HTTP wrapper.
- `convera-payments-adapter.ts` — implements `PaymentGatewayPort` for the payment-initiation flows relevant to B2B (bank-to-bank transfers, partly similar to a payout but inbound).
- `convera-payout-adapter.ts` — implements `PayoutPort` for outbound beneficiary payouts across 140+ corridors.
- `convera-webhook-verifier.ts` — signature verification per Convera's docs (TODO: verify).
- `convera-reconciliation-reader.ts`, `convera-error-mapper.ts`, `convera-event-translator.ts`.

### Ripple / RLUSD integration

This adapter does NOT directly wire Convera's Ripple integration. Convera exposes stablecoin-backed corridors as **additional routes** within the same Convera API — the consumer asks Convera for a payout to a LATAM beneficiary, and Convera (behind the scenes) chooses SWIFT or RLUSD rails based on its own routing. `payments-core` remains gateway-agnostic: it calls the Convera API as if it were any other payout, and the choice of rail is Convera's internal concern.

If Convera later exposes a "force RLUSD" flag as a per-request option, the adapter adds it as an optional metadata field; until then, consumers cannot direct routing by rail.

For **direct XRPL interaction** (not via Convera), `ripple-xrpl-adapter` is the separate long-horizon change.

## Out of scope

- **Convera's FX forward contracts** — these are scheduled derivatives, not payment-in-the-moment flows; not a payments-core concern.
- **Convera's corporate card issuance** — not a payments-in concern.
- **Direct RLUSD / XRP on-chain operations** — handled by `ripple-xrpl-adapter` when / if that change ships.
- **Convera dashboard / merchant onboarding** — consumer backends open Convera merchant accounts directly.

## Alternatives rejected

- **Skip Convera, use Revolut exclusively** — rejected. Corridor gaps. Revolut's coverage is EU-strong; Convera's is SWIFT-global-strong. Both are needed for AduaNext's full corridor matrix.
- **Wait for Convera's Ripple integration to reach GA** — rejected. Traditional Convera corridors justify the adapter on their own; Ripple-rail routing becomes an additive enhancement when available.
- **Build a "cross-border abstraction layer" over Revolut + Convera + dLocal** — rejected. Each adapter has distinct strengths; abstracting them hides the routing decision that `GatewayRegistry` should surface explicitly.
- **Use Convera only as a payout rail, not as a payment-in rail** — partially accepted. `PayoutPort` is the primary implementation. `PaymentGatewayPort` is implemented only if Convera's payment-in API is fit for purpose (TODO: verify at implementation).

## Acceptance

1. `src/adapters/outbound/convera/` implements `PayoutPort` at minimum, and `PaymentGatewayPort` if the API surface supports it.
2. `convera.readme.io` doc URL is recorded with an access date in `design.md` when the adapter lands.
3. Webhook verification tested with valid + tampered fixtures.
4. Integration tests (gated by Convera sandbox keys) cover: payout to a beneficiary in a non-USD corridor, refund/cancel flow, webhook delivery.
5. `docs/content/docs/adapters/convera.md` documents: supported corridors, auth model, Ripple-rail status (informational, not controllable), and the partnership announcement as context.
6. Composition root wires Convera under the `convera` key in `GatewayRegistry`.
7. AduaNext Flow E routing table gains Convera as an option for corridors Revolut and dLocal do not cover.
