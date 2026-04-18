# Tasks — Domain skeleton

## Linear

- Title: `payments-core: domain skeleton (7 entities + 4 VOs + 9 ports + events)`
- Labels: `domain`, `typescript`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-domain-skeleton`.
- Blocked by: `proto-contract-v1`.
- Blocks: every adapter change, `application-use-cases`, `grpc-server-inbound`.

## Implementation checklist

### Value objects

- [ ] `src/domain/value-objects/money.ts` — `Money` with `bigint` amount, ISO-4217 currency guard, `plus` / `minus` / `times` / `equals`.
- [ ] `src/domain/value-objects/idempotency-key.ts` — branded string, regex guard.
- [ ] `src/domain/value-objects/gateway-ref.ts` — discriminated union over the 8 gateways in `GatewayPreference`.
- [ ] `src/domain/value-objects/three-ds-challenge.ts` — opaque payload wrapper.

### Entities (state-machine semantics per `design.md`)

- [ ] `PaymentIntent` with 6 statuses; transition methods throw on invalid transitions.
- [ ] `Subscription` with `trialing | active | past_due | canceled | expired`.
- [ ] `Escrow` with `held | partial_released | released | refunded | disputed`.
- [ ] `Payout` with `pending | in_transit | paid | failed | returned`.
- [ ] `Refund` with `pending | succeeded | failed`.
- [ ] `Dispute` with `warning_needs_response | needs_response | under_review | won | lost | charge_refunded`.
- [ ] `Donation` with `PaymentIntent`-aligned status + `campaignId` + `donorVisibility` + `recurrence`.

### Ports (9)

- [ ] `PaymentGatewayPort`, `SubscriptionPort`, `WebhookVerifierPort`, `PayoutPort`, `EscrowPort`, `DonationPort`, `AgenticPaymentPort`, `IdempotencyStorePort`, `ReconciliationReaderPort` declared and exported from `src/domain/ports/index.ts`.
- [ ] Each port's JSDoc names at least one adapter that will implement it (forward reference to the adapter change).
- [ ] `IdempotencyKey` is required on every mutating port method.

### Events

- [ ] 14 event classes matching the proto `events.v1` messages; immutable, `readonly` fields.
- [ ] Each event exposes a `toProto()` translator? — **No.** Translation lives in `src/adapters/inbound/grpc/translators.ts`, not in the domain.

### Errors

- [ ] `DomainError` base + `InvalidStateTransitionError`, `CurrencyMismatchError`, `IdempotencyConflictError`.
- [ ] Every throw in the domain layer throws one of these, never a bare `Error`.

### Tests (Vitest)

- [ ] One test file per entity (`payment-intent.test.ts` etc.); covers happy-path state transitions + at least one invalid transition.
- [ ] One test file per value object; `Money` tests include currency mismatch and negative-amount rejection.
- [ ] Coverage target: 85% on `src/domain/**`. Below that, fail CI for this PR only.

### Architectural invariants

- [ ] `eslint.config.js` gains the `no-restricted-imports` rule block targeting `src/domain/**`.
- [ ] `pnpm lint` reports zero violations.
- [ ] A quick `grep -R "from '@grpc" src/domain/` returns nothing.

### Verification

- [ ] `pnpm tsc --noEmit` clean.
- [ ] `pnpm test` clean.
- [ ] `pnpm build` emits `dist/domain/**`.
- [ ] Import `src/domain/index.ts` from a scratch file under `src/application/` — should resolve without circular-import warnings.

## Pitfalls to avoid

- Do not accept `number` for money amounts anywhere. `bigint` only.
- Do not let a port method return `void` when it should return the persisted entity — subsequent use case code cannot observe the side effect otherwise.
- Do not inline `if (status === 'foo') throw` — use `assertCurrentStatus` to keep transition tables DRY.
- Do not couple entities to gateway SDK types. `GatewayRef` is the only bridge.
- Do not smuggle adapter logic into a "helper" under `src/domain/`. If it needs a fetch, it is not domain.
- Do not `export * from './generated/payments_core'` inside `src/domain/**`. Proto types stay in the boundary layer.

## Post-merge

- [ ] Linear `Done`.
- [ ] `application-use-cases`, every adapter change, and `grpc-server-inbound` unblock.
- [ ] The `escrow-port` change picks up the `EscrowPort` sketch and expands it in detail.
- [ ] The `donations-port` change picks up the `DonationPort` sketch and expands it.
