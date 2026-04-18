# Proposal — Application use cases

## Context

The application layer sits between the domain (entities + ports) and the adapters (inbound gRPC + outbound gateways). It contains the use cases — thin coordinators that load entities, call ports, enforce idempotency, emit events, and persist state. Nothing in this layer speaks protobuf; it consumes plain TypeScript types from the domain. Nothing in this layer speaks gateway SDKs; it calls ports.

## Why now

With the domain skeleton in place (`domain-skeleton`) and the proto contract frozen (`proto-contract-v1`), the use cases are the next layer where every subsequent change converges. Adapters need use cases to dispatch to. The inbound gRPC server needs use cases to call. Skipping this layer and letting the gRPC handlers call ports directly yields a fat boundary layer that will have to be refactored later.

## Scope — use cases in v1

Each use case is a class (or a pure async function) in `src/application/use-cases/`:

1. `InitiateCheckout` — create a `PaymentIntent`, select gateway, call `PaymentGatewayPort.initiate`, persist, emit event on async success.
2. `ConfirmCheckout` — load intent, call `PaymentGatewayPort.confirm`, transition state, emit `PaymentSucceeded` or `PaymentFailed`.
3. `ProcessWebhook` — verify signature via `WebhookVerifierPort`, decode body, dispatch to the relevant inner use case (confirm / refund success / dispute opened / …). Idempotent on `event_id`.
4. `RefundPayment` — load intent, call `PaymentGatewayPort.refund`, persist `Refund`, emit `PaymentRefunded`.
5. `CreateSubscription` — create `Subscription`, call `SubscriptionPort.create`, persist, emit `SubscriptionActivated` on first successful cycle.
6. `SwitchSubscription` — proration + plan swap via `SubscriptionPort.switch`.
7. `CancelSubscription` — end-of-period cancellation by default.
8. `HoldEscrow` — create `Escrow`, hold funds via the selected gateway, persist. Uses `EscrowPort`.
9. `ReleaseEscrow` — partial (milestone) or full release via `EscrowPort`; emits `EscrowReleased` with `milestone` metadata.
10. `CreatePayout` — via `PayoutPort`, persist `Payout`, emit `PayoutIssued`.
11. `HandleAgenticPayment` — entry point for `agentic-core`; validates scoped JWT, creates a `PaymentIntent` marked `agent_initiated`, delegates to `PaymentGatewayPort`. Detailed semantics: `stripe-agentic-commerce-p1` + `agentic-core-extension`.
12. `GetPaymentHistory` — read-only; paginated query against the payments table.
13. `ReconcileDaily` — orchestration job: for each gateway, call `ReconciliationReaderPort.listForDay(date)`, compare to local records, emit diff.

## Cross-cutting concerns (all use cases)

- **Idempotency**: every mutating use case takes an `IdempotencyKey` and checks `IdempotencyStorePort` before doing work. On replay, return the stored result.
- **Consumer tagging**: every call carries `consumer: string` (e.g. `"dojo-os"`). Persisted on entities. Required for tenant-aware reads and for the `consumer` field on emitted events.
- **Event emission**: use cases emit events via an `EventBusPort` (declared here as part of this change, since it is application-level, not domain-level). The default adapter lands in a later infra change.
- **Error mapping**: domain errors (`InvalidStateTransitionError`, `CurrencyMismatchError`) convert to application-layer errors that the grpc adapter then maps to gRPC status codes. Mapping table lives in `src/application/errors.ts`.

## Explicitly out of scope

- No gRPC handler code. That lands in `grpc-server-inbound`.
- No gateway-specific logic. Use cases call ports; the dispatch-by-gateway shim is a 10-line factory that the inbound adapter wires up.
- No Postgres schema. Repositories are declared as ports (`PaymentIntentRepositoryPort` etc.), real Postgres impls land in a later infra change. In-memory repos ship here for tests.
- No metrics / tracing code. Those are infrastructure concerns added later via a decorator pattern, not by inlining `counter.inc()` calls.
- No full reconciliation engine. `ReconcileDaily` in v1 produces a diff; remediation (auto-refund, auto-void, auto-retry) is deferred to a follow-up change.

## Alternatives rejected

- **Fat gRPC handlers, no application layer** — rejected. Moves idempotency + state-machine orchestration + event emission into the boundary layer. Well-known pattern failure in similar sidecars (cited in `agentic-core`'s own design doc).
- **CQRS with separate command/query buses** — rejected as premature. v1 has 13 use cases; a direct-call class-per-use-case is simpler and equally testable.
- **Effect-ts / fp-ts style use cases** — rejected. Ecosystem TS code in `agentic-core` / `marketplace-core` is classical async/await; switching paradigms here increases onboarding cost.
- **Ship only InitiateCheckout + ProcessWebhook first, add the rest per consumer demand** — rejected. We know all 13 are needed (every consumer requires some subset of them), and the state-machine tests we write once cover future adapters.

## Acceptance

1. `src/application/use-cases/` contains all 13 use cases listed above.
2. Each use case has a Vitest test exercising the happy path with a fake port impl + a fake repository.
3. `IdempotencyStorePort` integration test verifies that a replayed idempotency key returns the original result without invoking the gateway port a second time.
4. `src/application/errors.ts` maps every domain error class to an application-error code that `grpc-server-inbound` can translate to a gRPC status.
5. `pnpm tsc --noEmit && pnpm test && pnpm lint` all green.
6. No use case imports anything from `src/adapters/**`. Enforced via ESLint `no-restricted-imports`.
