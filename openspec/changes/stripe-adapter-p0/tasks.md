# Tasks — Stripe adapter (P0)

## Linear

- Title: `payments-core: Stripe adapter P0 (Stripe SDK 18.5.0 pinned via client factory)`
- Labels: `adapter`, `stripe`, `p0`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-stripe-adapter-p0`.
- Blocked by: `domain-skeleton`, `application-use-cases`, `grpc-server-inbound`, `proto-contract-v1`.
- Related: sibling lesson `DOJ-3287` in dojo-os (stripe-client factory pattern). This adapter inherits that pattern.

## Implementation checklist

### Dependencies

- [ ] `package.json`: `"stripe": "18.5.0"` — **exact**, no range operators.
- [ ] Verify the lockfile pins `stripe@18.5.0` once only.
- [ ] Add a CI guard (`scripts/verify-stripe-version.ts` run in `ci.yml`) that reads `package.json` + the `STRIPE_API_VERSION` constant and fails if they drift.

### Adapter files

- [ ] `stripe-client-factory.ts` — the **only** `new Stripe(...)` call site in the repo. Exports `createStripeClient` + `STRIPE_API_VERSION` constant.
- [ ] `stripe-adapter.ts` — implements `PaymentGatewayPort` (initiate / confirm / refund).
- [ ] `stripe-subscription-adapter.ts` — implements `SubscriptionPort`.
- [ ] `stripe-webhook-verifier.ts` — implements `WebhookVerifierPort`, uses `client.webhooks.constructEvent` against raw bytes.
- [ ] `stripe-payout-adapter.ts` — implements `PayoutPort` against Stripe Connect payouts.
- [ ] `stripe-reconciliation-reader.ts` — implements `ReconciliationReaderPort` (paginated `balanceTransactions.list` over a day).
- [ ] `stripe-error-mapper.ts` — every Stripe error class mapped to an application code.
- [ ] `stripe-event-translator.ts` — mapping table per `design.md` §Event translator.

### Composition root wiring

- [ ] `src/main.ts` wires `StripeAdapter`, `StripeSubscriptionAdapter`, `StripeWebhookVerifier`, `StripePayoutAdapter`, `StripeReconciliationReader` under the `stripe` key in `GatewayRegistry`.
- [ ] Env validation fails fast if `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SIGNING_SECRET` is missing in non-test modes.

### Error map updates (in `grpc-server-inbound`)

- [ ] Add `GATEWAY_CARD_DECLINED` → gRPC `FAILED_PRECONDITION` in `error-mapper.ts`.
- [ ] Add `GATEWAY_INVALID_REQUEST` → gRPC `INVALID_ARGUMENT`.
- [ ] Add `GATEWAY_INTERNAL` → gRPC `INTERNAL` (with log-only message).

### ESLint rule

- [ ] Add `no-restricted-syntax` block forbidding `new Stripe(` outside `stripe-client-factory.ts`.
- [ ] Verify the rule by adding a test spec that expects ESLint errors when a fixture file violates it.

### Tests

- [ ] Unit: `stripe-error-mapper.test.ts` for every error class.
- [ ] Unit: `stripe-event-translator.test.ts` for every mapped event type + one unknown-type case.
- [ ] Integration (`test/integration/stripe/`, gated by `STRIPE_SECRET_KEY` presence):
  - [ ] Card charge (`pm_card_visa`) → intent succeeds → webhook → repository updated.
  - [ ] 3DS challenge (`pm_card_threeDSecure2Required`) → `requires_action` → confirm → success.
  - [ ] Refund full + partial.
  - [ ] Subscription create → renewal invoice webhook.
  - [ ] Dispute webhook (use Stripe CLI `stripe trigger charge.dispute.created`).
- [ ] Webhook signature: positive + negative (tampered payload rejected).

### Docs

- [ ] `docs/content/docs/adapters/stripe.md` — adapter overview, supported flows, env vars, version-pin rationale (with one-line cross-ref to DOJ-3287 as `sibling-repo internal`), migration note for dojo-os Edge Functions.
- [ ] `docs/mkdocs.yml` nav entry uncommented for `Adapters → Stripe`.

### `.env.example`

- [ ] Add the five Stripe env vars per `design.md` §Environment.

### Verification

- [ ] `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` green.
- [ ] `grep -R "new Stripe(" src/ | grep -v stripe-client-factory.ts` returns zero matches.
- [ ] Integration tests (if keys present in the CI secret store) pass.
- [ ] Manual: `docker run --env-file .env.stripe payments-core:dev` starts and reports `stripe` among `listActive()` gateways.

## Pitfalls to avoid

- Do not upgrade the Stripe SDK in this change. Any upgrade is its own OpenSpec change; see DOJ-3287 for why.
- Do not instantiate the Stripe SDK outside `stripe-client-factory.ts`. ESLint guards this but a rule drift check runs in CI.
- Do not JSON-parse the webhook body before signature verification.
- Do not cast `bigint` amounts to `number` without the precision guard (Stripe amounts capped at `Number.MAX_SAFE_INTEGER`).
- Do not implement Stripe Terminal, Stripe Issuing, Stripe Identity, Stripe Tax, or Stripe Agentic here. Each is its own out-of-scope line in `proposal.md`.
- Do not start onboarding Stripe Connect Express accounts server-side. Consumer apps use the hosted onboarding link.
- Do not log raw card data or payment method tokens. Log the `pi_*` id and the charge id only.
- Do not conflate `STRIPE_API_VERSION` with the SDK version. They are two pins, both required.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] `stripe-agentic-commerce-p1` unblocks — it extends this adapter with the agentic product surface.
- [ ] A sibling dojo-os PR deprecates the Stripe Edge Functions and switches to `payments-core` (tracked separately in that repo).
- [ ] `marketplace-core-events` (when it lands) uses Stripe Connect fee support demonstrated here.
- [ ] The `stripe-client-factory` pattern is referenced by `onvopay-adapter-p0` and `tilopay-adapter-p1` as a template for each gateway's client factory.
