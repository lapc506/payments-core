# OnvoPay adapter

OnvoPay is a Costa-Rican payments gateway specialized in CR-local card
acquisition. This adapter implements three ports from
`src/domain/ports/index.ts`:

- `PaymentGatewayPort` — card charges (initiate, confirm, capture, refund)
- `SubscriptionPort` — recurring charges (`cargos-recurrentes`)
- `WebhookVerifierPort` — HMAC-SHA256 webhook signature verification

The adapter code lives in `src/adapters/outbound/gateways/onvopay/`. All
network I/O funnels through a single `OnvoPayHttpClient` (in `client.ts`),
which centralizes timeouts, retry policy, and auth headers. No other module
in this adapter imports `node:http` or calls `fetch` directly.

## Environment variables

Configured via `.env` (see `.env.example` for the template):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ONVOPAY_API_BASE_URL` | Yes | `https://api.onvopay.com` | Base URL; no trailing slash. |
| `ONVOPAY_API_KEY` | Yes | — | Secret API key from OnvoPay's dashboard. |
| `ONVOPAY_WEBHOOK_SIGNING_SECRET` | Yes | — | HMAC secret for webhook verification. |
| `ONVOPAY_TIMEOUT_MS` | No | `10000` | Per-request timeout. |
| `ONVOPAY_MAX_RETRIES` | No | `2` | Retries for transient network errors only. |

## Supported currencies

**CRC only at this time.** The adapter enforces this at the gateway boundary
via `assertOnvoPaySupportedCurrency()` in `mappers.ts`. Non-CRC `Money`
inputs throw `InvalidMoneyError` before any network call, so consumers see
a domain-level error rather than a gateway 400.

OnvoPay may support USD or other currencies for specific merchant
categories; see the Verification Log below for the open `TODO` on this.

## Flows

### Charge

```
consumer                payments-core           OnvoPay
    |  CreateCharge         |                      |
    |---------------------->|                      |
    |                       | POST /v1/charges     |
    |                       |--------------------->|
    |                       |<---------------------|
    |                       |   { id, status }     |
    |<----------------------|                      |
    |   gatewayRef +        |                      |
    |   requiresAction?     |                      |
```

If `status === 'requires_action'`, the adapter returns a `ThreeDSChallenge`
whose opaque payload carries the redirect URL (`next_action.redirect_url`
or `checkout_url`). Consumers surface the hosted 3DS page; on return, the
use case layer calls `confirm(...)`.

### Subscription (recurring charges)

```
POST /v1/subscriptions        { customer, plan, metadata }
PATCH /v1/subscriptions/:id   { plan, proration_behavior }   // switch
DELETE /v1/subscriptions/:id                                 // cancel now
POST /v1/subscriptions/:id/cancel { at_period_end: true }    // cancel at period end
```

Prorate previews are not yet implemented — the `prorate(...)` method throws
`ADAPTER_ONVOPAY_NOT_IMPLEMENTED` pending a verified preview endpoint.

### Webhook

The verifier expects `HMAC-SHA256(raw_body, webhook_signing_secret)`
returned as a lowercase hex digest. Both the bare-hex header shape and the
composite `t=<unix>,v1=<hex>` shape are accepted.

The verifier:

1. Rejects missing / malformed / wrong-length signatures **before** parsing
   the body.
2. Parses the JSON body only after HMAC verification.
3. Rejects duplicate event ids via a pluggable `OnvoPayWebhookDedupeStore`.
   Tests use `InMemoryOnvoPayDedupeStore`; production must inject a
   Redis/Postgres-backed implementation.

## Endpoints used (speculative — see Verification Log)

| Port method | HTTP verb | Path |
|---|---|---|
| `PaymentGatewayPort.initiate` | POST | `/v1/charges` |
| `PaymentGatewayPort.confirm` | POST | `/v1/charges/:id/confirm` |
| `PaymentGatewayPort.capture` | POST | `/v1/charges/:id/capture` |
| `PaymentGatewayPort.refund` | POST | `/v1/refunds` |
| `SubscriptionPort.create` | POST | `/v1/subscriptions` |
| `SubscriptionPort.switch` | PATCH | `/v1/subscriptions/:id` |
| `SubscriptionPort.cancel` (immediate) | DELETE | `/v1/subscriptions/:id` |
| `SubscriptionPort.cancel` (at period end) | POST | `/v1/subscriptions/:id/cancel` |

## Error mapping

| Trigger | Mapped error |
|---|---|
| HTTP 401 / 403 | `OnvoPayAuthError` |
| HTTP 402 | `OnvoPayCardDeclinedError` |
| HTTP 400 / 422 | `OnvoPayInvalidRequestError` |
| HTTP 409 | `IdempotencyConflictError` (domain) |
| HTTP 429 | `OnvoPayRateLimitedError` |
| HTTP 5xx | `GatewayUnavailableError` (domain) |
| Network timeout / reset | `GatewayUnavailableError` (domain) |

Business errors (4xx, 5xx) are **never retried** inside the client. Only
transient network failures are retried, with exponential backoff + jitter,
up to `ONVOPAY_MAX_RETRIES` attempts.

## Known limitations

- **CRC only.** See Verification Log for the open TODO on multi-currency.
- **`prorate` not implemented.** Pending a verified preview endpoint.
- **Escrow / disputes not implemented.** The `EscrowPort` and `DisputePort`
  will land in a follow-up change (`onvopay-adapter-p1`).
- **Minor-unit convention for CRC is unverified.** The adapter passes
  `Money.amountMinor` through as an integer; if OnvoPay expects whole
  Colones, the conversion lives in `toOnvoPayAmount()` and can be changed
  without touching port implementations.

## Verification log

This adapter was implemented with `docs.onvopay.com` as a JavaScript-heavy
SPA that did not render markdown-friendly content via `curl`. Because of
that, every endpoint shape, field name, error code, and webhook
convention below should be validated against a live OnvoPay sandbox before
the adapter is routed production traffic.

- **Baseline commit SHA**: `b359371d9468f04bac84c7f971037b60acf66029`
  (the tip of `main` at which this adapter was authored).
- **Docs referenced but not verifiable via plaintext fetch**:
  - https://docs.onvopay.com/#section/Referencia-API — base URL, auth,
    idempotency header, charge endpoints, error body shape.
  - https://docs.onvopay.com/#tag/Cargos-recurrentes — subscription
    endpoints, proration-behavior enum, cancel-at-period-end flag.
  - Webhook section (URL not bookmarkable from outside the SPA) —
    signature algorithm, header name, header shape.

### Open TODOs (search `grep -R "TODO: verify"` in the adapter tree)

| Location | What to verify |
|---|---|
| `client.ts` (Bearer header) | Auth scheme — Bearer vs `x-api-key` vs Basic. |
| `client.ts` (Idempotency-Key header) | Exact header name OnvoPay expects. |
| `mappers.ts` (CRC-only guard) | Whether USD / EUR are supported. |
| `mappers.ts` (`toOnvoPayAmount`) | Minor-unit convention for CRC. |
| `mappers.ts` (status enums) | Complete charge and subscription status sets. |
| `payment-gateway.ts` (`/v1/charges/:id/confirm`) | Endpoint path for confirmation. |
| `subscription.ts` (`proration_behavior`) | Enum accepted by the switch endpoint. |
| `subscription.ts` (`prorate`) | Preview endpoint path and response shape. |
| `subscription.ts` (`cancel` effectiveAt) | Whether the payload returns `cancel_at`. |
| `webhook-verifier.ts` (signature scheme) | HMAC algorithm + header name. |
| `errors.ts` (HTTP 402 mapping) | Whether 402 or 400+code is used for declines. |

Each TODO in code links back to a specific `docs.onvopay.com` section. The
follow-up work is tracked as a docs-verification issue (link in the PR
description).
