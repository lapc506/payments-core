# Proposal — gRPC server (inbound adapter)

## Context

`payments-core` is deployed as a Kubernetes sidecar alongside each consumer backend pod (and as a standalone Docker service for non-K8s consumers). Its inbound surface is a single gRPC server speaking the contract frozen by `proto-contract-v1`. This change introduces the inbound adapter under `src/adapters/inbound/grpc/`: a thin translation layer between the proto messages and the application use cases.

## Why now

Until this layer exists, the application use cases cannot be called by an external process — they only run in tests. Adapter changes cannot be tested end-to-end. Deployment artifacts (`Dockerfile`, Helm chart) cannot be written against a service that has no boot path.

## Scope

- `src/adapters/inbound/grpc/server.ts` — `createServer()` factory that returns a `@grpc/grpc-js` `Server` with every RPC handler wired.
- `src/adapters/inbound/grpc/handlers/` — one file per RPC (`initiate-checkout-handler.ts`, `confirm-checkout-handler.ts`, …). Each handler: translates proto → domain input, calls the use case, translates result → proto, maps errors to gRPC status.
- `src/adapters/inbound/grpc/translators.ts` — bidirectional translators between proto types (from `src/generated/payments_core.ts`) and domain types.
- `src/adapters/inbound/grpc/error-mapper.ts` — maps `application/errors.ts` codes to gRPC `status` codes per the table in `application-use-cases/design.md`.
- `src/adapters/inbound/grpc/interceptors/` — `requestIdInterceptor`, `loggingInterceptor`, `authInterceptor` (reads `x-caller-id` header + scoped JWT for agentic calls).
- `src/main.ts` — composition root: reads env, builds adapters, builds use cases, registers handlers, starts server on `:50051`.
- `Dockerfile` — multi-stage build, distroless runtime, health probe.
- `k8s/sidecar.example.yaml` — K8s manifest fragment showing how a consumer pod declares `payments-core` as a sidecar (`shareProcessNamespace: true`, shared emptyDir for unix socket optional).
- `.github/workflows/ci.yml` extended with a `docker-build` job that publishes to GHCR on tag pushes only (not every PR).

## Out of scope

- **No TLS termination** — sidecar model assumes pod-local unix-socket or localhost mTLS handled by the service mesh (Linkerd, Istio) one layer out. Consumers not on a mesh use plaintext over loopback inside the pod.
- **No HTTP / REST gateway** — if a consumer wants REST, they deploy `grpc-gateway` separately; v1 does not ship that binary.
- **No admin HTTP endpoints beyond `/healthz` and `/readyz`** — metrics `/metrics` land in the later observability change.
- **No config hot-reload** — env vars read once at startup.

## K8s sidecar considerations

The manifest example targets Kubernetes 1.29+, which supports **native sidecar containers** via `initContainers[].restartPolicy: Always`. The example uses that pattern (not a plain second container) so:
- Sidecar starts before the main app container and is ready when app starts.
- Sidecar shutdown is ordered (sidecar drains after app container exits).
- Resource limits are sidecar-specific.

For clusters below 1.29, the example includes a plain-container fallback block behind a comment.

## Alternatives rejected

- **Wrap every handler in a class, use a DI container (tsyringe / InversifyJS)** — rejected. The composition root is small enough to wire by hand; DI containers pay back only at larger scales.
- **Ship a standalone gRPC-gateway binary inside the same container** — rejected. Doubles the surface area of the container. Consumers that need REST deploy the gateway themselves.
- **Use `nice-grpc` or `grpc-js-tools` wrapper libraries** — rejected for v1. Stays on vanilla `@grpc/grpc-js` for easier debugging and fewer dependency hops. Re-evaluate if handler boilerplate gets unwieldy past ~20 RPCs.
- **Expose WebSocket + gRPC-Web on the same port** — rejected. gRPC-Web requires a proxy layer (Envoy); let consumers add it when they need browser clients.

## Acceptance

1. `pnpm build && node dist/main.js` starts a gRPC server on `:50051` that accepts a `grpc_health_probe` check.
2. A basic integration test (under `test/integration/grpc/`) spawns the server, calls `InitiateCheckout` via a generated client stub, and asserts the response shape.
3. `docker build .` produces an image under 80 MB (distroless + node:20-slim base).
4. The sidecar manifest example validates under `kubeval` against the K8s 1.29 schema.
5. `grpc_health_probe -addr=:50051` returns `OK` once the server is ready.
6. All 13 RPCs from `proto-contract-v1` have handlers; none throw `UNIMPLEMENTED`.
