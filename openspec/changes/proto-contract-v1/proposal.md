# Proposal — Proto contract v1

## Context

`payments-core` is a gRPC sidecar. Its public contract is a single `.proto` file that defines the services every consumer backend (and `agentic-core`) calls. Nothing downstream can be written until this contract is frozen in shape — the domain layer, the application use cases, the inbound adapter, the OpenAPI mirror consumed by Stoplight Elements, and the client code in every consumer all key off this file.

## Why now

Freezing the v1 contract early is the single best lever against churn. Every time we later rename an RPC or reshape a message, every consumer that has wired client stubs rebuilds. The ecosystem rubric's §9 warns against "construir antes de consumidor"; this change inverts the warning: we HAVE consumers (dojo-os today, four more close behind), so we must pin the contract before they pick it up.

## Scope

One file: `proto/payments_core.proto`. It declares a single gRPC service `PaymentsCore` and the set of messages needed for v1 operations. It also declares an `events.v1` namespace for the cross-core events the sidecar emits to the event bus.

Generation of TypeScript stubs (both server and client) happens in a later change (`domain-skeleton` uses the types). Generation of the OpenAPI descriptor for Stoplight Elements happens in this change via `grpc-gateway` annotations (`google.api.http` options).

## Scope — services in v1

- `InitiateCheckout` — create a payment intent (individual or organization).
- `ConfirmCheckout` — confirm after 3DS / SCA where applicable.
- `RefundPayment` — full or partial refund.
- `ProcessWebhook` — verify signature + dispatch event (called inbound from adapter's HTTP receiver).
- `CreateSubscription` / `SwitchSubscription` / `CancelSubscription`.
- `HoldEscrow` / `ReleaseEscrow` / `DisputeEscrow`.
- `CreatePayout`.
- `InitiateAgenticPayment` — entry point for `agentic-core`, carries `agent_id`, `tool_call_id`, scoped-JWT audit trail.
- `GetPaymentHistory` — read-only, paginated.
- `ReconcileDaily` — read-only, returns diff between gateway ledger and local records for a day.

## Scope — events in v1

Emitted on the event bus (Kafka or NATS, decided by the consumer backend):

- `PaymentSucceeded`, `PaymentFailed`, `PaymentRefunded`, `PaymentDisputed`.
- `SubscriptionActivated`, `SubscriptionPastDue`, `SubscriptionCanceled`.
- `EscrowHeld`, `EscrowReleased`, `EscrowDisputed`.
- `PayoutIssued`, `PayoutFailed`.
- `DonationReceived`, `RecurringDonationActivated` — emitted as typed variants so `altrupets-api` can subscribe specifically.

## Out of scope

- Gateway-specific RPCs (`InitiateStripeCheckout`, `InitiateOnvoPayCheckout`). Gateway choice is a request field, not a service split.
- Mobile SDK surface. Apple Pay / Google Pay verification is an internal use case, not a public RPC — it is called by another RPC (`ConfirmCheckout`) with a `wallet_token` field.
- Cryptographic primitives. 3DS challenge handshake lives inside the Stripe / OnvoPay adapters; the proto just carries opaque `challenge_data` bytes.

## Alternatives rejected

- **One RPC per gateway per operation** (`InitiateStripeCheckout`, `InitiateOnvoPayCheckout`, …) — rejected. Forces backends to know their gateway, defeating the sidecar abstraction. Instead, `InitiateCheckout` takes a `gateway_preference` enum (`AUTO` by default) and `payments-core` picks.
- **REST instead of gRPC** — rejected. The sibling ecosystem is gRPC-native; switching to REST breaks the sidecar pattern and the proto tooling.
- **GraphQL** — rejected. Payments flows are command-heavy (RPCs), not graph-read-heavy. GraphQL adds complexity without benefit here.

## Acceptance

1. `proto/payments_core.proto` compiles with `protoc` and `protoc-gen-ts` (node-based pipeline pinned by `domain-skeleton`).
2. `buf lint proto/` passes with the `buf.build/acme/default` preset.
3. The OpenAPI descriptor `openapi/payments_core.yaml` is regenerated from the proto via `grpc-gateway`'s openapiv2 generator and passes `spectral lint` without errors.
4. The Stoplight Elements page from `mkdocs-site` renders the full API (not just the `/health` stub).
5. The stub `/health` operation from `mkdocs-site` is removed from `openapi/` as part of this change's cleanup.
