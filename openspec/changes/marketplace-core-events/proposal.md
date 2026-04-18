# Proposal — marketplace-core events (cross-repo)

## Context

`marketplace-core` is the sibling repository that owns catalog, inventory, and traceability for marketplace flows. When a shopper completes a purchase in a consumer frontend, the flow is:

1. Consumer frontend builds a cart → posts to consumer backend.
2. Consumer backend calls `marketplace-core`'s order-create endpoint → gets an order draft.
3. Consumer backend calls `payments-core`'s `InitiateCheckout` with `metadata.order_id` → gets a payment intent + checkout URL.
4. Shopper completes payment → gateway webhook fires → `payments-core` emits `PaymentSucceeded`.
5. `marketplace-core` subscribes to `PaymentSucceeded`, moves the order from draft → paid → ready-to-ship, reserves inventory, emits its own downstream events (shipment triggered, fulfillment assigned).

Today there is no formal `ProductPurchaseRequested` event flowing **from** marketplace-core **to** payments-core, and there is no declared subscription on marketplace-core's side to `PaymentSucceeded`. This change formalizes the two endpoints of that cross-repo contract.

## Why this change

Consumer backends currently duplicate the choreography: each backend knows to call marketplace-core first, then payments-core, then observe the succeeded event. Formalizing the events gives marketplace-core the option to **initiate** payment flow itself (via a `ProductPurchaseRequested` event that payments-core listens for, if the consumer-backend orchestration is ever replaced by a more event-driven pattern), and gives every consumer a single canonical subscription path to wire on marketplace-core's side.

## Scope (cross-repo — half in `../marketplace-core/`, half informational here)

### In `../marketplace-core/` (new)

- `ProductPurchaseRequested` event declaration in marketplace-core's proto / event schema.
- A `PaymentSucceededConsumer` subscription that listens on the ecosystem event bus (Kafka / NATS, per consumer deployment) and, on receiving `PaymentSucceeded` with `metadata.order_id` matching a marketplace-core order, advances the order state machine.
- Matching Python / TypeScript (whichever language marketplace-core uses) event schema files.
- Documentation in marketplace-core's docs describing the end-to-end flow.

### In `payments-core` (informational / minor)

- Documentation page `docs/content/docs/integrations/marketplace-core.md` describing the contract from payments-core's side.
- An optional listener hook for `ProductPurchaseRequested` — when an event-driven consumer (rather than imperative backend orchestration) is the caller, payments-core can react to the event by auto-creating a checkout session. **In v1, this hook is not implemented** — the imperative path (consumer backend calls `InitiateCheckout` directly) remains the canonical flow. The hook is mentioned here as a forward-looking option.

### Event schema (from marketplace-core's side)

```proto
message ProductPurchaseRequested {
  string order_id = 1;
  string consumer = 2;                        // tenant id
  string shopper_id = 3;                      // hashed shopper ref
  repeated LineItem items = 4;
  Money total = 5;
  string currency = 6;
  map<string, string> metadata = 7;
  google.protobuf.Timestamp occurred_at = 8;
}
```

### Subscription semantics

- Exactly-once processing on marketplace-core's side; idempotent on `(order_id, payment_intent_id)` pair.
- `PaymentSucceeded` with `metadata.order_id` not matching any marketplace-core order is logged and dropped (it belongs to a non-marketplace flow, e.g. a donation).
- `PaymentRefunded` subscription also wired: triggers order-state rollback + inventory release.
- `PaymentDisputed` subscription: flags order for manual review; does not auto-refund.

## Out of scope

- **The event bus infrastructure itself** — Kafka / NATS / Redis Streams choice is per-consumer-deployment, not standardized in this change.
- **marketplace-core's order state machine changes** — those belong in a marketplace-core internal change.
- **Inventory reservation hold-times** — belong to marketplace-core's domain.
- **Shipping carrier integration triggers** — belong to marketplace-core + its own adapters.
- **A `ProductPurchaseRequested` consumer on payments-core's side** — deferred per the v1 decision.

## Alternatives rejected

- **Build all orchestration into a new "commerce-core"** — rejected. marketplace-core + payments-core + invoice-core are deliberately separate per the governance rubric. Orchestration lives in the consumer backend (or, optionally, in event-driven choreography).
- **Use synchronous RPC calls between marketplace-core and payments-core** — rejected. Asynchronous events are the standard for cross-core coordination in this ecosystem; synchronous calls create temporal coupling.
- **Skip formalizing the events, let each consumer backend handle it** — rejected. Repeats the implementation five times; misses the chance to provide a canonical pattern.
- **Put the event consumer code in payments-core** — rejected. marketplace-core owns its own order state; payments-core publishes events and does not know what orders are.

## Acceptance

1. marketplace-core's OpenSpec tree gains a matching change (`openspec/changes/payments-core-events-integration/` or equivalent) that ships the subscription code + event schemas.
2. `PaymentSucceeded`, `PaymentRefunded`, and `PaymentDisputed` subscriptions on marketplace-core's side are wired and tested against a running payments-core sidecar.
3. `docs/content/docs/integrations/marketplace-core.md` in this repo describes the contract (read-only from payments-core's side).
4. At least one consumer backend (candidate: `vertivolatam-api` or `dojo-os`) adopts the pattern in a follow-up PR that demonstrates the full end-to-end flow.
5. Both sides' PRs reference each other and merge in lockstep.
6. The canonical `order_id` metadata key is documented: any consumer calling `InitiateCheckout` on payments-core SHOULD include `metadata.order_id` when the payment corresponds to a marketplace-core order.
