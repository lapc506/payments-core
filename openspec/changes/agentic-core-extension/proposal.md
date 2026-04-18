# Proposal — agentic-core extension (cross-repo)

## Context

`payments-core`'s `InitiateAgenticPayment` RPC is called by `agentic-core` — the sibling repo that hosts the AI agent runtime (Doji, DojoOS's consumer-facing agent, lives there as a deployed instance). For that RPC to be usable, `agentic-core` needs:

1. An `AgenticCheckoutPort` in its domain layer that agent tools call when they need to charge money.
2. An outbound adapter that speaks gRPC to `payments-core` and knows how to build the scoped JWT.

This change is the `agentic-core`-side counterpart of this repo's `stripe-agentic-commerce-p1` change. Per `openspec/AGENTS.md` §Relationship to sibling repos, cross-repo changes land in lockstep: neither side is merged until both pass review.

## Why this change

Without the agentic-core side, the `InitiateAgenticPayment` RPC sits unused. The business value (Doji being able to complete a transaction on behalf of a DojoOS user) depends on both sides landing together.

## Scope (happens in `../agentic-core/`, not this repo)

### New files in `agentic-core`

- `../agentic-core/src/agentic_core/domain/ports/agentic_checkout_port.py` — Python port (agentic-core is Python) defining the interface an agent tool calls to initiate a payment.
- `../agentic-core/src/agentic_core/adapters/outbound/payments_core_client.py` — gRPC client that implements `AgenticCheckoutPort` by calling `payments-core`'s `InitiateAgenticPayment` RPC.
- `../agentic-core/src/agentic_core/application/use_cases/initiate_agentic_payment_use_case.py` — thin wrapper: signs the scoped JWT, calls the port, persists the audit trail in agentic-core's own audit store.
- `../agentic-core/src/agentic_core/infrastructure/jwt/scoped_jwt_issuer.py` — signs scoped JWTs using agentic-core's private key; publishes the corresponding JWKS at `/.well-known/jwks.json` on agentic-core's admin surface.

### Port shape (Python)

```python
class AgenticCheckoutPort(Protocol):
    async def initiate_agentic_payment(
        self,
        input: InitiateAgenticPaymentInput,
    ) -> InitiateAgenticPaymentResult: ...

@dataclass(frozen=True)
class InitiateAgenticPaymentInput:
    agent_id: str
    tool_call_id: str
    amount_minor: int
    currency: str
    merchant: str
    consumer: str
    idempotency_key: str
    metadata: Mapping[str, str]
    human_approval_id: str | None
```

### `payments_core_client.py` adapter (Python gRPC)

```python
class PaymentsCoreClient(AgenticCheckoutPort):
    def __init__(
        self,
        channel: grpc.aio.Channel,
        jwt_issuer: ScopedJwtIssuer,
        logger: Logger,
    ) -> None:
        self._stub = payments_core_pb2_grpc.PaymentsCoreStub(channel)
        self._jwt_issuer = jwt_issuer
        self._logger = logger

    async def initiate_agentic_payment(
        self,
        input: InitiateAgenticPaymentInput,
    ) -> InitiateAgenticPaymentResult:
        scoped_jwt = await self._jwt_issuer.issue(
            agent_id=input.agent_id,
            tool_call_id=input.tool_call_id,
            audience="payments-core",
            scope=["payment:initiate"],
            ttl_seconds=60,
        )
        request = payments_core_pb2.InitiateAgenticPaymentRequest(
            agent_id=input.agent_id,
            tool_call_id=input.tool_call_id,
            scoped_jwt=scoped_jwt,
            amount=payments_core_pb2.Money(
                amount_minor=input.amount_minor,
                currency=input.currency,
            ),
            merchant=input.merchant,
            idempotency_key=input.idempotency_key,
            metadata=dict(input.metadata),
        )
        response = await self._stub.InitiateAgenticPayment(request, timeout=20.0)
        return InitiateAgenticPaymentResult(
            payment_intent_id=response.payment_intent_id,
            requires_human_review=response.requires_human_review,
            risk_signals=dict(response.risk_signals),
        )
```

### JWKS exposure

agentic-core already runs a small admin HTTP server. This change adds a `/.well-known/jwks.json` route that publishes the public keys corresponding to `ScopedJwtIssuer`'s signing keys. `payments-core`'s `AgenticCoreJwtVerifier` fetches from this URL.

### Key rotation

Keys rotate on a 90-day schedule. JWKS publishes N+1 keys (current + upcoming). `ScopedJwtIssuer` signs with the current key; `payments-core`'s JWKS cache invalidates on signature failures and on a scheduled 10-minute TTL.

## gRPC boundary

The gRPC contract is `proto-contract-v1`'s `InitiateAgenticPayment(InitiateAgenticPaymentRequest) → InitiateAgenticPaymentResponse`. agentic-core consumes the proto from a shared proto registry (or by checking in a copy of the generated Python stubs). TODO: verify whether the ecosystem uses Buf's Schema Registry or a per-repo generated-stubs convention; apply whichever is standard.

## Out of scope

- **Doji-specific tool wiring** — the individual agent tools that call `AgenticCheckoutPort` are a separate change in agentic-core (or in the Doji-specific plugin repo).
- **Payment-in via WebSocket / streaming RPCs** — v1 is a unary RPC.
- **OAuth 2.1 token flow** — rejected in `stripe-agentic-commerce-p1`; scoped JWT is the authoritative mechanism.
- **Agent budget enforcement** — agentic-core enforces agent-level spend limits before even calling `initiate_agentic_payment`. Limit logic is not in this change; it belongs to agentic-core's domain layer.

## Alternatives rejected

- **Merge this change into `stripe-agentic-commerce-p1`** — rejected. Sibling repos' OpenSpec changes are separate per AGENTS.md convention. The two cross-reference each other and merge in lockstep, but each has its own directory.
- **Skip the JWT; trust the gRPC metadata** — rejected outright. Defense in depth: `payments-core` must be able to reject forged metadata even if something in between is compromised.
- **Share the signing key between agentic-core and payments-core** — rejected. Asymmetric signing (sign in agentic-core, verify in payments-core) is strictly better.
- **Put the `PaymentsCoreClient` adapter in a shared ecosystem library** — rejected for v1. Cross-ecosystem shared libraries are out of scope; each repo owns its own client adapter.

## Acceptance

1. agentic-core ships `AgenticCheckoutPort`, `PaymentsCoreClient`, `InitiateAgenticPaymentUseCase`, and `ScopedJwtIssuer`.
2. agentic-core's admin HTTP server exposes `/.well-known/jwks.json`.
3. An integration test (in agentic-core) starts a live `payments-core` server (test mode), calls `InitiateAgenticPaymentUseCase`, and verifies the happy path + expired-token rejection.
4. `payments-core`'s `AgenticCoreJwtVerifier` configured with agentic-core's JWKS URL verifies real agentic-core-signed tokens end-to-end.
5. Both sides' PRs reference each other and merge on the same day (per AGENTS.md §Relationship to sibling repos).
6. This change and `stripe-agentic-commerce-p1` land together; neither is merged alone.
7. Documentation cross-link: `payments-core`'s `docs/content/docs/integrations/agentic-core.md` and the equivalent page in agentic-core's docs mirror each other.
