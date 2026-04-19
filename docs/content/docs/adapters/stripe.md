# Stripe adapter

Stripe is the first gateway adapter landed in `payments-core`. It implements
three domain ports against Stripe's REST API via the official Node SDK, and is
the reference implementation every subsequent adapter (`OnvoPay`, `TiloPay`,
`dLocal`, ...) mirrors.

## Implemented ports

| Port | What it talks to | Methods |
|---|---|---|
| `PaymentGatewayPort` | Stripe PaymentIntents + Refunds | `initiate`, `confirm`, `capture`, `refund` |
| `SubscriptionPort` | Stripe Billing | `create`, `switch`, `cancel`, `prorate` |
| `WebhookVerifierPort` | `stripe.webhooks.constructEvent` | `verify` |

Two more Stripe-backed ports (`PayoutPort`, `ReconciliationPort`,
`DisputePort`) live in the OpenSpec tasks for this change but are deferred to
follow-up work once the domain ports they need are also finalized. See the
`openspec/changes/stripe-adapter-p0/` folder for the full roadmap.

## SDK version pin

**`stripe@18.5.0`** — exact version, no caret, no tilde. The same version the
sibling `dojo-os` repo runs in production post
[DOJ-3287](https://linear.app/dojo-coding/issue/DOJ-3287) (sibling-repo
internal). Avoiding drift across the portfolio is a governance rule; never
bump this line without a dedicated OpenSpec change.

`STRIPE_API_VERSION` is pinned separately to `'2025-08-27.basil'` — the
`Stripe.LatestApiVersion` string shipped with SDK 18.5.0. Treat this as a
second pin with the same upgrade discipline as the SDK version.

## Factory pattern (DOJ-3287)

The entire adapter has exactly **one** `new Stripe(...)` call — inside
`src/adapters/outbound/gateways/stripe/client.ts`. Every other file imports
the Stripe-typed surface from `./client.js`. An ESLint rule
(`no-restricted-imports` scoped to the adapter directory) enforces this, with
a second `no-restricted-syntax` guard forbidding `new Stripe(...)` anywhere
else in `src/`.

This layout makes SDK upgrades a **one-file** change and keeps the adapter
free of surprise retries, timeouts, or `apiVersion` drift.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes (runtime) | `sk_live_*` or `sk_test_*`. Never commit. |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | Yes (runtime) | `whsec_*`. Issued per endpoint in Stripe dashboard. |
| `STRIPE_API_VERSION` | No | Override only if explicitly different from the pinned version. |
| `STRIPE_MAX_NETWORK_RETRIES` | No | Defaults to 2. |
| `STRIPE_TIMEOUT_MS` | No | Defaults to 15_000. |

The composition root (landing with the gRPC inbound change) validates these
via Zod and fails fast if the secret/signing keys are missing.

## Idempotency

Every mutating call threads the domain `IdempotencyKey` through Stripe's
native `Idempotency-Key` header (SDK option `idempotencyKey`). Stripe's
semantics match our domain contract:

- **Replays return the original response** — safe to retry on network
  failure.
- **Parameter changes on replay** fire `StripeIdempotencyError`, which the
  adapter's error mapper converts to `IdempotencyConflictError` (gRPC
  `ALREADY_EXISTS`).

No semantic deviation to flag at this point. If Stripe ever tightens the
policy (e.g. requires the key be globally unique across endpoints), the
adapter's mapper is the single place to adjust.

## Webhook verification

`StripeWebhookVerifier.verify(...)` wraps `client.webhooks.constructEvent`
around the **raw bytes** of the webhook body. Two guarantees:

1. **Signature check**: Stripe-signed HMAC. Tolerance defaults to 5 minutes
   (the SDK default). Mismatches throw `WebhookSignatureError` (gRPC
   `UNAUTHENTICATED`).
2. **Duplicate-event rejection**: event `evt_*` ids are stable across
   redeliveries. The verifier re-uses the application-layer `IdempotencyPort`
   as a short-term event repository. This is an intentional shortcut — a
   follow-up change introduces `WebhookEventRepositoryPort` (or a dedicated
   `stripe_events` table) and migrates this dependency without breaking
   the public verifier contract.

Do **not** JSON-parse the body before verification. The inbound gRPC adapter
preserves the raw bytes on `ProcessWebhookRequest.raw_body` for this reason.

## Supported flows

- **Card charge with automatic capture** — `initiate` returns a
  `PaymentIntent`, 3DS step-up surfaced via `ThreeDSChallenge`
  (carrying the `client_secret` as opaque bytes). Frontend SDKs
  (`@stripe/stripe-js`, `flutter_stripe`) complete the step-up.
- **Authorize + capture** — `capture` supports partial captures via the
  optional `amount` field.
- **Refund** — full or partial, carrying a `reason` as metadata.
- **Subscriptions** — Stripe Billing with `price_*` plan ids. Requires
  `metadata.customer_id` on `create` (pre-created Stripe customer id).
- **Plan switch** — proration behaviour passes through directly.
- **Cancel immediately or at period end** — `effectiveAt` surfaced from
  `canceled_at` or the active item's `current_period_end` respectively.

## Known limitations (P0 scope)

- **Connect onboarding is out of scope.** Consumer apps use Stripe's hosted
  onboarding and pass the resulting `acct_*` id to their own metadata.
- **No `PayoutPort` / `ReconciliationPort` / `DisputePort`** in this change.
  Tasks tracked in the OpenSpec file.
- **Agentic Commerce** (Enable-in-Context Selling on AI Agents) deferred to
  `stripe-agentic-commerce-p1`.
- **Money amounts above `Number.MAX_SAFE_INTEGER`** are rejected with a
  `RangeError`. The domain carries `bigint`; Stripe's SDK wants `number`.
  Well above any realistic single-transaction amount.
- **Follow-up note on webhook event storage**: the duplicate-event guard
  currently rides on `IdempotencyPort`. A dedicated event repository port is
  tracked for post-P0 work.

## Migration note for dojo-os

The sibling `dojo-os` repo's Stripe Edge Functions are superseded by this
adapter once the consumer-side PR switches its call sites to
`payments-core`'s gRPC endpoint. The factory pattern in this adapter mirrors
dojo-os's `_shared/payments-core/stripe-client.ts` contract precisely so the
rollover is a pure client-side swap — no protocol change for Stripe itself.
