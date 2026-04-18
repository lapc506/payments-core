# Proposal — Governance rubric adoption

## Context

The sibling repositories `agentic-core`, `marketplace-core`, and `invoice-core` (upcoming) share a single governance rubric that evaluates whether a candidate `-core` repository is justified versus living as an adapter inside an existing `-core`, a module inside a consumer backend, or a deferred concern. The rubric is a cross-repo artifact maintained at `~/Escritorio/2026-04-16-core-governance-rubric.md` and was authored on 2026-04-16.

Before this change lands, `payments-core` has no explicit record of passing that rubric. We therefore cannot defend the existence of the repository against the anti-patterns the rubric itself lists (premature abstraction, reuse theoretical vs actual, sidecar for everything, etc.).

## Why this change wins

The rubric prescribes a protocol (`§7`) that every new `-core` candidate must follow before implementation starts:

> Step 1. Nombrar el candidato. Step 2. Evaluar los 5 criterios. Step 3. Verdicto. Step 4. Si aprobado, priorizar. Step 5. Actualizar el documento de gobernanza.

This proposal is Step 5 for `payments-core`: capturing the verdict in the repository itself so any future contributor can read it without leaving the repo.

## Verdict (2026-04-18)

Score: **5 of 5**.

| Criterion | Result | Key evidence |
|---|:---:|---|
| 1. Cross-startup reuse | ✅✅ | Five committed consumers: dojo-os, altrupets-api, habitanexus-api, vertivolatam-api, aduanext-api |
| 2. Bounded domain | ✅ | State machines for PaymentIntent, Subscription, Escrow, Payout, Refund, Dispute are all payments-local; invoice-core consumes `PaymentSucceeded`, it does not own the state |
| 3. Non-trivial complexity | ✅✅ | 3DS, webhook HMAC, idempotency, reconciliation, chargebacks, PCI SAQ-A scoping, multi-currency FX, split payments, payout schedules |
| 4. Credential / regulatory isolation | ✅✅ | Stripe secrets, OnvoPay keys, Tilopay keys, webhook signing secrets, PCI scope all collapse into the sidecar pod |
| 5. External integrations with rate-limit / retry | ✅✅ | Stripe, OnvoPay, Tilopay, dLocal, Revolut, Convera, Ripple, Apple Pay / Google Pay token verification |

The ecosystem rubric requires `≥ 4 of 5`. `payments-core` clears this threshold with multiple `✅✅` entries, putting it in the same strength bracket as `compliance-core` (the only other current 5/5).

## Decisions derived from the verdict

The same brainstorming session that produced the verdict also produced the decisions listed below. They are captured here (and not scattered across the repository) so a new contributor has a single entry point:

- **Language**: TypeScript. Parity with `marketplace-core` and `invoice-core`. Rejected Python (despite `agentic-core` precedent) because the sidecar boundary is gRPC; the language gain does not offset the ecosystem-split cost.
- **License**: BSL 1.1 with a Change Date of 2031-04-18 (five years from first release) and a Change License of Apache 2.0. Matches `agentic-core` and `invoice-core`. Rationale: `payments-core` handles money, so commercial-reuse risk is real.
- **Architecture**: Hexagonal (Explicit Architecture). Sidecar gRPC + standalone Docker. Mirrors the three siblings.
- **Scope boundaries**:
  - **In**: PaymentIntent, Subscription, Escrow, Payout, Refund, Dispute, Reconciliation, AgenticPayment, FX lookup, WebhookVerifier, Idempotency, Donation (one-time + recurring).
  - **Out**: invoice issuance (stays in `invoice-core`), KYC / AML (stays in `compliance-core`), inventory (stays in consumer backends), client-side SDKs (Apple Pay / Google Pay / flutter_stripe — stay in frontend apps), standalone Visa Direct adapter (no consumer today).
- **Crowdfunding**: deferred. Captured as a separate change (`crowdfunding-diferred`) that documents the Vaki / Coopeservidores collapse and the Kickstarter / Indiegogo alternatives without implementing them. Trigger for re-evaluation is documented.

## Alternatives rejected

- **`accounting-core` sibling** — the rubric itself rejects this: `accounting-core` is a destination sink over invoice + payments + inventory. Any ERP export adapter (QuickBooks, Xero, Alegra) lives **inside** `invoice-core` as an `AccountingSinkPort`.
- **Merge `payments-core` into `invoice-core`** — rejected because the state machines differ. `invoice-core` emits a fiscal document **after** payment succeeds; that is a distinct bounded context.
- **Do not build a sidecar, leave payments in each backend** — rejected because `dojo-os` alone already has 3,429 LOC across 13 Edge Functions replicating Stripe + service_role patterns. Multiplying that by five consumers crosses the threshold the rubric uses to justify extraction.

## Acceptance

This change is accepted when:

1. The three files (`proposal.md`, `design.md`, `tasks.md`) are merged to `main`.
2. The companion documentation page `docs/content/docs/governance/index.md` is created and renders under MkDocs.
3. The ecosystem rubric document (outside this repo) is updated to add `payments-core` under §5 with the same score table.
