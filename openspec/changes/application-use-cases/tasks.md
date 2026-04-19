# Tasks — Application use cases

## GitHub

- Title: `Application use cases (14 across 7 sub-domain files)`
- Issue: #18
- Base branch: `main`. Branch: `feat/issue-18-application-use-cases`.
- Blocked by: #22 (`domain-skeleton`), #16 (`proto-contract-v1`).
- Blocks: `grpc-server-inbound` (#19), `stripe-adapter-p0` (#20), `onvopay-adapter-p0` (#21).

## Implementation checklist

### Scaffold

- [x] `src/application/use_cases/` tree per `design.md` layout (7 sub-domain files).
- [x] `src/application/index.ts` barrel (exports the 14 use cases + their input/output types + their dependency shapes).

### Use cases (14)

Authoritative count is **14**, matching the 14 RPCs in
`proto/lapc506/payments_core/v1/payments_core.proto`. The initial draft of
this checklist listed 13; see `design.md` reconciliation note.

- [x] 1. `InitiateCheckout` — creates PaymentIntent, selects gateway, optional FX lookup, calls `PaymentGatewayPort.initiate`, persists, idempotency-keyed.
- [x] 2. `ConfirmCheckout` — accepts `threeDsResult` OR `walletTokenPayload`, advances the intent state.
- [x] 3. `RefundPayment` — full or partial, calls `PaymentGatewayPort.refund`, advances to `refunded` on gateway success.
- [x] 4. `ProcessWebhook` — verifies via `WebhookVerifierPort`, dispatches to a caller-supplied handler, idempotent on both the request key and the verified `eventId`.
- [x] 5. `CreateSubscription`.
- [x] 6. `SwitchSubscription` — swaps plan id + applies proration behavior.
- [x] 7. `CancelSubscription` — honors `atPeriodEnd`.
- [x] 8. `HoldEscrow` — carries `milestoneCondition`, `platformFeeMinor`, `platformFeeDestination` per AduaNext contract.
- [x] 9. `ReleaseEscrow` — optional opaque `milestone` string, optional partial `amount`, accumulates into `escrow.releasedAmount`.
- [x] 10. `DisputeEscrow` — escrow-side dispute (distinct from chargeback `DisputePort`). Missing from the initial 13-item list.
- [x] 11. `CreatePayout` — declares `PayoutGatewayPort` in the application layer (no matching domain port yet).
- [x] 12. `HandleAgenticPayment` — consumes `AgenticPaymentPort`, stamps `agent_initiated=true`, `agent_id`, `tool_call_id` metadata. Scoped-JWT validation deferred to agentic-core-extension.
- [x] 13. `GetPaymentHistory` — read-only, paginated, validates page size.
- [x] 14. `ReconcileDaily` — iterates every registered `ReconciliationPort`, validates YYYY-MM-DD date format.

### Tests (Vitest)

Collapsed to 5 files to stay within the 15-file budget:

- [x] `test/application/checkout.test.ts` — Initiate / Confirm / Refund (happy path, idempotency replay, error paths).
- [x] `test/application/subscription.test.ts` — Create / Switch / Cancel.
- [x] `test/application/escrow.test.ts` — Hold / Release (partial + final) / Dispute (including already-disputed rejection).
- [x] `test/application/webhook.test.ts` — happy path, eventId idempotency absorption across distinct request keys, bad-signature failure.
- [x] `test/application/misc.test.ts` — Payout / Agentic / GetPaymentHistory / ReconcileDaily.

All use cases use plain stubs (`vi.fn()` + in-memory `Map`-backed repo and idempotency store) rather than shared `InMemory*` classes — keeps the file count down and makes each test hermetic.

### Architectural invariants

- [x] ESLint `no-restricted-imports` rule added on `src/application/**`:
  - Blocks adapter + infrastructure imports.
  - Blocks gateway SDKs (`stripe`, `onvopay`, `@supabase/*`, `@grpc/*`, `axios`, `node-fetch`, `pg`) and direct I/O modules (`fs`, `net`, `http`, `https` and their `node:` variants).
- [x] No `console.log` / `debugger` / `process.env.*` reads.
- [x] No top-level side effects.

### Verification

- [x] `pnpm lint` green.
- [x] `pnpm build` green.
- [x] `pnpm test` — 125 tests pass (35 on `src/application/**`).

## Pitfalls observed during implementation

- The domain's `createEscrow` initializes `releasedAmount` as an object literal cast to `Money`, so `.add()` is unavailable on the stored value. `ReleaseEscrow` rebuilds a `Money` via `Money.of` before writing back — callers that read `releasedAmount` and call methods should be aware.
- Idempotency replay in `ProcessWebhook` checks BOTH the caller's request idempotency key AND the verified `eventId` — duplicate deliveries under distinct request keys still short-circuit.
- `exactOptionalPropertyTypes: true` is on; every optional field is forwarded via conditional spread (`...(x !== undefined ? { x } : {})`) rather than direct assignment.

## Deferred (future changes)

- `src/application/errors.ts` domain → application error mapping table (moves into `grpc-server-inbound`).
- `src/application/in-memory/**` shared fakes (`InMemoryIdempotencyStore`, `InMemoryPaymentIntentRepository`, `InMemoryEventBus`, `FakePaymentGateway`, `FakeWebhookVerifier`). Tests in this change use per-file stub helpers instead.
- `EventBusPort` declaration and event emission. Not yet driven by any consumer; will land with the first infra change that wires a real bus.
- Separate repository ports per entity, `GatewayRegistryPort.listActive`. Thin registry interfaces are declared inside each use-case file as needed.
- Coverage threshold enforcement via `@vitest/coverage-v8` (not yet in devDependencies).

## Post-merge

- [ ] `grpc-server-inbound` (#19) unblocks — can now wire use cases to the 14 RPCs.
- [ ] `stripe-adapter-p0` (#20) and `onvopay-adapter-p0` (#21) unblock — their test suites can import the use-case barrel to orchestrate end-to-end scenarios.
