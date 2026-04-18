# Design — Domain skeleton

## File layout

```
src/domain/
├── index.ts                              barrel
├── entities/
│   ├── payment-intent.ts
│   ├── subscription.ts
│   ├── escrow.ts
│   ├── payout.ts
│   ├── refund.ts
│   ├── dispute.ts
│   └── donation.ts
├── value-objects/
│   ├── money.ts
│   ├── idempotency-key.ts
│   ├── gateway-ref.ts
│   └── three-ds-challenge.ts
├── ports/
│   ├── index.ts
│   ├── payment-gateway-port.ts
│   ├── subscription-port.ts
│   ├── webhook-verifier-port.ts
│   ├── payout-port.ts
│   ├── escrow-port.ts
│   ├── donation-port.ts
│   ├── agentic-payment-port.ts
│   ├── idempotency-store-port.ts
│   └── reconciliation-reader-port.ts
├── events/
│   ├── index.ts
│   ├── payment-events.ts
│   ├── subscription-events.ts
│   ├── escrow-events.ts
│   ├── payout-events.ts
│   └── donation-events.ts
└── errors/
    ├── domain-error.ts                  base class
    ├── invalid-state-transition.ts
    ├── currency-mismatch.ts
    └── idempotency-conflict.ts
```

## Value object: `Money`

```ts
export class Money {
  private constructor(
    public readonly amountMinor: bigint,
    public readonly currency: string,
  ) {}

  static of(amountMinor: bigint | number, currency: string): Money {
    const minor = typeof amountMinor === 'number' ? BigInt(amountMinor) : amountMinor;
    if (minor < 0n) throw new DomainError('Money cannot be negative');
    if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError('Currency must be ISO 4217');
    return new Money(minor, currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    if (this.amountMinor < other.amountMinor)
      throw new DomainError('Result would be negative');
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
```

`bigint` is used over `number` because card-issuer ledgers routinely exceed `Number.MAX_SAFE_INTEGER` when currency is COP (1 USD ≈ 4,000 COP in minor units = 400,000). Safer to be bigint-native from day one than to retrofit.

## Entity example: `PaymentIntent`

```ts
export type PaymentIntentStatus =
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export class PaymentIntent {
  private constructor(
    public readonly id: string,
    public readonly consumer: string,
    public readonly amount: Money,
    public readonly idempotencyKey: IdempotencyKey,
    public readonly gatewayRef: GatewayRef | null,
    public readonly metadata: Readonly<Record<string, string>>,
    public status: PaymentIntentStatus,
  ) {}

  static initiate(input: InitiateInput): PaymentIntent { /* ... */ }

  requireAction(challenge: ThreeDSChallenge): void {
    this.assertCurrentStatus(['requires_confirmation']);
    this.status = 'requires_action';
  }

  markProcessing(): void { /* ... */ }
  markSucceeded(gatewayRef: GatewayRef): void { /* ... */ }
  markFailed(reason: string): void { /* ... */ }
  cancel(): void { /* ... */ }

  private assertCurrentStatus(allowed: PaymentIntentStatus[]): void {
    if (!allowed.includes(this.status))
      throw new InvalidStateTransitionError(this.status, allowed);
  }
}
```

Same pattern for the other six entities. The state transitions are documented in each entity's JSDoc block.

## Port example: `PaymentGatewayPort`

```ts
export interface PaymentGatewayPort {
  readonly gateway: GatewayName;

  initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  confirm(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult>;
  refund(input: RefundPaymentInput): Promise<RefundPaymentResult>;
}

export interface InitiatePaymentInput {
  readonly amount: Money;
  readonly consumer: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
  readonly returnUrl?: string;           // optional; card-present gateways ignore
  readonly cancelUrl?: string;
}

export interface InitiatePaymentResult {
  readonly gatewayRef: GatewayRef;
  readonly requiresAction: boolean;
  readonly challenge?: ThreeDSChallenge;
  readonly checkoutUrl?: string;
}
```

Every mutating method requires an `IdempotencyKey`. Every gateway declares its own `gateway: GatewayName` so the factory in `application-use-cases` can route by it.

## Port example: `AgenticPaymentPort`

Shape declared here; detailed semantics (scoped-JWT, audit trail, `tool_call_id`) are in `agentic-core-extension` and `stripe-agentic-commerce-p1`:

```ts
export interface AgenticPaymentPort {
  initiateAgenticPayment(input: AgenticPaymentInput): Promise<AgenticPaymentResult>;
}

export interface AgenticPaymentInput {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly scopedJwt: string;              // signed by agentic-core
  readonly amount: Money;
  readonly merchant: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
}
```

## Ports that do NOT belong in v1

Explicitly not declared in this change:

- `InvoiceGeneratorPort` — lives in `invoice-core`.
- `KycPort` — lives in `compliance-core`.
- `LedgerWriterPort` — premature; the application layer writes directly to Postgres via a repository-level port added in `application-use-cases`.
- `CryptoRampPort` — on-chain ramp primitives live inside `ripple-xrpl-adapter` as internals, not as a cross-adapter port.

## Architectural invariants (enforced in CI)

The `eslint.config.js` from `repo-bootstrap` gains an `no-restricted-imports` rule block targeting `src/domain/**`:

```js
'no-restricted-imports': ['error', {
  patterns: [
    { group: ['@grpc/*', 'stripe', 'pg', 'node-fetch', 'axios'],
      message: 'Domain layer must not depend on I/O libraries' },
    { group: ['../adapters/*', '../application/*', '../infrastructure/*'],
      message: 'Domain must not depend on outer layers' },
  ],
}],
```

## Risks

- **Bigint interop with proto-ts** — ts-proto emits `string` for `int64` by default (to preserve precision across JSON); the domain uses `bigint`. The boundary translator (`src/adapters/inbound/grpc/translators.ts`, landing with `grpc-server-inbound`) bridges them. Do not leak `string` money amounts into the domain.
- **Entity bloat** — `PaymentIntent` can easily accumulate fields. Mitigation: if a field is used only by one gateway, put it in `metadata`, not as a typed field.
- **State machine explosion** — every new state transition needs a test. Mitigation: a shared `StateMachineTest` helper enumerates the transition table and asserts invalid transitions throw.
- **Shared `DomainError` semantics** — the application layer converts `DomainError` to gRPC `status.INVALID_ARGUMENT` or `FAILED_PRECONDITION`. That mapping is declared in `application-use-cases`, not here.

## Rollback

Revert. The repo returns to the post-`proto-contract-v1` state. Adapter and application changes that depend on the domain types cannot compile; they block until re-landed.
