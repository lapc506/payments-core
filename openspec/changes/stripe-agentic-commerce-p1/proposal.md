# Proposal — Stripe agentic commerce (P1)

## Context

Stripe has rolled out a product surface for **in-context selling on AI agents** — a set of primitives that let an AI agent initiate a payment on behalf of a human, with a scoped token carrying the agent's identity, the calling tool's ID, and an audit trail the merchant can verify. The Stripe documentation page for this product lives under Stripe's "Enable in-context selling on AI agents" guide (TODO: verify canonical URL against https://docs.stripe.com/ at implementation time).

This change extends the Stripe P0 adapter with the agentic-payment surface and wires it to `AgenticPaymentPort` declared in `domain-skeleton`. The `AgenticPaymentPort` is in turn the contract that `agentic-core` speaks to via gRPC (`InitiateAgenticPayment` RPC from `proto-contract-v1`). This change and `agentic-core-extension` together land the end-to-end agentic payment flow.

## Why P1 (not P0)

Stripe P0 covers card + subscription + webhook + payout — the baseline every consumer needs today. Agentic commerce is a newer surface and requires:

- `agentic-core` to ship its `AgenticCheckoutPort` and `payments_core_client` (tracked in `agentic-core-extension`).
- Stripe's product to reach GA for the API version pinned in `stripe-adapter-p0` (the agentic endpoints may require a newer `apiVersion` header; this change can bump the header without bumping the SDK, because Stripe supports multiple API versions per SDK release).
- Doji (the consumer-facing AI agent running on `agentic-core`) to have at least one flow that needs to charge a real card.

Shipping P1 after P0 lets us ship Stripe baseline flows immediately while the agentic piece lines up on both sides of the gRPC boundary.

## Scope

### Adapter surface

- `src/adapters/outbound/stripe/stripe-agentic-adapter.ts` — implements `AgenticPaymentPort`. Delegates to Stripe's agentic endpoints.
- Extension of `stripe-client-factory.ts` — if Stripe's agentic product requires a different `apiVersion` header, the factory gains a second export `STRIPE_AGENTIC_API_VERSION` and the agentic adapter uses it while the baseline adapter keeps the original pin. The SDK itself remains at 18.5.0.
- `stripe-agentic-event-translator.ts` — translates new event types (e.g. `payment_intent.agent_initiated.succeeded`, TODO: verify) to domain events.
- `stripe-agentic-jwt-verifier.ts` — Stripe's scoped-JWT verification helper, if Stripe publishes public keys for agent-signed tokens; otherwise the verification happens upstream in `agentic-core` and this adapter just forwards the `agent_id` / `tool_call_id` fields to Stripe.

### Domain and application additions

- `AgenticPaymentPort` in `src/domain/ports/agentic-payment-port.ts` — expanded from the `domain-skeleton` stub. Input carries `agentId`, `toolCallId`, `scopedJwt`, `amount`, `merchant`, `idempotencyKey`, `metadata`.
- `HandleAgenticPayment` use case in `src/application/use-cases/` — already scaffolded in `application-use-cases` but the JWT verification body was a no-op. This change fills it in with a `AgenticJwtVerifier` collaborator whose default impl uses `agentic-core`'s public key (configured via env) to validate the token.
- gRPC handler wiring for the `InitiateAgenticPayment` RPC in `grpc-server-inbound` is already in place; this change verifies the handler calls the new agentic adapter path.

### Audit trail

Every agentic payment persists:

- `agent_id` — the agentic-core agent that initiated the call.
- `tool_call_id` — the specific tool invocation inside the agent's session.
- `scoped_jwt_jti` — the JWT id of the scoped token (not the full token; only the claim).
- `human_approval_id` — if the agentic layer required human approval, the id of that approval record.

These fields land in a `payment_intents.metadata` JSONB block and in the `audit_log` table (schema lives in a later infra change, but columns are reserved here).

## Explicitly out of scope

- **Agentic payments on OnvoPay, Tilopay, etc.** — Stripe is the only gateway with a dedicated agentic product in 2026. Other gateways are called from the agentic path only if the user's gateway preference explicitly routes there; there is no gateway-agnostic agentic surface in this change.
- **Fallback from failed agentic flow to direct card** — a failed agentic authorization is surfaced as an error; agentic-core decides whether to retry on a different rail.
- **Rate limits on agent-initiated payments** — belongs to agentic-core's budget enforcement, not here.
- **PCI scope expansion** — agentic payments go through Stripe's hosted tokenization like any other payment; no raw card data touches `payments-core`.

## Alternatives rejected

- **Ship agentic payments as part of Stripe P0** — rejected; would block Stripe P0 launch on agentic-core readiness.
- **Build a gateway-agnostic agentic layer in `payments-core`** — rejected. Stripe's agentic product is a specific set of Stripe API endpoints; other gateways do not currently ship comparable primitives. We stay gateway-specific for the first consumer (Doji on dojo-os) and generalize only if a second agentic gateway appears.
- **Put agentic JWT verification inside `agentic-core` only, treat this adapter as a pass-through** — partially accepted. agentic-core is the authoritative issuer of scoped JWTs. `payments-core` re-verifies defensively (don't-trust-the-caller model) using the same public key.
- **Use OAuth 2.1 authorization-code flow instead of scoped JWT** — rejected for v1. Stripe's agentic product spec uses a scoped JWT; aligning reduces integration friction. Re-evaluate if multiple agentic gateways converge on OAuth.

## Acceptance

1. `src/adapters/outbound/stripe/stripe-agentic-adapter.ts` implements `AgenticPaymentPort`.
2. The `InitiateAgenticPayment` gRPC RPC, when called with a valid scoped JWT, successfully creates a payment through Stripe's agentic surface.
3. `HandleAgenticPayment` use case rejects expired tokens, unknown `agent_id`, and mismatched `tool_call_id`.
4. Every successful agentic payment records `agent_id` + `tool_call_id` + `scoped_jwt_jti` on the `PaymentIntent` entity.
5. Stripe SDK remains at `18.5.0`; only the agentic `apiVersion` header differs.
6. Documentation page `docs/content/docs/integrations/agentic-core.md` describes the end-to-end flow across `agentic-core` + `payments-core`.
7. This change and `agentic-core-extension` merge in lockstep (sibling-coordination, per `openspec/AGENTS.md` §Relationship to sibling repos).
