# Design — EscrowPort (detailed specification)

This change is **documentation-only**. It formalizes the contract that the
already-landed `EscrowPort` interface (from `domain-skeleton`, PR #22) and the
already-landed escrow use cases (from `application-use-cases`, PR #23) exposed
to consumers — specifically the `milestone_condition` and `platform_fee_*`
fields that AduaNext depends on per
`openspec/changes/aduanext-integration-needs/`.

No runtime adapter is added. Stripe escrow and OnvoPay escrow adapters land in
their own follow-up changes; both stubs are deferred to P1.

## File layout

### Already landed (unchanged by this change)

```
src/domain/entities/escrow.ts            # Escrow entity + MilestoneCondition (PR #22)
src/domain/ports/index.ts                # EscrowPort + input/result types (PR #22)
src/application/use_cases/escrow.ts      # HoldEscrow + ReleaseEscrow + DisputeEscrow (PR #23)
test/domain/entities.test.ts             # Escrow state-machine tests (PR #22)
```

### Added by this change

```
openspec/changes/escrow-port/design.md   # This file
openspec/changes/escrow-port/tasks.md    # Completion checklist
docs/content/docs/ports/escrow.md        # Reader-facing port contract page
docs/mkdocs.yml                          # Nav entry under Ports (if missing)
```

### Optional (only if §Contract reinforcement below requires it)

```
src/domain/ports/index.ts                # JSDoc tightening on EscrowPort methods
src/domain/entities/escrow.ts            # JSDoc tightening on state transitions
test/domain/entities.test.ts             # +2 milestone-semantic tests
```

## State machine

Defined in `src/domain/entities/escrow.ts` (canonical source):

```
held ──► released
     ├─► refunded
     └─► disputed ──► released   (payee wins)
                  └─► refunded   (payer wins)
```

Key invariants enforced by `transitionEscrow`:

1. `held` is the only legal initial status; `createEscrow` returns `held`.
2. `released` and `refunded` are terminal — no further transitions are legal.
3. A `disputed` escrow resolves only to `released` or `refunded`; any other
   target raises `DisputeOngoingError` (not `InvalidStateTransitionError`) so
   the failure mode is operationally distinct from generic illegal transitions.
4. Partial releases do **not** advance the status. The gateway replies with
   `status: 'held'` on each tranche, and only the final tranche (or a
   full-release call with no `milestone`) advances the entity to `released`.

`releasedAmount` is a running total accumulated by the `ReleaseEscrow` use
case from each `ReleaseEscrowResult.releasedAmount`. It is a live `Money`
value object (not a plain literal), so `Money.add` catches cross-currency
accumulation at the domain layer.

## Milestone conditions

The contract AduaNext depends on (see
`docs/content/docs/integrations/consumers/aduanext.md` § Flow A):

```ts
export interface MilestoneCondition {
  readonly milestones: readonly string[];     // opaque consumer-defined strings
  readonly releaseSplit: readonly number[];   // percentages matching milestones length
}
```

**Semantics** (normative):

- `milestones[i]` is an opaque string. The domain does not interpret it.
  AduaNext uses `"dua_signed"`, `"levante_received"`, `"cancelled"`; other
  consumers are free to define their own.
- `releaseSplit[i]` is a whole-number percentage. Elements sum to `100` and
  `releaseSplit.length === milestones.length`.
- Calling `release({ gatewayRef, milestone: milestones[i], idempotencyKey })`
  releases the tranche `amount * releaseSplit[i] / 100` (minor units,
  banker's rounding at the gateway adapter layer).
- Milestones must be released **in order**. Calling `release` with
  `milestones[2]` before `milestones[1]` is an `INVALID_STATE` error surfaced
  by the adapter; the domain itself does not track the ordering because it is
  stateless across calls — ordering is enforced by the adapter bookkeeping.
- Calling `release` with no `milestone` and no `amount` releases the entire
  remaining balance in one call — useful when the external condition is
  confirmed in a single step.
- Calling `release` with an explicit `amount` and no `milestone` (partial
  amount) is supported for gateways that model custody by amount rather than
  by milestone (e.g. XRPL escrow). The sum of partial amounts must not exceed
  `amount - releasedAmount`; the adapter rejects overages as `INVALID_STATE`.

Release splits and partial amounts are **mutually exclusive per call**.
Mixing them is an error (`INVALID_INPUT`).

## Platform fees

The contract AduaNext depends on (see § Flow F):

- `platformFeeMinor: bigint` — fee amount in the **same currency** as
  `amount`. Currency mismatch is rejected at the port contract level
  (`CURRENCY_MISMATCH`). Zero (`0n`) means "no platform fee", which is the
  documented default from `createEscrow`.
- `platformFeeDestination: string` — gateway-native account identifier,
  opaque to the domain. Stripe uses `acct_*` Connect account IDs; OnvoPay
  uses its own account identifier format. The domain stores the value as an
  opaque string; validation lives in the adapter.

**Gateway mapping:**

| Gateway  | Native field                                 | Notes                                              |
|----------|----------------------------------------------|----------------------------------------------------|
| Stripe   | `application_fee_amount` (Stripe Connect)    | Native; Stripe deducts on each transfer.           |
| OnvoPay  | Equivalent platform-fee parameter            | Native (TODO: verify exact field name on adapter). |
| Revolut  | Limited — account-level fee routing          | Adapter may need to split release into two calls.  |
| Convera  | Not supported natively                       | Out of scope for v1 escrow on Convera.             |
| Ripple   | Not supported natively                       | Escrow is XRPL-native; fees are network-only.      |

Gateways without a native platform-fee primitive fall back to
**adapter-side bookkeeping**: the adapter holds the full sum in the gateway
and emits a separate internal transfer per release, each idempotent on the
same `idempotencyKey`. The adapter documents the fallback path in its own
change proposal.

**Fee allocation across tranches** (when `milestoneCondition` is set):

- Default policy: the fee is deducted **proportionally** to the release
  split. For `releaseSplit: [50, 50]` and `platformFeeMinor: 15_000n`, each
  tranche carries a `7_500n` fee.
- Gateways that require all-fee-on-first-release (Stripe Connect in some
  account configurations) may override this policy; the adapter documents
  the override in its own proposal.
- The final tranche always absorbs any rounding residue to keep the sum of
  deducted fees exactly equal to `platformFeeMinor`.

## Multi-party structure

An escrow has **three distinct references**:

| Reference                   | Role                                                    | Type                     |
|-----------------------------|---------------------------------------------------------|--------------------------|
| `payerReference`            | Account / customer that funded the escrow               | `string` (consumer-ns)   |
| `payeeReference`            | Account that receives releases                          | `string` (consumer-ns)   |
| `platformFeeDestination`    | Account that receives the platform fee on release      | `string` (gateway-ns)    |

`payerReference` and `payeeReference` are consumer-namespaced (AduaNext uses
`"pyme-{tenant-id}-customer-{id}"` / `"broker-{broker-id}"`). The platform
fee destination is gateway-namespaced (Stripe `acct_*`, OnvoPay account
id). These two namespaces do not overlap by design — the domain stays
agnostic of either.

## Disputes

`EscrowPort.dispute` opens a dispute against the gateway and returns a
`disputeId`. Follow-up evidence submission goes through
[`DisputePort.submitEvidence`](./../../../src/domain/ports/index.ts), not
through `EscrowPort` — see the nine-port layout in `src/domain/ports/index.ts`.

The separation exists because card-issuer chargebacks (the typical
`DisputePort` use case) and escrow disputes (the `EscrowPort.dispute` use
case) share the same evidence-submission flow but differ in how the dispute
is opened:

- Card chargebacks: opened **by the card issuer**, surfaced via webhook.
  `DisputePort.submitEvidence` is the only outbound call.
- Escrow disputes: opened **by either party** (payer or payee) via the
  consumer backend calling `EscrowPort.dispute`. Evidence submission then
  follows the same `DisputePort.submitEvidence` flow.

## Risks

- **Currency mismatches** — `platformFeeMinor` in a different currency than
  `amount` is a validation error at the port contract level. The adapter
  layer rejects at call time; the entity cannot be constructed with an
  inconsistent fee (documentation-enforced, type-enforced via `Money`).
- **Partial releases before all milestones hit** — a consumer releasing
  `milestones[0]` and then calling `refund` is an ambiguous state. Per the
  state machine, `held → refunded` is legal even after partial release. The
  gateway adapter is responsible for refunding only the unreleased balance
  (`amount - releasedAmount`). `payments-core` surfaces the error if the
  gateway refuses.
- **Refund-after-partial-release semantics** — when a partially-released
  escrow is refunded, the `refundedAmount` on the resulting `Refund` entity
  must equal `amount - releasedAmount`, not `amount`. The adapter is
  authoritative; the entity records whatever the adapter returns.
- **Milestone string drift** — if a consumer (AduaNext) renames a milestone,
  in-flight escrows keyed on the old string orphan. Mitigation: both this
  port spec and the AduaNext consumer page pin the strings as API surface.
  Renames must be versioned migrations with a dual-write window.
- **Adapter-side bookkeeping divergence** — gateways without native milestone
  support rely on `payments-core`'s own ledger to track the split. If the
  adapter crashes between "gateway reports held" and "ledger records the
  tranche", replay on the idempotency key recovers. This is covered by the
  idempotency contract (`IdempotencyPort`) and tested with
  `FakeEscrowGateway` in follow-up adapter changes.

## Rollback

Revert. Documentation-only change: reverting removes the `design.md`,
`tasks.md`, the `docs/content/docs/ports/escrow.md` page, and any JSDoc
refinements on the port interface. Runtime code is untouched.

## Cross-references

- [`proposal.md`](./proposal.md) — original proposal (kept verbatim).
- [`openspec/changes/aduanext-integration-needs/design.md`](../aduanext-integration-needs/design.md)
  — the consumer side of the milestone / platform-fee contract.
- [`openspec/changes/application-use-cases/`](../application-use-cases/)
  — where `HoldEscrow`, `ReleaseEscrow`, `DisputeEscrow` were specced.
- [`openspec/changes/stripe-adapter-p0/`](../stripe-adapter-p0/)
  — reference adapter; escrow implementation is P1 follow-up.
- [`openspec/changes/onvopay-adapter-p0/`](../onvopay-adapter-p0/)
  — OnvoPay adapter; escrow implementation is P1 follow-up.
