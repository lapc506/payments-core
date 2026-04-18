# Governance

`payments-core` is one of several `-core` repositories that share a single
governance rubric. This page captures the verdict that justifies extracting
payments as a standalone sidecar, the scope boundaries that keep it focused,
and the anti-patterns the rubric helps us avoid.

The authoritative, version-controlled record of this decision lives in the
[`governance-rubric-adoption`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/governance-rubric-adoption)
OpenSpec change. This page mirrors it in a reader-friendly format. If the two
ever disagree, the OpenSpec change wins.

## Why this repository exists

Before any `-core` repository is created, it must pass a five-criterion rubric
maintained across the ecosystem. The rubric asks whether the candidate justifies
its own repo — or whether it would better live as an adapter inside an existing
`-core`, as a module inside a consumer backend, or as a deferred concern.

`payments-core` was evaluated on 2026-04-18 and scored **5 of 5**. The rubric
requires at least 4 of 5 to approve extraction; the minimum-viable ecosystem
today (`compliance-core`) is the only other repository sharing the same
5/5 strength bracket. See the [Rubric](rubric.md) page for a paraphrase of the
five criteria.

## Verdict (2026-04-18)

Score: **5 of 5**.

| Criterion | Result | Key evidence |
|---|:---:|---|
| 1. Cross-startup reuse | PASS (strong) | Five committed consumers: `dojo-os`, `altrupets-api`, `habitanexus-api`, `vertivolatam-api`, `aduanext-api` |
| 2. Bounded domain | PASS | State machines for PaymentIntent, Subscription, Escrow, Payout, Refund, Dispute are all payments-local; `invoice-core` consumes `PaymentSucceeded`, it does not own the state |
| 3. Non-trivial complexity | PASS (strong) | 3DS, webhook HMAC, idempotency, reconciliation, chargebacks, PCI SAQ-A scoping, multi-currency FX, split payments, payout schedules |
| 4. Credential / regulatory isolation | PASS (strong) | Stripe secrets, OnvoPay keys, Tilopay keys, webhook signing secrets, and PCI scope all collapse into the sidecar pod |
| 5. External integrations with rate-limit / retry | PASS (strong) | Stripe, OnvoPay, Tilopay, dLocal, Revolut, Convera, Ripple, Apple Pay / Google Pay token verification |

Full rationale, including rejected alternatives (merging into `invoice-core`,
leaving payments in each backend, spinning up an `accounting-core` sibling),
is in the [`proposal.md`](https://github.com/lapc506/payments-core/blob/main/openspec/changes/governance-rubric-adoption/proposal.md)
of the OpenSpec change.

## Scope boundaries

To keep the rubric meaningful after the fact, the same change freezes what
belongs in this repo and what does not.

### In scope

- PaymentIntent
- Subscription (one-time, recurring, upgrade / downgrade)
- Escrow
- Payout
- Refund
- Dispute
- Reconciliation
- AgenticPayment (called from `agentic-core` orchestrations)
- FX lookup
- WebhookVerifier
- Idempotency
- Donation (one-time and recurring)

### Out of scope

- Invoice issuance — stays in `invoice-core`.
- KYC / AML — stays in `compliance-core`.
- Inventory — stays in consumer backends.
- Client-side SDKs (Apple Pay, Google Pay, `flutter_stripe`) — stay in frontend apps.
- Standalone Visa Direct adapter — deferred, no consumer today.
- Crowdfunding — deferred, tracked as a separate change documenting the trigger for re-evaluation.

## Siblings

`payments-core` is one node in a small constellation of sibling `-core`
repositories. Each owns a bounded context; they collaborate through events and
explicit ports rather than shared schemas.

- **`agentic-core`** — AI orchestration. Calls `payments-core` through the
  `AgenticCheckoutPort` when an agent-driven flow needs to move money. Owns
  nothing about the payment state machine; it only initiates and observes.

- **`invoice-core`** — fiscal documents. Subscribes to `PaymentSucceeded` from
  `payments-core` and issues the corresponding electronic invoice. ERP export
  adapters (QuickBooks, Xero, Alegra) live here as `AccountingSinkPort`
  implementations, not in a separate `accounting-core`.

- **`marketplace-core`** — catalog and traceability. Also subscribes to
  `PaymentSucceeded` to close the loop between a purchase and the downstream
  marketplace record. Does not participate in authorization or capture.

- **`compliance-core`** — KYC and AML. Runs before `payments-core` on
  high-value flows; `payments-core` trusts its verdict and gates accordingly.

Consumer backends (`dojo-os`, `altrupets-api`, `habitanexus-api`,
`vertivolatam-api`, `aduanext-api`) all talk to `payments-core` through the
same gRPC sidecar contract; they never embed a Stripe or OnvoPay client
directly.

## Anti-patterns we avoid

The rubric exists in part to name the failure modes that produce premature
abstraction. The ones most relevant to a payments repository:

- **Premature abstraction.** A `-core` is only justified when multiple
  consumers already exist or are imminent. `payments-core` has five committed
  consumers at the time of extraction.
- **Reuse theoretical vs actual.** "Someone might want to reuse this" does
  not clear the rubric. The verdict requires real consumers, each listed by
  name in the evidence column.
- **Sidecar for everything.** The sidecar pattern earns its complexity when
  credential isolation, regulatory scope (PCI), and external integration
  density all point the same direction. Repositories that fail those tests
  stay as modules inside a consumer backend.
- **Destination-sink sibling.** An `accounting-core` that sits downstream of
  invoices, payments, and inventory is rejected by the rubric: its behavior
  is better expressed as an export adapter inside `invoice-core`.
- **Merging domains that share events but not state.** `invoice-core` and
  `payments-core` share `PaymentSucceeded` but own different state machines
  and fail on different failure modes. Keeping them separate is a feature,
  not duplication.

## Related pages

- [Rubric](rubric.md) — paraphrased five criteria with pointers to the
  canonical ecosystem document.
- [`proposal.md`](https://github.com/lapc506/payments-core/blob/main/openspec/changes/governance-rubric-adoption/proposal.md)
  — the OpenSpec change that froze this verdict.
- [`design.md`](https://github.com/lapc506/payments-core/blob/main/openspec/changes/governance-rubric-adoption/design.md)
  — the design notes behind this page.
