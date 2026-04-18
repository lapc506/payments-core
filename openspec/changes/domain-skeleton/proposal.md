# Proposal — Domain skeleton

## Context

`payments-core` is architected as a hexagonal (Explicit Architecture) TypeScript module. The innermost layer is the **domain**: entities, value objects, domain events, and the ports (interfaces) that the application layer depends on. Nothing in this layer performs I/O; nothing imports `@grpc/grpc-js`, `stripe`, `pg`, `fetch`, or any SDK. The layer compiles and type-checks on its own, with only `typescript` and the generated `src/generated/payments_core.ts` types from `proto-contract-v1`.

## Why now

Every adapter change (`stripe-adapter-p0`, `onvopay-adapter-p0`, `tilopay-adapter-p1`, …) depends on a stable port surface. Every application use case (`application-use-cases`) depends on the entities and ports. Writing adapters first guarantees port shapes get bent to match the SDK the author happened to read that day. Writing the domain skeleton first lets the adapters slot into pre-shaped holes.

This change is blocked by `proto-contract-v1` — entity field names and value object shapes must align with the proto messages so the application layer does not have to translate between two parallel type systems for the same concepts.

## Scope

### Entities

Each entity is a class (or an exported factory + type alias, depending on complexity) in `src/domain/entities/`:

- `PaymentIntent` — state machine: `requires_confirmation → processing → succeeded | failed | canceled`, with `requires_action` as an interstitial state for 3DS / SCA.
- `Subscription` — state machine: `trialing | active → past_due → canceled | expired`, with `switched` as a derived flag.
- `Escrow` — state machine: `held → partial_released → released | refunded | disputed`, with milestone tracking.
- `Payout` — state machine: `pending → in_transit → paid | failed | returned`.
- `Refund` — state machine: `pending → succeeded | failed`.
- `Dispute` — state machine: `warning_needs_response | needs_response → under_review → won | lost | charge_refunded`.
- `Donation` — separate from `PaymentIntent` to carry donation-specific fields (`campaign_id`, `donor_visibility`, `recurrence`); state mirrors `PaymentIntent`.

### Value objects

In `src/domain/value-objects/`:

- `Money` — mirrors the proto `Money` message: `amount_minor: bigint`, `currency: string (ISO 4217)`. Invariants: amount is never negative for a charge; currency is exactly three uppercase letters.
- `IdempotencyKey` — branded string type; constructor enforces `[a-zA-Z0-9_\-:]{8,128}`. Required on every mutating use case input.
- `GatewayRef` — discriminated union tagging the external identifier by gateway: `{ kind: 'stripe', paymentIntentId } | { kind: 'onvopay', chargeId } | ...`.
- `ThreeDSChallenge` — opaque wrapper around the gateway-specific challenge payload: `{ gateway: GatewayName, payload: Uint8Array, returnUrl?: string }`. The domain is blind to the payload format.

### Ports (9 total, in `src/domain/ports/`)

Each port is a pure interface. Adapter implementations live in `src/adapters/outbound/`.

1. `PaymentGatewayPort` — initiate / confirm / refund. Gateways implementing this: Stripe, OnvoPay, Tilopay, dLocal, Revolut, Convera, Ripple-XRPL.
2. `SubscriptionPort` — create / switch / cancel / list. Gateways: Stripe, OnvoPay, Tilopay.
3. `WebhookVerifierPort` — verify gateway signatures and decode the raw body into a domain event. One impl per gateway.
4. `PayoutPort` — create / list / reconcile. Gateways: Stripe Connect, OnvoPay, Revolut, Convera, Ripple-XRPL.
5. `EscrowPort` — hold / release (single or milestone-split) / dispute / refund. Detailed shape lives in `escrow-port` change.
6. `DonationPort` — one-time and recurring donations with campaign metadata. Detailed shape lives in `donations-port` change.
7. `AgenticPaymentPort` — entry point called by `agentic-core`; validates scoped-JWT and audit trail, delegates to `PaymentGatewayPort` under the hood. Detailed shape lives in `stripe-agentic-commerce-p1` / `agentic-core-extension`.
8. `IdempotencyStorePort` — persist-and-check idempotency keys. Default impl (in `application-use-cases` or a separate change) is Postgres.
9. `ReconciliationReaderPort` — read-only queries against the gateway ledger for daily reconciliation. Gateways: Stripe, OnvoPay, Tilopay.

### Domain events

Typed event classes in `src/domain/events/` matching the proto event messages under `lapc506.payments_core.events.v1`: `PaymentSucceeded`, `PaymentFailed`, `PaymentRefunded`, `PaymentDisputed`, `SubscriptionActivated`, `SubscriptionPastDue`, `SubscriptionCanceled`, `EscrowHeld`, `EscrowReleased`, `EscrowDisputed`, `PayoutIssued`, `PayoutFailed`, `DonationReceived`, `RecurringDonationActivated`.

Events are plain immutable objects; emission happens in the application layer.

## Explicitly out of scope

- No I/O. No `fetch`, no `pg`, no `stripe`, no `@grpc/grpc-js`, no environment variable reads. If you need to check `process.env` you are in the wrong layer.
- No adapter implementations. The port interfaces are declared here; implementations land in their respective adapter changes.
- No application use cases. Those live in `application-use-cases`.
- No persistence schema. Entities are plain TS classes; the mapping to Postgres (or any store) lives in the adapter layer.
- No DTO serialization. The proto-generated types are used at the grpc boundary; domain ↔ grpc translation happens in the inbound adapter.

## Alternatives rejected

- **Use proto-generated types directly as domain entities** — rejected. Proto types are data transfer shapes; they cannot carry state-machine methods or invariants without leaking domain logic into `src/generated/` (which is gitignored and regenerated). Domain entities are separate classes that happen to align field names with the proto.
- **Anemic entities + service classes** — rejected. Payments entities have non-trivial state transitions (3DS interstitial, partial escrow release, subscription grace period) that we want expressed as methods with invariants, not as free functions.
- **Zod schemas as the source of truth for value objects** — rejected for the value objects themselves (they are classes with behavior), accepted for the use case input validation in `application-use-cases`.
- **One port per adapter** — rejected. Ports are named by capability, not by gateway. A gateway can implement multiple ports (Stripe implements all of PaymentGateway + Subscription + Webhook + Payout), and multiple gateways can implement one port.

## Acceptance

1. `src/domain/` contains `entities/`, `value-objects/`, `ports/`, `events/` and an `index.ts` barrel.
2. `pnpm tsc --noEmit` passes with `strict: true` under the `tsconfig.json` from `repo-bootstrap`.
3. No file under `src/domain/**` imports anything outside `src/domain/`, `src/generated/`, or the TypeScript standard library. Enforced via an ESLint `no-restricted-imports` rule.
4. Each entity has at least one unit test (Vitest) exercising the main state transitions; no test imports an adapter.
5. The nine ports are exported from `src/domain/ports/index.ts` and the README's architecture section references them by name.
