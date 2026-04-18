# Design — Tilopay adapter (P1)

## File layout

```
src/adapters/outbound/tilopay/
├── index.ts
├── tilopay-client-factory.ts
├── tilopay-http-client.ts                 or SDK wrapper if SDK exists
├── tilopay-adapter.ts                     PaymentGatewayPort
├── tilopay-subscription-adapter.ts        SubscriptionPort
├── tilopay-webhook-verifier.ts
├── tilopay-reconciliation-reader.ts
├── tilopay-error-mapper.ts
├── tilopay-event-translator.ts
└── types.ts                                reverse-modeled from Postman collection
```

## Source-of-truth verification

Before writing any code:

1. Visit Tilopay's developer documentation portal (TODO: verify URL — typically `https://developers.tilopay.com/` or similar; confirm the live URL at implementation time).
2. Download the current Postman collection.
3. Run the collection against Tilopay sandbox credentials; capture the responses for:
   - charge create (approved)
   - charge create (declined)
   - refund
   - subscription create
   - subscription webhook
   - error response variants (400, 401, 422, 429, 500)
4. Record access dates in a "Docs verification log" at the bottom of this file when the adapter lands.
5. Reverse-model TS types in `types.ts` from the captured responses, not from speculation.

If a published Tilopay Node SDK is maintained and typed, the adapter uses it and `types.ts` re-exports the SDK types. Otherwise the hand-written path applies.

## Client factory

```ts
export interface TilopayClientConfig {
  readonly apiBaseUrl: string;              // TODO: verify canonical URL
  readonly apiKey: string;
  readonly apiSecret?: string;              // TODO: verify auth model (key+secret or bearer?)
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export function createTilopayClient(config: TilopayClientConfig): TilopayHttpClient {
  return new TilopayHttpClient(config);
}
```

Same single-instantiation discipline as Stripe / OnvoPay: one factory site, ESLint rule against direct construction anywhere else.

## Adapter shape

Mirrors Stripe / OnvoPay:

```ts
export class TilopayAdapter implements PaymentGatewayPort {
  readonly gateway = 'tilopay' as const;

  constructor(
    private readonly http: TilopayHttpClient,
    private readonly errorMapper: TilopayErrorMapper,
    private readonly logger: Logger,
  ) {}

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    // Build request body from Postman collection shape.
    // Attach idempotency header (name TBD — TODO: verify against docs).
    // Map response to InitiatePaymentResult.
  }

  async confirm(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> { /* ... */ }
  async refund(input: RefundPaymentInput): Promise<RefundPaymentResult> { /* ... */ }
}
```

## Subscription adapter

Tilopay's recurring-billing model details are documented in their Postman collection's `subscriptions` folder (TODO: verify). The adapter:

- Creates a subscription with plan + customer + payment-method references.
- Lists subscriptions for reconciliation.
- Cancels at period end by default; `cancelAtPeriodEnd: false` flag for immediate cancel.

If Tilopay's recurring model differs structurally from Stripe/OnvoPay (e.g. no concept of "past_due" status), the adapter translates whatever states it does have into the nearest domain states and documents the mapping in `docs/content/docs/adapters/tilopay.md`.

## Webhook verification

TODO: verify against Tilopay's docs. Common patterns to check:

- HMAC-SHA256 of raw body with a shared secret in a header like `x-tilopay-signature`.
- Signed JWT in a header.
- Timestamp + nonce in a header, signed together with the body.

Whichever Tilopay uses is implemented in `tilopay-webhook-verifier.ts` with `timingSafeEqual` for comparisons. The raw body is preserved by the inbound gRPC adapter and never parsed before verification.

## Event translation

Tentative table (confirm against Tilopay's webhook docs):

| Tilopay event (TODO) | Domain event |
|---|---|
| `charge.approved` | `PaymentSucceeded` |
| `charge.declined` | `PaymentFailed` |
| `charge.refunded` | `PaymentRefunded` |
| `subscription.activated` | `SubscriptionActivated` |
| `subscription.renewal.failed` | `SubscriptionPastDue` |
| `subscription.canceled` | `SubscriptionCanceled` |

## Error mapping

```ts
map(err: unknown): ApplicationError {
  if (err instanceof TilopayHttpError) {
    switch (err.status) {
      case 400: return new ApplicationError('GATEWAY_INVALID_REQUEST', err.message);
      case 401: return new ApplicationError('GATEWAY_AUTH_FAILED', err.message);
      case 402: return new ApplicationError('GATEWAY_CARD_DECLINED', err.message);
      case 409: return new ApplicationError('IDEMPOTENCY_CONFLICT', err.message);
      case 422: return new ApplicationError('GATEWAY_INVALID_REQUEST', err.message);
      case 429: return new ApplicationError('GATEWAY_RATE_LIMITED', err.message);
      case 500:
      case 502:
      case 503:
        return new ApplicationError('GATEWAY_UNAVAILABLE', err.message);
    }
  }
  this.logger.error({ err }, 'unmapped tilopay error');
  return new ApplicationError('GATEWAY_INTERNAL', 'tilopay internal error');
}
```

## Environment

```
TILOPAY_API_BASE_URL=              # TODO: verify canonical URL
TILOPAY_API_KEY=
TILOPAY_API_SECRET=                # TODO: verify auth model
TILOPAY_WEBHOOK_SIGNING_SECRET=
TILOPAY_TIMEOUT_MS=15000
TILOPAY_MAX_RETRIES=2
```

## Routing integration

The `GatewayRegistry.resolve()` routing table seeded in this change adds:

- `(currency: CRC, consumer_segment: b2b) → tilopay`
- `(currency: USD, consumer_segment: b2b, country: CR) → tilopay`
- Fallback to OnvoPay for b2c; Stripe for non-CR.

`consumer_segment` is a metadata field the consumer backend attaches; `payments-core` treats it as opaque.

## Risks

- **Doc staleness** — Tilopay's Postman collection and docs may have changed since 2025. Implementation MUST re-verify against the live artifacts, not trust this doc's assumed shapes.
- **No official Node SDK assumption** — if one exists and is maintained, switch to it. If one exists but is abandoned (unmaintained, last commit > 1 year ago), prefer the hand-written path.
- **B2B acceptance-rate claim** — the proposal asserts Tilopay outperforms Stripe for CR B2B. The implementer should validate this with Vertivolatam after a month of live traffic; if false, this change's value prop is re-evaluated.
- **Segmentation overlap with OnvoPay** — if a consumer ends up dual-routing (b2c → OnvoPay, b2b → Tilopay) with no clean split, the routing table becomes ambiguous. Mitigation: `consumer_segment` is mandatory in Tilopay routes; ambiguous cases fall back to OnvoPay with a warning log.

## Rollback

Revert. Stripe and OnvoPay remain as the two available gateways; Vertivolatam and AduaNext Flow B use Stripe as fallback. No data loss.

## Docs verification log

- [ ] Tilopay developer portal URL — TODO at implementation
- [ ] Postman collection download URL — TODO at implementation
- [ ] Webhook signature algorithm — TODO
- [ ] Event type names — TODO
- [ ] Minor-unit convention per currency — TODO
- [ ] Access date — TODO at implementation
