# Tasks — gRPC server (inbound adapter)

## Linear

- Title: `payments-core: inbound gRPC adapter + Dockerfile + K8s sidecar example`
- Labels: `adapter`, `infra`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-grpc-server-inbound`.
- Blocked by: `application-use-cases`, `proto-contract-v1`.
- Blocks: every outbound adapter's integration test that needs a real server; Helm chart change (future).

## Implementation checklist

### Dependencies

- [ ] Add `@grpc/grpc-js`, `@grpc/reflection`, `grpc-health-check` to `dependencies`.
- [ ] Update `pnpm-lock.yaml`.

### Scaffold

- [ ] `src/adapters/inbound/grpc/` tree per `design.md`.
- [ ] `src/main.ts` composition root (stub adapters for `stripe` / `onvopay` if those changes have not landed yet — use the `FakePaymentGateway` from `application-use-cases` until they do).
- [ ] `Dockerfile` multi-stage as spec'd.
- [ ] `k8s/sidecar.example.yaml` with K8s 1.29 native-sidecar + 1.27/1.28 fallback comment block.

### Handlers (14 total — one per RPC)

- [ ] `initiate-checkout-handler.ts`
- [ ] `confirm-checkout-handler.ts`
- [ ] `refund-payment-handler.ts`
- [ ] `process-webhook-handler.ts`
- [ ] `create-subscription-handler.ts`
- [ ] `switch-subscription-handler.ts`
- [ ] `cancel-subscription-handler.ts`
- [ ] `hold-escrow-handler.ts`
- [ ] `release-escrow-handler.ts`
- [ ] `dispute-escrow-handler.ts`
- [ ] `create-payout-handler.ts`
- [ ] `initiate-agentic-payment-handler.ts`
- [ ] `get-payment-history-handler.ts`
- [ ] `reconcile-daily-handler.ts`

### Translators

- [ ] Bidirectional translators for every request/response pair.
- [ ] `Money` proto ↔ `Money` domain (bigint conversion).
- [ ] `GatewayPreference` enum ↔ `GatewayName` string.
- [ ] Metadata maps preserved as-is.

### Interceptors

- [ ] `requestIdInterceptor` — ULID via `ulid` or `nanoid`.
- [ ] `loggingInterceptor` — structured logs, no PII.
- [ ] `authInterceptor` — `x-caller-id` required; `authorization: Bearer …` required only for `InitiateAgenticPayment`. The `AgenticJwtVerifier` interface is declared here; real impl is a no-op until `stripe-agentic-commerce-p1` lands.

### Health + reflection

- [ ] `grpc.health.v1.Health` service exposed, returning `SERVING` once deps initialize, `NOT_SERVING` during shutdown.
- [ ] Reflection service registered (allows `grpcurl` against the live server).

### Error mapping

- [ ] `src/adapters/inbound/grpc/error-mapper.ts` implements the mapping table from `application-use-cases`.
- [ ] Internal errors never leak message bodies beyond `"internal error"`.
- [ ] Every mapped error path has a test.

### Graceful shutdown

- [ ] `SIGTERM` → `server.tryShutdown` with 30s deadline, then `forceShutdown`.
- [ ] DB pool and logger flushed.

### Docker + CI

- [ ] `.dockerignore` excludes `node_modules`, `.git`, `.github`, `openspec`, `docs`.
- [ ] `Dockerfile` builds to under 80 MB.
- [ ] `.github/workflows/ci.yml` extended with a `docker-build` job (builds but does not push on PRs).
- [ ] `.github/workflows/release.yml` (new) pushes the image to `ghcr.io/lapc506/payments-core:<tag>` on version tags.

### Integration tests (`test/integration/grpc/`)

- [ ] Spawn server on a random port, generate a ts-proto client, call `InitiateCheckout` with `FakePaymentGateway` wired as the Stripe slot, assert response shape.
- [ ] Call `ProcessWebhook` with a fake verifier seeded with a `payment.succeeded` event; assert the repository shows the intent as `succeeded`.
- [ ] Auth failure: call without `x-caller-id`; assert `UNAUTHENTICATED`.
- [ ] `grpc_health_probe` binary (from CI container or `buf` tooling image) returns OK.

### Verification

- [ ] `pnpm lint && pnpm test && pnpm build && docker build -t payments-core:dev .` — all green.
- [ ] `kubeval k8s/sidecar.example.yaml --kubernetes-version 1.29.0` passes.
- [ ] Manual: `docker run --rm -p 50051:50051 payments-core:dev &` + `grpcurl -plaintext localhost:50051 list` returns `lapc506.payments_core.v1.PaymentsCore`.

## Pitfalls to avoid

- Do not put business logic in handlers. If a handler is longer than ~25 lines, one of those lines is wrong.
- Do not `throw new Error(...)` inside a handler. Convert via the error mapper.
- Do not leak internal error messages to callers. Log them; return a generic status.
- Do not hardcode port `50051` in multiple files; it comes from `env.GRPC_PORT`.
- Do not enable gRPC-Web, REST gateway, or HTTP admin endpoints in v1. Separate changes.
- Do not install `@grpc/proto-loader`; we use ts-proto output.
- Do not ignore SIGTERM. K8s will SIGKILL after 30s by default; graceful drain must complete inside that window.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] The generated Docker image is available at `ghcr.io/lapc506/payments-core:<first-tag>` after the first version tag is pushed.
- [ ] Consumer repos can now wire a sidecar using `k8s/sidecar.example.yaml` as a reference.
- [ ] `stripe-adapter-p0` and `onvopay-adapter-p0` drop their temporary `FakePaymentGateway` registrations from `main.ts` as they land.
