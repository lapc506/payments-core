# Tasks — Application use cases

## Linear

- Title: `payments-core: application layer (13 use cases + error map + in-memory fakes)`
- Labels: `application`, `typescript`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-application-use-cases`.
- Blocked by: `domain-skeleton`.
- Blocks: `grpc-server-inbound` (calls use cases), every adapter change's test suite (reuses in-memory fakes).

## Implementation checklist

### Scaffold

- [ ] `src/application/` tree per `design.md` layout.
- [ ] `src/application/errors.ts` with the domain→application mapping table.
- [ ] `src/application/index.ts` barrel (exports use cases + input/output types + error codes; does NOT export `in-memory/`).

### Ports (application-level)

- [ ] `EventBusPort` with `publish(event: DomainEvent): Promise<void>`.
- [ ] One repository port per entity (7 total).
- [ ] `GatewayRegistryPort` with `resolve`, `resolveForWebhook`, `listActive`.

### Use cases (13)

- [ ] `InitiateCheckout` with gateway resolution + idempotency check + intent save + event emission.
- [ ] `ConfirmCheckout` handling both `three_ds_result` and `wallet_token` confirmation paths.
- [ ] `ProcessWebhook` — verifier-based dispatch; idempotent on `event.id`.
- [ ] `RefundPayment` — partial or full; persists `Refund`.
- [ ] `CreateSubscription` / `SwitchSubscription` / `CancelSubscription`.
- [ ] `HoldEscrow` / `ReleaseEscrow` with `milestone` optional param.
- [ ] `CreatePayout`.
- [ ] `HandleAgenticPayment` with scoped-JWT validation stub (actual JWT verification logic lands in `agentic-core-extension` / `stripe-agentic-commerce-p1`).
- [ ] `GetPaymentHistory` — read-only, paginated.
- [ ] `ReconcileDaily` — orchestrator: for each active gateway, call `listForDay`, compare.

### In-memory adapters (test-only, under `src/application/in-memory/`)

- [ ] `InMemoryIdempotencyStore`.
- [ ] `InMemoryEventBus` with assertion helpers (`emitted()`, `clear()`).
- [ ] `InMemoryPaymentIntentRepository` (+ one per entity as needed by tests).
- [ ] `FakePaymentGateway` implementing `PaymentGatewayPort` with scripted responses.
- [ ] `FakeWebhookVerifier` with a `seed(event)` helper.

### Tests (Vitest)

- [ ] One test file per use case, minimum three cases each: happy path, idempotency replay, error path.
- [ ] `ProcessWebhook` tests cover: unknown source, invalid signature, duplicate event id, each event type → inner use case.
- [ ] `ReleaseEscrow` tests cover partial and final release, plus release-of-already-released rejection.
- [ ] Coverage target: 85% on `src/application/**`.

### Architectural invariants

- [ ] ESLint `no-restricted-imports` rule added: `src/application/**` cannot import from `src/adapters/**`.
- [ ] `src/application/in-memory/**` cannot be imported by `src/adapters/**` or `src/domain/**` (ESLint rule or path-based convention enforced in CI).
- [ ] No `console.log`. No `process.env.*` reads in use cases (config is injected).

### Verification

- [ ] `pnpm lint && pnpm tsc --noEmit && pnpm test` all green.
- [ ] `pnpm test -- --coverage` meets the 85% threshold on `src/application/**`.
- [ ] A scratch script `tsx scripts/smoke-use-cases.ts` wires `InMemory*` + `FakePaymentGateway` and exercises `InitiateCheckout` → `ConfirmCheckout` without any adapter imports.

## Pitfalls to avoid

- Do not let a use case call another use case directly via `new OtherUseCase(...)` — inject a shared dependency instead, or expose a method on a coordinator if ordering is intrinsic (the `ProcessWebhook` → inner-use-case case is the only acceptable one, and it is dependency-injected).
- Do not persist gateway SDK payloads raw. The repository stores the entity; the gateway ref goes in `GatewayRef`, raw payloads (if kept) go in a `webhook_log` table owned by a later infra change.
- Do not mix event emission into mid-transition code paths. Emit events at the end of the use case, after persistence, so replays and rollbacks do not leak events.
- Do not add retry logic here. Gateways are called once; the adapter layer (or the caller) owns retries. `ReconcileDaily` surfaces the diff but does not auto-retry.
- Do not define generic `Repository<T>` until at least three repositories prove identical shapes.
- Do not couple `HandleAgenticPayment` to Stripe. It is gateway-agnostic; Stripe agentic behavior is one implementation.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] `grpc-server-inbound` unblocks — it can now wire use cases to RPCs.
- [ ] Adapter changes (`stripe-adapter-p0`, `onvopay-adapter-p0`) can import `FakePaymentGateway` as a reference when authoring their real adapters.
- [ ] The error code table in `errors.ts` is referenced from `grpc-server-inbound`'s `design.md` for the gRPC mapping.
