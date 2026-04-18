# Tasks — Proto contract v1

## Linear

- Title: `payments-core: freeze v1 proto contract (services + events + OpenAPI mirror)`
- Labels: `contract`, `infra`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-proto-contract-v1`.
- Blocks: every adapter change and the `domain-skeleton` change.

## Implementation checklist

### Proto files

- [ ] `proto/buf.yaml` with DEFAULT lint + `FILE` breaking policy.
- [ ] `proto/buf.gen.yaml` with ts-proto + openapiv2 plugins.
- [ ] `proto/payments_core.proto` declaring the service and all v1 messages per `design.md`.
- [ ] Each mutating RPC request message has a required `idempotency_key` field.
- [ ] `Money` value object defined once, reused everywhere.
- [ ] `GatewayPreference` enum with the 8 providers from v1 scope.
- [ ] Event messages under `lapc506.payments_core.events.v1`.

### Codegen pipeline

- [ ] `pnpm buf lint` passes with zero findings (or documented `except` entries).
- [ ] `pnpm buf generate` produces `src/generated/payments_core.ts` and `openapi/payments_core.yaml`.
- [ ] Generated TypeScript compiles under the strict `tsconfig.json` from `repo-bootstrap`.
- [ ] `openapi/payments_core.yaml` validates under `spectral lint` (or `redocly lint`) with zero errors.
- [ ] `npm scripts`: add `proto:lint`, `proto:generate`, `proto:breaking` to `package.json`.

### Cleanup from `mkdocs-site`

- [ ] Remove the `/health` stub operation from `openapi/payments_core.yaml` (do not ship the stub alongside the real spec).
- [ ] The Stoplight Elements page at `docs/content/docs/api/reference.md` now renders the full API (no config change needed if the URL is still `openapi/payments_core.yaml`).

### CI

- [ ] CI workflow `.github/workflows/ci.yml` extended with a `proto` job that runs `buf lint` and `buf breaking`. `buf breaking` is skipped on the initial-landing PR and becomes mandatory on subsequent PRs.

### Verification

- [ ] Running `make proto:generate && make lint && make build && make test` leaves the repo green.
- [ ] The generated `src/generated/payments_core.ts` is checked into `.gitignore` (we regenerate on demand; do not commit generated code).
- [ ] The `openapi/payments_core.yaml` IS committed (static artifact consumed by Stoplight, not a build-only artifact).

### PR

- [ ] Title: `feat(proto): payments-core v1 contract (services + events + OpenAPI)`.
- [ ] Body links the proposal, design, and the sibling consumer plans (`agentic-core-extension`, `stripe-adapter-p0`, `domain-skeleton`).
- [ ] `@greptile review`. Address all findings.
- [ ] CI green.

## Pitfalls to avoid

- Do not add gateway-specific RPCs. One service, gateway selected by a field.
- Do not skip `idempotency_key`. Every mutating RPC MUST require it.
- Do not inline the 3DS state machine as multiple fields. Use opaque `challenge_data` bytes until we have two gateways demanding a richer structure.
- Do not commit `src/generated/`. Codegen on demand.
- Do not call the v2 file `payments_core_v2.proto`. Future v2 is a separate file `payments_core.v2.proto` with `package lapc506.payments_core.v2`.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] `domain-skeleton`, `stripe-adapter-p0`, and `onvopay-adapter-p0` are now unblocked.
- [ ] The `sibling-coordination` note in the `agentic-core-extension` proposal references this PR by commit SHA so the agentic-core-side change can lock against it.
