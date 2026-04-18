# Proposal — Revolut adapter

## Context

Revolut Business offers a developer platform with several products relevant to `payments-core`:

- **Merchant Web SDK** — browser-side card checkout with 3DS, wallet buttons, and a prebuilt order widget. Documentation under https://developer.revolut.com/ (TODO: verify canonical URL and sub-path for Merchant Web SDK at implementation time).
- **Orders API** — server-side order lifecycle (create, capture, refund, cancel) that the Merchant Web SDK drives.
- **Crypto Ramp** — on-ramp / off-ramp between fiat and crypto via Revolut's exchange layer.
- **Exchange FIX** — FIX protocol API for institutional FX execution.

Together these cover a distinct niche: **multi-currency B2B payments + FX + crypto ramp** with first-class LATAM and EU corridor support. The committed consumer is `aduanext-api` Flow E (cross-border broker/consultant payments); `altrupets-api` also benefits for international donor FX.

## Why this change (timing)

Revolut covers corridors that Stripe handles less elegantly (EU-heavy FX, multi-currency holding accounts, crypto ramp for donors who prefer it). Priority is **after** the P0/P1 wave: Revolut is a differentiator, not a critical-path dependency. It lands when a consumer has a committed flow that requires it.

## Scope

Adapter files under `src/adapters/outbound/revolut/`:

- `revolut-client-factory.ts` — single construction site; handles OAuth 2.0 token refresh (Revolut uses rotating access tokens).
- `revolut-orders-adapter.ts` — implements `PaymentGatewayPort` against the Orders API.
- `revolut-payout-adapter.ts` — implements `PayoutPort` against Revolut's B2B transfer API.
- `revolut-webhook-verifier.ts` — HMAC verification per Revolut's webhook docs (TODO: verify algorithm at implementation).
- `revolut-crypto-ramp-adapter.ts` — implements a new `CryptoRampPort` (declared in this change) if the ramp product is reachable via API; if it requires partner-specific onboarding, this sub-scope is deferred.
- `revolut-fix-adapter.ts` — **deferred to a follow-up change**; documented here as a future path. FIX integration is non-trivial (stateful socket, sequence numbers, heartbeat management) and does not belong in the initial Revolut adapter PR.
- `revolut-error-mapper.ts`, `revolut-event-translator.ts`, `revolut-reconciliation-reader.ts`.

### New port: `CryptoRampPort`

Declared in this change if and only if Revolut's Crypto Ramp product is reachable programmatically without a partner agreement. If it requires a partner agreement, the port is NOT declared and the crypto-ramp sub-scope is spun out as a separate deferred change.

```ts
export interface CryptoRampPort {
  rampFiatToCrypto(input: RampFiatInput): Promise<RampFiatResult>;
  rampCryptoToFiat(input: RampCryptoInput): Promise<RampCryptoResult>;
  getSupportedPairs(): Promise<CryptoRampPair[]>;
}
```

## Out of scope (in this change)

- **Revolut Exchange FIX** — deferred; separate change once a consumer actually needs institutional FX rates delivered via FIX.
- **Revolut Business card issuing** — not a payments-in concern.
- **Revolut Banking-as-a-Service** — out of ecosystem scope.
- **Frontend wiring of the Merchant Web SDK** — consumers embed the widget in their own frontend; `payments-core` only drives the server-side lifecycle via the Orders API.
- **XRPL integration via Revolut** — Revolut's crypto ramp may support XRPL as a currency; XRPL-native flows live in `ripple-xrpl-adapter` regardless.

## Alternatives rejected

- **Use Stripe's FX via card issuance** — rejected. Different cost structure, worse corridor coverage for EU-heavy flows.
- **Use Convera instead of Revolut for FX** — partially accepted. Both adapters land; routing chooses per corridor. Revolut is preferred for EU-LATAM and B2B SMB; Convera is preferred for larger cross-border + the stablecoin roadmap (Ripple partnership).
- **Build Crypto Ramp as a separate port-agnostic service** — rejected for v1. If a second ramp provider appears later, generalize then.
- **Ship the FIX adapter together with Orders in one PR** — rejected. FIX adds protocol-level complexity (stateful, sequenced) that does not belong in the same surface as request/response Orders. Separate PR preserves reviewability.

## Acceptance

1. `src/adapters/outbound/revolut/` implements `PaymentGatewayPort` and `PayoutPort`.
2. OAuth token refresh is handled inside `revolut-client-factory.ts`; no RPC path stalls on an expired token.
3. Webhook signature verification tested with valid + tampered fixtures.
4. `CryptoRampPort` is either declared + implemented for the ramp product, or explicitly documented as deferred with the partner-agreement blocker.
5. Integration tests (gated by Revolut sandbox keys) cover: Order create → Merchant SDK capture → refund; payout to a known beneficiary in a second currency.
6. `docs/content/docs/adapters/revolut.md` covers the Orders flow, the FX scope, the crypto-ramp status, and explicitly marks FIX as a later change.
7. `aduanext-api` Flow E and `altrupets-api` international donations can route through Revolut where the corridor fits.
