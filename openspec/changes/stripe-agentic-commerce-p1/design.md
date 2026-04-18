# Design — Stripe agentic commerce (P1)

## File layout (additions)

```
src/
├── domain/ports/
│   └── agentic-payment-port.ts            (expanded from domain-skeleton stub)
├── application/
│   ├── use-cases/
│   │   └── handle-agentic-payment.ts      (body filled in — was skeleton)
│   └── ports/
│       └── agentic-jwt-verifier-port.ts   new application-level port
├── adapters/outbound/stripe/
│   ├── stripe-agentic-adapter.ts
│   ├── stripe-agentic-event-translator.ts
│   └── stripe-agentic-jwt-verifier.ts     or a no-op if verification lives in agentic-core
└── infrastructure/auth/
    └── agentic-core-jwt-verifier.ts       default impl: fetch agentic-core's JWKS
```

## Source-of-truth verification

Before writing code:

1. Visit the Stripe documentation page for "Enable in-context selling on AI agents" at https://docs.stripe.com/ (TODO: verify canonical URL). Capture the:
   - Endpoint paths used for agent-initiated payments.
   - Required and optional headers (`Stripe-Version`, `Stripe-Agent-Id`, `Stripe-Tool-Call-Id` — TODO: verify).
   - Scoped-JWT claim structure and verification guidance.
   - New webhook event types.
2. Record the documentation access date at the bottom of this file under "Docs verification log".
3. Model every type in the adapter from the documented shapes, not from speculation. TODO markers remain on any field that was not observed in a live response.

## `AgenticPaymentPort` expansion

```ts
export interface AgenticPaymentPort {
  readonly gateway: GatewayName;

  initiateAgenticPayment(input: AgenticPaymentInput): Promise<AgenticPaymentResult>;
}

export interface AgenticPaymentInput {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly scopedJwt: string;
  readonly amount: Money;
  readonly merchant: string;                 // merchant id on the consumer platform
  readonly humanApprovalId?: string;         // set by agentic-core if approval was required
  readonly consumer: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AgenticPaymentResult {
  readonly paymentIntentId: string;
  readonly gatewayRef: GatewayRef;
  readonly requiresHumanReview: boolean;
  readonly riskSignals: Readonly<Record<string, string>>;
}
```

## JWT verification

### `AgenticJwtVerifierPort` (application layer)

```ts
export interface AgenticJwtVerifierPort {
  verify(scopedJwt: string, expected: ExpectedClaims): Promise<VerifiedClaims>;
}

export interface ExpectedClaims {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly audience: 'payments-core';
  readonly maxAgeSeconds: number;            // default 300
}

export interface VerifiedClaims {
  readonly jti: string;
  readonly sub: string;                      // the human user id
  readonly agentId: string;
  readonly toolCallId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly scope: string[];                  // must include 'payment:initiate'
}
```

### `AgenticCoreJwtVerifier` (default impl)

- Fetches `agentic-core`'s JWKS from `env.AGENTIC_CORE_JWKS_URL` (cached with a 10-minute TTL).
- Verifies signature (RS256 or EdDSA — TODO: confirm with agentic-core's issuer config).
- Enforces `aud === 'payments-core'`, `iss === agentic-core`, `exp` not expired, `iat` within `maxAgeSeconds`.
- Enforces `'payment:initiate' ∈ scope`.
- Mismatched `agent_id` or `tool_call_id` rejects with `GATEWAY_AUTH_FAILED`.

### Why re-verify when agentic-core already issued it

Defense in depth. `payments-core` is on the hot path for money movement; we do not trust the gRPC metadata blindly. If agentic-core's issuing key is ever leaked and revoked, `payments-core` should reject its replacement tokens the moment the JWKS is refreshed.

## `HandleAgenticPayment` use case body

```ts
async execute(input: HandleAgenticPaymentInput): Promise<HandleAgenticPaymentResult> {
  const cached = await this.idempotency.check(input.idempotencyKey, 'agentic-payment');
  if (cached) return cached as HandleAgenticPaymentResult;

  const claims = await this.jwtVerifier.verify(input.scopedJwt, {
    agentId: input.agentId,
    toolCallId: input.toolCallId,
    audience: 'payments-core',
    maxAgeSeconds: 300,
  });

  const gateway = this.agenticGateways.resolve(input.gatewayPreference);   // v1: stripe only
  const agenticResult = await gateway.initiateAgenticPayment({
    agentId: input.agentId,
    toolCallId: input.toolCallId,
    scopedJwt: input.scopedJwt,
    amount: input.amount,
    merchant: input.merchant,
    humanApprovalId: input.humanApprovalId,
    consumer: input.consumer,
    idempotencyKey: input.idempotencyKey,
    metadata: {
      ...input.metadata,
      agent_id: input.agentId,
      tool_call_id: input.toolCallId,
      scoped_jwt_jti: claims.jti,
    },
  });

  const intent = PaymentIntent.fromAgentic({
    id: agenticResult.paymentIntentId,
    amount: input.amount,
    consumer: input.consumer,
    idempotencyKey: input.idempotencyKey,
    agentMetadata: {
      agentId: input.agentId,
      toolCallId: input.toolCallId,
      scopedJwtJti: claims.jti,
      humanApprovalId: input.humanApprovalId,
    },
  });
  await this.paymentIntentRepo.save(intent);

  const result = { /* ... */ };
  await this.idempotency.record(input.idempotencyKey, 'agentic-payment', result);
  return result;
}
```

## Stripe agentic adapter

```ts
export class StripeAgenticAdapter implements AgenticPaymentPort {
  readonly gateway = 'stripe' as const;

  constructor(
    private readonly client: Stripe,
    private readonly errorMapper: StripeErrorMapper,
    private readonly logger: Logger,
  ) {}

  async initiateAgenticPayment(input: AgenticPaymentInput): Promise<AgenticPaymentResult> {
    try {
      const intent = await this.client.paymentIntents.create(
        {
          amount: Number(input.amount.amountMinor),
          currency: input.amount.currency.toLowerCase(),
          metadata: input.metadata,
          // TODO: verify the exact Stripe API field names for agent-initiated payments
          // Likely fields: agent_id, tool_call_id, agent_session (under a new namespace)
        },
        {
          idempotencyKey: input.idempotencyKey.toString(),
          apiVersion: STRIPE_AGENTIC_API_VERSION,              // may differ from baseline
          stripeAccount: undefined,
          // TODO: verify whether Stripe expects a distinct Stripe-Agent header
        },
      );
      return {
        paymentIntentId: intent.id,
        gatewayRef: { kind: 'stripe', paymentIntentId: intent.id },
        requiresHumanReview: intent.review?.reason === 'manual_review',   // TODO: verify
        riskSignals: intent.metadata ?? {},
      };
    } catch (err) {
      throw this.errorMapper.map(err);
    }
  }
}
```

Every field marked TODO must be confirmed against live Stripe documentation during implementation.

## Event translation additions

| Stripe event (TODO: verify) | Domain event |
|---|---|
| `payment_intent.agent_initiated.succeeded` | `PaymentSucceeded` (with `source: 'agent'` in metadata) |
| `payment_intent.agent_initiated.failed` | `PaymentFailed` (with `source: 'agent'`) |
| `payment_intent.agent_initiated.requires_review` | `AgenticPaymentNeedsReview` (new domain event) |

If Stripe does not fire agent-specific event types but instead reuses the standard `payment_intent.*` with an additional metadata flag, the translator inspects the metadata block to branch instead. Actual event names are verified at implementation time.

## gRPC boundary

This change does not modify `proto-contract-v1`. The `InitiateAgenticPayment` RPC and its request/response messages are already frozen; this change only fills in what happens behind it.

Cross-repo boundary with `agentic-core`:
- agentic-core builds the scoped JWT, calls `InitiateAgenticPayment` RPC with `(agent_id, tool_call_id, scoped_jwt, amount, merchant, idempotency_key)`.
- `payments-core` returns `(payment_intent_id, requires_human_review, risk_signals)`.
- agentic-core's matching change is `agentic-core-extension` (in this repo's OpenSpec tree, declared as a cross-repo proposal).

## Environment

Additions on top of Stripe P0:

```
STRIPE_AGENTIC_API_VERSION=        # Stripe API version for agentic endpoints if different from baseline
AGENTIC_CORE_JWKS_URL=             # where to fetch agentic-core's public keys
AGENTIC_CORE_ISSUER=               # expected `iss` claim value
```

## Risks

- **Stripe's agentic product is evolving** — field names, event types, and API versioning may change. Implementation MUST re-verify Stripe's docs at merge time, not trust this design doc's field names.
- **Scoped JWT clock skew** — `maxAgeSeconds` of 300 allows 5 minutes of clock drift; shorter values risk rejecting legitimate calls, longer values expand replay window. Mitigation: configurable per deployment.
- **JWKS unavailability** — if agentic-core's JWKS endpoint is down, `payments-core` cannot verify tokens. Mitigation: cache JWKS for 10 minutes in-memory; surface `GATEWAY_UNAVAILABLE` on cache miss + fetch failure rather than failing open.
- **Replay attacks** — the JWT `jti` is recorded on each payment; a second use of the same `jti` is rejected via idempotency. Mitigation: `jti` uniqueness is enforced in the idempotency table.
- **Audit trail privacy** — `agent_id` is non-sensitive, but `tool_call_id` may leak information about internal agent structure. Mitigation: log it server-side only; do not echo it in event payloads sent to third-party consumers.

## Rollback

Revert. Baseline Stripe flows remain. Agentic payments return `UNIMPLEMENTED` on the gRPC boundary. agentic-core continues to work for non-payment tool calls. Re-landing requires this change and `agentic-core-extension` to merge together.

## Docs verification log

- [ ] Stripe agentic-commerce doc URL — TODO
- [ ] Stripe API version for agentic endpoints — TODO
- [ ] Event type names — TODO
- [ ] Agent-identifier header names — TODO
- [ ] Scoped-JWT claim structure — TODO
- [ ] Access date — TODO at implementation
