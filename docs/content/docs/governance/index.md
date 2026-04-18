# Governance

## Why this repository exists

The `-core` ecosystem shares a single governance rubric that decides when a
domain justifies a standalone `-core` repository and when it should live as an
adapter inside an existing `-core`, a module inside one consumer backend, or
be deferred until the evidence justifies the investment. The rubric is the
cross-repo artifact; this page is the `payments-core` verdict against it.

`payments-core` was evaluated on 2026-04-18 and scored **5 of 5**. The
ecosystem threshold is four. Before this verdict landed, the repository had
no explicit defence of its own existence — any new contributor had to
reconstruct the rationale from scattered backend code. That is the gap this
page closes.

The full decision trail, including the alternatives that were considered and
rejected, is the OpenSpec change
[`governance-rubric-adoption`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/governance-rubric-adoption).
The five criteria themselves are summarised on the [Rubric](rubric.md) page.

## Verdict

| Criterion | Result | Key evidence |
|---|:---:|---|
| 1. Cross-startup reuse | :material-check-all: | Five committed consumers: `dojo-os`, `altrupets-api`, `habitanexus-api`, `vertivolatam-api`, `aduanext-api` |
| 2. Bounded domain | :material-check: | State machines for PaymentIntent, Subscription, Escrow, Payout, Refund, Dispute are payments-local; `invoice-core` consumes the `PaymentSucceeded` event, it does not own the state |
| 3. Non-trivial complexity | :material-check-all: | 3DS, webhook HMAC, idempotency, reconciliation, chargebacks, PCI SAQ-A scoping, multi-currency FX, split payments, payout schedules |
| 4. Credential / regulatory isolation | :material-check-all: | Stripe secrets, OnvoPay keys, Tilopay keys, webhook signing secrets, PCI scope all collapse into the sidecar pod |
| 5. External integrations with rate-limit / retry | :material-check-all: | Stripe, OnvoPay, Tilopay, dLocal, Revolut, Convera, Ripple, Apple Pay / Google Pay token verification |

Double-check marks (`:material-check-all:`) flag strong passes — the same
notation used for `compliance-core`, the only other current 5 of 5 in the
ecosystem.

## Scope boundaries

The verdict is inseparable from what the repository agrees **not** to own.
Scope creep is the fastest way to invalidate a rubric decision after the
fact.

**In scope.** PaymentIntent, Subscription, Escrow, Payout, Refund, Dispute,
Reconciliation, AgenticPayment, FX lookup, WebhookVerifier, Idempotency, and
Donation (one-time + recurring). Every state machine listed here is owned
here.

**Out of scope.** Invoice issuance stays in `invoice-core`. KYC and AML stay
in `compliance-core`. Inventory stays in each consumer backend. Client-side
SDKs (Apple Pay, Google Pay, `flutter_stripe`) stay in the frontend apps
that ship them. A standalone Visa Direct adapter is deferred because no
consumer needs it yet. Crowdfunding is deferred for the reasons captured in
the
[`crowdfunding-deferred`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/crowdfunding-deferred)
change.

## Siblings

`payments-core` is one node of a five-repository ecosystem. Understanding
how it collaborates with the other four is how a reader knows where to look
when a concern feels adjacent but is not payments.

- **`agentic-core`** owns AI agent orchestration, memory, and tool routing.
  It consumes `payments-core` through an `AgenticCheckoutPort` when an agent
  needs to move money; `payments-core` does not call back into it.
- **`marketplace-core`** owns catalog, inventory, availability, and
  traceability. It listens to `PaymentSucceeded` events from `payments-core`
  to close the loop on an order; the state machines do not overlap.
- **`invoice-core`** owns fiscal document issuance (CR v4.4, MX retention,
  CO retention, donation receipts). It listens to `PaymentSucceeded` and
  emits a comprobante; payment state is not fiscal state.
- **`compliance-core`** owns KYC, AML, sanctions screening, and audit
  trails. Above the high-value threshold, `payments-core` gates transactions
  on a compliance response; compliance does not own the payment state
  machine either.

## Anti-patterns we avoid

The ecosystem rubric enumerates the failure modes that keep reappearing in
`-core` proposals. The ones that apply to payments specifically:

- **"It sounds useful, therefore it is a `-core`."** The rubric is the
  filter that separates well-branded proposals from justified ones.
- **Theoretical reuse.** A port is added only when a second named consumer
  needs it in the next 12 to 18 months. `payments-core` shipped with five
  confirmed consumers; future adapters will be held to the same standard.
- **Adapter dressed as a domain.** If a candidate only serialises existing
  state to an external sink, it is an adapter, not a `-core`. An ERP sink
  for reconciled payments (QuickBooks, Xero, Alegra) lives inside
  `invoice-core` as an `AccountingSinkPort`; there is no `accounting-core`.
- **Sidecar for everything.** Sidecars pay for themselves only when all
  five rubric criteria clear. Utilities, libraries, and backend-local
  modules are first-class alternatives and should be the default for
  anything that does not clear the bar.
- **Premature multi-country breadth.** The adapter set is expanded rail by
  rail, driven by a named consumer use case, not by "it would be nice to
  support X eventually."
