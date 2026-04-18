# Design — OnvoPay adapter (P0)

## File layout

```
src/adapters/outbound/onvopay/
├── index.ts
├── onvopay-client-factory.ts             single HTTP client construction
├── onvopay-http-client.ts                typed wrapper around fetch
├── onvopay-adapter.ts                    implements PaymentGatewayPort
├── onvopay-subscription-adapter.ts       implements SubscriptionPort
├── onvopay-webhook-verifier.ts           implements WebhookVerifierPort
├── onvopay-reconciliation-reader.ts      implements ReconciliationReaderPort
├── onvopay-error-mapper.ts
├── onvopay-event-translator.ts
└── types.ts                               TS types reverse-modeled from docs.onvopay.com
```

## HTTP client

OnvoPay does not publish an official Node SDK at time of writing (TODO: verify against https://docs.onvopay.com/ on implementation). We hand-write a thin typed wrapper:

```ts
export interface OnvoPayClientConfig {
  readonly apiBaseUrl: string;            // https://api.onvopay.com by default (TODO: verify)
  readonly apiKey: string;                // OnvoPay secret key
  readonly timeoutMs: number;
  readonly maxRetries: number;            // adapter retries on 5xx / 429 only
}

export class OnvoPayHttpClient {
  constructor(private readonly config: OnvoPayClientConfig) {}

  async request<T>(path: string, init: RequestInit): Promise<T> {
    // attach Authorization header, idempotency-key if provided,
    // retry with exponential backoff on 5xx/429 (maxRetries times)
    // throw typed OnvoPayHttpError on non-2xx
  }
}
```

Retries inside the adapter are safe because the use case layer owns overall retry logic (none today; the adapter does short bursts for transient 429s only).

## Adapter example

```ts
export class OnvoPayAdapter implements PaymentGatewayPort {
  readonly gateway = 'onvopay' as const;

  constructor(
    private readonly http: OnvoPayHttpClient,
    private readonly errorMapper: OnvoPayErrorMapper,
    private readonly logger: Logger,
  ) {}

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    try {
      const body = {
        amount: Number(input.amount.amountMinor),       // TODO: verify OnvoPay uses minor units
        currency: input.amount.currency,
        description: input.metadata.description ?? undefined,
        metadata: { ...input.metadata, consumer: input.consumer },
      };
      const charge = await this.http.request<OnvoPayCharge>('/v1/charges', {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey.toString() },
        body: JSON.stringify(body),
      });
      return {
        gatewayRef: { kind: 'onvopay', chargeId: charge.id },
        requiresAction: charge.status === 'requires_action',
        challenge: charge.status === 'requires_action'
          ? { gateway: 'onvopay', payload: Buffer.from(charge.next_action?.redirect_url ?? '') }
          : undefined,
        checkoutUrl: charge.checkout_url ?? undefined,
      };
    } catch (err) {
      throw this.errorMapper.map(err);
    }
  }
}
```

Any field shapes above (`charge.id`, `checkout_url`, `next_action.redirect_url`, minor-unit convention) must be verified against the live docs at implementation time; where the docs have not been re-checked, the code carries an inline `// TODO: verify against docs.onvopay.com`.

## Recurring billing (`SubscriptionPort`)

OnvoPay's recurring billing page (`/#/Cargos-recurrentes`) describes the plan + subscription creation flow. The adapter:

- Creates a plan with `amount_minor`, `currency`, `interval` (`month` | `year`), `interval_count`.
- Creates a subscription against `(customer_id, plan_id, payment_method_id)`.
- Webhook `subscription.charged` → `SubscriptionRenewal` domain event (TODO: verify exact event names).

If recurring billing on OnvoPay is limited to certain merchant categories, that restriction is documented in `docs/content/docs/adapters/onvopay.md`.

## Webhook verification

OnvoPay signs webhooks using HMAC-SHA256 (TODO: verify algorithm and header name against the webhook section of docs.onvopay.com). Pseudo:

```ts
async verify(headers: Record<string, string>, rawBody: Buffer): Promise<DomainEvent> {
  const sig = headers['onvopay-signature'];                   // TODO: verify header name
  const expected = createHmac('sha256', this.signingSecret).update(rawBody).digest('hex');
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')))
    throw new WebhookSignatureError('invalid onvopay signature');

  const event = JSON.parse(rawBody.toString('utf-8'));
  return this.translator.translate(event);
}
```

`timingSafeEqual` prevents signature comparison timing attacks.

## Event translator (tentative)

| OnvoPay event (TODO: verify) | Domain event |
|---|---|
| `charge.succeeded` | `PaymentSucceeded` |
| `charge.failed` | `PaymentFailed` |
| `charge.refunded` | `PaymentRefunded` |
| `charge.disputed` | `PaymentDisputed` |
| `subscription.activated` | `SubscriptionActivated` |
| `subscription.past_due` | `SubscriptionPastDue` |
| `subscription.canceled` | `SubscriptionCanceled` |

Actual event names must be confirmed against OnvoPay's documentation at implementation time. If names differ, update the table and the `onvopay-event-translator.ts` file accordingly.

## Error mapping

```ts
map(err: unknown): ApplicationError {
  if (err instanceof OnvoPayHttpError) {
    switch (err.status) {
      case 401: return new ApplicationError('GATEWAY_AUTH_FAILED', err.message);
      case 402: return new ApplicationError('GATEWAY_CARD_DECLINED', err.message);
      case 409: return new ApplicationError('IDEMPOTENCY_CONFLICT', err.message);
      case 422: return new ApplicationError('GATEWAY_INVALID_REQUEST', err.message);
      case 429: return new ApplicationError('GATEWAY_RATE_LIMITED', err.message);
      case 503: return new ApplicationError('GATEWAY_UNAVAILABLE', err.message);
    }
  }
  this.logger.error({ err }, 'unmapped onvopay error');
  return new ApplicationError('GATEWAY_INTERNAL', 'onvopay internal error');
}
```

## Environment

```
ONVOPAY_API_BASE_URL=               # defaults to https://api.onvopay.com (TODO: verify)
ONVOPAY_API_KEY=
ONVOPAY_WEBHOOK_SIGNING_SECRET=
ONVOPAY_TIMEOUT_MS=15000
ONVOPAY_MAX_RETRIES=2
```

## Risks

- **Doc drift** — `docs.onvopay.com` may have changed between this design and implementation. Every field name and event type in this doc is marked with a TODO and must be confirmed against the live docs by the implementing agent. Do NOT skip verification.
- **No official SDK** — we maintain the HTTP client ourselves. Mitigation: narrow surface (3–4 endpoints in v1), typed with Zod at the boundary, tested against docs fixtures.
- **Signature algorithm assumption** — HMAC-SHA256 is the common default but OnvoPay may use a different scheme. Implementation MUST verify before merging.
- **Rate limits** — no documented rate limit behavior; the adapter retries 429 twice with exponential backoff and surfaces the error on third failure.
- **CRC amount minor-unit convention** — CRC has no minor units in practice (decimals rarely used); OnvoPay's minor-unit convention must be confirmed to avoid off-by-100 errors.

## Rollback

Revert. Stripe remains as the sole gateway; consumers routing to OnvoPay must switch to Stripe (or fail, per routing policy). CR-merchant acceptance rates may drop; the operational doc includes this in the incident note.
