# Design — Application use cases

## Reconciliation note — 13 → 14 (2026-04-18)

The initial draft of this document enumerated **13** use cases, reflecting an
earlier expansion that predated the freeze of `proto-contract-v1`. The
authoritative proto service `lapc506.payments_core.v1.PaymentsCore`
declares **14 RPCs**; the missing entry was `DisputeEscrow` (escrow-side
dispute distinct from `DisputePort.submitEvidence`, which handles
chargeback-style disputes on `PaymentIntent`s).

Where this document and the proto disagree, the proto wins. The tasks
checklist in `tasks.md` has been updated to 14 entries; `proposal.md` is
unchanged because its "why" section remains accurate.

## File layout

To honor the 15-file budget tracked on issue #18, the 14 use cases are
grouped into seven sub-domain files rather than one file per use case. The
actual layout landed in this change is:

```
src/application/
├── index.ts                                 barrel (exports the 14 use cases)
└── use_cases/
    ├── checkout.ts                          InitiateCheckout, ConfirmCheckout, RefundPayment
    ├── subscription.ts                      Create, Switch, Cancel
    ├── escrow.ts                            Hold, Release, Dispute
    ├── payout.ts                            CreatePayout (+ PayoutGatewayPort declaration)
    ├── webhook.ts                           ProcessWebhook
    ├── agentic.ts                           HandleAgenticPayment
    └── reads.ts                             GetPaymentHistory, ReconcileDaily
```

Repository ports, registry ports, and the idempotency store are declared
alongside the use cases that consume them (inside each sub-domain file)
rather than in a dedicated `ports/` tree — the ports-per-entity split in
the initial design over-engineered the boundary and added ~7 files without
a matching increase in clarity. The `IdempotencyPort`, `FXRatePort`,
`WebhookVerifierPort`, `AgenticPaymentPort`, and `ReconciliationPort` ports
already declared in `src/domain/ports/` are consumed directly.

In-memory adapters and `errors.ts` are deferred to a follow-up change —
the tests in `test/application/**` use plain stubs (per-test factory
helpers), which keeps this change under the file budget and defers the
cross-cutting error-mapping table until the inbound gRPC layer needs it.

## Use case shape

Each use case is a class instantiated with its dependencies (constructor injection); the handler is a single `execute(input)` method. Example:

```ts
export class InitiateCheckout {
  constructor(
    private readonly gateways: GatewayRegistryPort,
    private readonly repo: PaymentIntentRepositoryPort,
    private readonly idempotency: IdempotencyStorePort,
    private readonly bus: EventBusPort,
  ) {}

  async execute(input: InitiateCheckoutInput): Promise<InitiateCheckoutResult> {
    const cached = await this.idempotency.check(input.idempotencyKey, 'initiate-checkout');
    if (cached) return cached as InitiateCheckoutResult;

    const gateway = this.gateways.resolve(input.gatewayPreference);
    const intent = PaymentIntent.initiate({
      consumer: input.consumer,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    });

    const gatewayResult = await gateway.initiate({
      amount: input.amount,
      consumer: input.consumer,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
    });

    if (gatewayResult.requiresAction) intent.requireAction(gatewayResult.challenge!);
    else intent.markProcessing();

    await this.repo.save(intent);

    const result: InitiateCheckoutResult = {
      intentId: intent.id,
      requiresAction: gatewayResult.requiresAction,
      challenge: gatewayResult.challenge,
      checkoutUrl: gatewayResult.checkoutUrl,
    };
    await this.idempotency.record(input.idempotencyKey, 'initiate-checkout', result);
    return result;
  }
}
```

## Idempotency protocol

Key pattern: `IdempotencyStorePort.check(key, operation) → result | null` + `record(key, operation, result)`.

- Keys are scoped by **operation name** so the same key can be reused across unrelated use cases (rare, but safe).
- Records are stored with a TTL of 24 hours. Replays beyond the TTL return `null` and the operation re-runs (gateway idempotency takes over).
- The in-memory impl uses a `Map` with a `setTimeout` GC; the Postgres impl (infra change) uses a unique constraint on `(operation, key)`.

## Gateway selection

`GatewayRegistryPort`:

```ts
export interface GatewayRegistryPort {
  resolve(preference: GatewayPreference): PaymentGatewayPort;
  resolveForWebhook(source: GatewayName): WebhookVerifierPort;
  listActive(): PaymentGatewayPort[];
}
```

Default impl (in the inbound adapter's wiring, not in the application layer) does:

- If `preference === AUTO`, picks based on `(currency, consumer_tenant_country)` routing table seeded per adapter change.
- Otherwise, returns the adapter for the requested gateway; throws `UnknownGatewayError` if not registered.

## Webhook processing

`ProcessWebhook` takes raw headers + body, picks the verifier, decodes, and dispatches:

```ts
async execute(input: ProcessWebhookInput): Promise<void> {
  const verifier = this.gateways.resolveForWebhook(input.source);
  const event = await verifier.verify(input.headers, input.rawBody);

  const seen = await this.idempotency.check(event.id, `webhook:${input.source}`);
  if (seen) return;

  switch (event.type) {
    case 'payment.succeeded': await this.confirm.execute({ intentId: event.intentId, ... }); break;
    case 'charge.refunded': /* ... */ break;
    case 'charge.dispute.created': /* ... */ break;
    // ...
  }

  await this.idempotency.record(event.id, `webhook:${input.source}`, { handled: true });
}
```

The verifier returns a gateway-agnostic domain event. Gateway-specific parsing stays in the adapter.

## Error mapping table (`errors.ts`)

| Domain error | Application code | gRPC status (set in grpc adapter) |
|---|---|---|
| `InvalidStateTransitionError` | `INVALID_STATE` | `FAILED_PRECONDITION` |
| `CurrencyMismatchError` | `CURRENCY_MISMATCH` | `INVALID_ARGUMENT` |
| `IdempotencyConflictError` | `IDEMPOTENCY_CONFLICT` | `ALREADY_EXISTS` |
| (gateway port threw `RateLimited`) | `GATEWAY_RATE_LIMITED` | `RESOURCE_EXHAUSTED` |
| (gateway port threw `Unauthorized`) | `GATEWAY_AUTH_FAILED` | `UNAUTHENTICATED` |
| (gateway port threw `Unavailable`) | `GATEWAY_UNAVAILABLE` | `UNAVAILABLE` |
| `UnknownGatewayError` | `UNKNOWN_GATEWAY` | `NOT_FOUND` |

## Logging and tracing

Every use case accepts an optional `logger` in its constructor. No `console.log` anywhere. The logger interface is minimal (`info/warn/error` with a structured payload); actual pino/winston wiring is in the infra layer.

Tracing spans are added via a decorator pattern in a later change (`observability`). This change does not wire OTel.

## In-memory adapters (test-only)

Lives under `src/application/in-memory/`. NOT exported from the package entrypoint:

- `InMemoryIdempotencyStore`
- `InMemoryPaymentIntentRepository` (and one per entity)
- `InMemoryEventBus` (records emitted events on an array for assertions)
- `FakePaymentGateway` — deterministic fake implementing `PaymentGatewayPort`; used by every use case test.

The ESLint `no-restricted-imports` rule forbids `src/application/in-memory/**` from being imported by anything under `src/adapters/**` or `src/domain/**`.

## Risks

- **Use case over-injection** — some use cases (e.g. `ProcessWebhook`) need 4–5 dependencies. Mitigation: accept it. Do not collapse into a god class.
- **Repository port proliferation** — 7 repository ports is a lot. Mitigation: if three or more repositories end up with identical shapes (load by id, save, delete), extract a generic `Repository<T>` base interface and have the concrete ports extend it. Do not do this preemptively.
- **Event bus ordering** — if multiple events fire from one use case (e.g. `EscrowReleased` + implicit `PaymentSucceeded`), ordering matters for consumers. Mitigation: emit in the same order the state transitions occurred; document this invariant in `EventBusPort`.
- **Idempotency replay corner** — if the original call crashed AFTER persisting but BEFORE responding, the replay returns the cached result but the caller never got the first one. Mitigation: documented; acceptable for v1.
- **GetPaymentHistory N+1** — if naive, the list query fetches each intent then each refund separately. Mitigation: the query goes via a dedicated `PaymentHistoryReaderPort` that returns a flattened shape; separate from `PaymentIntentRepositoryPort`.

## Rollback

Revert. Adapter changes still compile (they depend on domain, not application). The inbound gRPC change cannot compile; it blocks until re-landed.
