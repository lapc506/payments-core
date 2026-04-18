# Tasks — OnvoPay adapter (P0)

## Linear

- Title: `payments-core: OnvoPay adapter P0 (CR-local card + recurring)`
- Labels: `adapter`, `onvopay`, `p0`, `costa-rica`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-onvopay-adapter-p0`.
- Blocked by: `domain-skeleton`, `application-use-cases`, `grpc-server-inbound`.
- Related: Stripe adapter P0 (reference for client-factory pattern and port implementation shape).

## Pre-implementation (MUST do before writing code)

- [ ] Visit https://docs.onvopay.com/ and read the current charge / webhook / recurring-billing sections end-to-end.
- [ ] Visit https://docs.onvopay.com/#/Cargos-recurrentes specifically for the recurring-billing flow.
- [ ] If an official OnvoPay Node SDK has been published since 2025, switch to it and document the change in `design.md`. Otherwise, proceed with the hand-written HTTP client.
- [ ] Confirm: webhook signature algorithm + header name, event-type names, minor-unit convention per currency (CRC + USD), error response body shape.
- [ ] Record the access date of each verified URL at the bottom of `design.md` under "Docs verification log".

## Implementation checklist

### Scaffold

- [ ] `src/adapters/outbound/onvopay/` tree per `design.md`.
- [ ] `onvopay-client-factory.ts` is the single construction site for `OnvoPayHttpClient`. ESLint rule (or convention) enforced.

### Ports implemented

- [ ] `PaymentGatewayPort` via `OnvoPayAdapter` (initiate / confirm / refund).
- [ ] `SubscriptionPort` via `OnvoPaySubscriptionAdapter`.
- [ ] `WebhookVerifierPort` via `OnvoPayWebhookVerifier` (HMAC-SHA256 against raw bytes).
- [ ] `ReconciliationReaderPort` via `OnvoPayReconciliationReader`.

### Translators + error mapper

- [ ] `onvopay-event-translator.ts` — mapping verified against live docs; table in `design.md` updated to match.
- [ ] `onvopay-error-mapper.ts` — every observed HTTP status class mapped to an application code.

### Composition root

- [ ] `src/main.ts` wires OnvoPay under the `onvopay` key in `GatewayRegistry`.
- [ ] Env validation: fail fast if `ONVOPAY_API_KEY` missing in non-test modes.

### Tests

- [ ] Unit: error mapper covers 401 / 402 / 409 / 422 / 429 / 503 / unknown.
- [ ] Unit: event translator covers every mapped event type + one unknown type (logged + dropped).
- [ ] Unit: webhook verifier rejects tampered body, rejects missing header, accepts valid signature.
- [ ] Integration (gated by `ONVOPAY_API_KEY` availability in CI):
  - [ ] CRC charge succeeds.
  - [ ] USD charge succeeds.
  - [ ] Refund partial + full.
  - [ ] Subscription create + first renewal webhook.
  - [ ] Rate-limit 429 retry path.
- [ ] Fixture-based tests from OnvoPay's published docs (if any fixtures exist — TODO: verify).

### Docs

- [ ] `docs/content/docs/adapters/onvopay.md` — flows, env vars, access-date log for the doc URLs, supported currencies, known limitations.
- [ ] `docs/mkdocs.yml` nav entry activated for `Adapters → OnvoPay`.

### `.env.example`

- [ ] Add the five OnvoPay env vars per `design.md` §Environment.

### Verification

- [ ] `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` green.
- [ ] `grep -R "new OnvoPayHttpClient" src/ | grep -v onvopay-client-factory.ts` returns zero matches.
- [ ] Manual: with real OnvoPay test keys, a successful CRC charge appears in the OnvoPay merchant dashboard.

## Pitfalls to avoid

- Do not assume OnvoPay's field names match Stripe's. Every field is verified against the live docs.
- Do not skip signature verification. A missing or invalid signature rejects the webhook with a 400-equivalent error.
- Do not parse the webhook body before signature verification.
- Do not use OnvoPay for Stripe-style Connect fee flows — OnvoPay's platform-fee primitive is different (TODO: verify). If the consumer needs a platform fee on OnvoPay, document it as a follow-up, not in v1.
- Do not inline retry logic that loops indefinitely. Max retries is bounded (config default: 2).
- Do not embed currency-conversion logic in the adapter. FX happens at the gateway; the adapter passes (amount, currency) through.
- Do not log the raw card PAN or CVV under any circumstance. Only log OnvoPay's returned `charge.id` + status.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] The adapter appears in `GatewayRegistry.listActive()` at runtime alongside Stripe.
- [ ] `dojo-os` can start routing CR-tier subscriptions through OnvoPay instead of Stripe for CR-issued cards (tracked in a sibling repo PR).
- [ ] The `docs.onvopay.com` verification log in `design.md` becomes the baseline; next upgrade PR re-verifies and updates dates.
