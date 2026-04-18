# Proposal — Stripe adapter (P0)

## Context

Stripe is the first and highest-priority gateway for `payments-core`. Every committed consumer can route at least one flow through Stripe:

- `dojo-os` — card payments + subscriptions (already in production on Supabase Edge Functions that this sidecar replaces).
- `altrupets-api` — international donations with cross-border FX.
- `habitanexus-api` — subscriptions.
- `vertivolatam-api` — multi-currency card flows for LATAM merchants that want Stripe's risk tooling.
- `aduanext-api` — international broker payments (Flow E) and SaaS subscriptions (Flow B).

This change implements the Stripe adapter against the ports declared in `domain-skeleton`: `PaymentGatewayPort`, `SubscriptionPort`, `WebhookVerifierPort`, and the reconciliation read slice of `ReconciliationReaderPort`. Stripe Connect support for platform fees (used by `aduanext-api` Flow A and by `marketplace-core-events`) also lands here.

## Why now

Stripe is the gateway with the most mature SDK, the richest feature set, and the widest consumer coverage. Landing it first:

- Unblocks dojo-os's migration off its current Edge Functions for Stripe operations.
- Produces a reference implementation the later adapters (`onvopay-adapter-p0`, `tilopay-adapter-p1`, …) can mimic.
- Validates the port shapes from `domain-skeleton` against a real, non-trivial SDK.

## SDK version pin

**Stripe Node SDK is pinned to `18.5.0`** and not updated reactively.

### Why 18.5.0 specifically

The sibling repo `dojo-os` lived through **DOJ-3287**, a regression caused by implicitly upgrading the Stripe SDK across a Dependabot wave. The fix there introduced a **stripe-client factory pattern** that centralizes SDK instantiation, version selection, and API version string (`'stripe.apiVersion'` header), and freezes a known-good version per release.

We apply the same lesson here: one factory, one pinned version, explicit upgrade changes only. `18.5.0` is the latest version dojo-os has run in production without incident as of 2026-04-18 and is the version we inherit as the baseline. Any subsequent upgrade is its own OpenSpec change with:

- Release notes review (Stripe's `api_version` bumps sometimes silently change object shapes).
- Side-by-side test run against the recorded webhook fixtures.
- dojo-os verification that the change does not regress their flows (they will track the same version until they have reason not to).

## Scope

### Adapter files (`src/adapters/outbound/stripe/`)

- `stripe-adapter.ts` — main class implementing `PaymentGatewayPort` (public surface).
- `stripe-subscription-adapter.ts` — implements `SubscriptionPort`.
- `stripe-webhook-verifier.ts` — implements `WebhookVerifierPort`.
- `stripe-payout-adapter.ts` — implements `PayoutPort` (Stripe Connect payouts).
- `stripe-reconciliation-reader.ts` — implements `ReconciliationReaderPort` for Stripe.
- `stripe-client-factory.ts` — **single place** that `new Stripe(...)` is called; also the single place the SDK version is referenced.
- `stripe-error-mapper.ts` — maps `Stripe.errors.*` to the application-layer error codes from `application-use-cases`.
- `stripe-event-translator.ts` — translates Stripe webhook event shapes to the domain events declared in `domain-skeleton`.

### Agentic commerce deferral

This change ships basic card/subscription/webhook flow. Stripe's **Enable-in-Context Selling on AI Agents** product lands in `stripe-agentic-commerce-p1` to keep this P0 change focused and the P1 change's scope clearly bounded.

### Connect scope in P0

Minimal Connect support lands here: the adapter accepts `application_fee_amount` and `transfer_data.destination` for platform-fee flows used by AduaNext Flow A + F and by future marketplace-core flows. Full Connect onboarding (Express account creation, KYC flows, capability management) is **out of scope** — consumer backends handle Connect onboarding directly against Stripe's dashboard-hosted flows.

## Explicitly out of scope

- **Stripe Terminal** (card-present POS). No consumer needs it.
- **Stripe Issuing** (card issuance). Not a payments-in concern.
- **Stripe Identity** (KYC). `compliance-core` owns that.
- **Stripe Tax**. `invoice-core` owns tax determination.
- **Apple Pay / Google Pay via Stripe's client SDK**. Frontend apps use `flutter_stripe` / `@stripe/stripe-js`. Server-side token verification is in `apple-google-pay-verify-p2`.
- **Stripe Agentic Commerce**. Separate P1 change: `stripe-agentic-commerce-p1`.
- **Stripe Financial Connections / Bank debits outside USD/CAD**. Scope creep; revisit when a consumer needs it.

## Alternatives rejected

- **Start with OnvoPay as P0 instead** — rejected because dojo-os already has Stripe in production today; switching it over is the immediate win. OnvoPay lands concurrently as its own P0 for CR merchants.
- **Use the Stripe SDK default version string** — rejected. Implicit version pins bit dojo-os on DOJ-3287. Explicit `apiVersion: '2024-10-28.acacia'` (or whatever matches 18.5.0's signaled version) is set in the factory.
- **Wrap Stripe SDK in our own generic HTTP client** — rejected. The SDK handles retries, idempotency headers, webhook signature verification, and typed errors. Rewriting loses those.
- **Vendor the SDK types but call the API with `fetch`** — rejected for the same reasons, plus: `fetch` calls end up shadowing the SDK's built-in idempotency behavior.

## Acceptance

1. `src/adapters/outbound/stripe/` fully implements `PaymentGatewayPort`, `SubscriptionPort`, `WebhookVerifierPort`, `PayoutPort`, and `ReconciliationReaderPort` for Stripe.
2. `package.json` has `"stripe": "18.5.0"` — **exact** version, no caret, no tilde.
3. All Stripe SDK instantiation goes through `stripe-client-factory.ts` — a repo-wide grep for `new Stripe(` returns exactly one hit (inside the factory).
4. Integration tests use Stripe's test mode API keys (from `.env.example` placeholders) and cover: successful card charge, 3DS challenge, refund, subscription create + renewal webhook, dispute webhook.
5. Webhook signature verification is tested against Stripe's published fixtures + a known bad fixture that must be rejected.
6. The composition root in `main.ts` registers `StripeAdapter` under the `stripe` key in `GatewayRegistry`.
7. `dojo-os`'s Stripe Edge Functions are identified as deprecated (in a sibling repo's README change, not tracked here) and a migration path is documented in `docs/content/docs/adapters/stripe.md`.
