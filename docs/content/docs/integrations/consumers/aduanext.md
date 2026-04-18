# AduaNext

AduaNext is a multi-hacienda customs-compliance platform (starting with Costa
Rica's ATENA) that serves pymes importing specialized components, freelance
customs brokers (agentes aduanales), and full-service customs agencies. It
runs in three modes: Importer-Led, Standalone SaaS, and Sidecar K8s.

AduaNext's flows intersect `payments-core` in six concrete ways. This page
maps each flow to the port that owns it, shows the expected gRPC call shape,
and flags what stays out of `payments-core`'s responsibility.

The escrow-specific fields (`milestone_condition`, `platform_fee_minor`,
`platform_fee_destination`) are specified in the
[`escrow-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port)
— this page documents how AduaNext uses them; the port change is the source
of truth for the field contract.

## Flow summary

| Flow | Status | Port | Notes |
|---|---|---|---|
| A — Broker escrow | in scope (v1) | `EscrowPort` | milestone-based release |
| B — Subscription | in scope (v1) | `SubscriptionPort` | standard shape |
| C — Customs duty payment | deferred | — | no reachable rail today |
| D — Customs bonds | deferred | — | no bond-issuer API today |
| E — Cross-border payments | in scope (v1) | `PaymentGatewayPort` / `PayoutPort` | via Revolut / Convera / Ripple / Stripe |
| F — Platform fees | in scope (v1) | `EscrowPort` fields | `platform_fee_*` metadata |

## Flow A — Broker escrow

**Scenario.** A Costa Rican pyme hires a freelance broker for a single DUA.
The broker charges a fixed fee. AduaNext escrows the fee and releases it in
two tranches: 50% when the broker signs the DUA, 50% when ATENA issues
levante.

**Call flow.**

```
aduanext-api → payments-core
  HoldEscrow {
    consumer: "aduanext-api"
    amount: { amount_minor: 150000, currency: "CRC" }   // 1,500 CRC
    payer: "pyme-{tenant-id}-customer-{id}"
    payee: "broker-{broker-id}"
    milestone_condition: {
      milestones: ["dua_signed", "levante_received"]
      release_split: [50, 50]
    }
    platform_fee_minor: 15000                            // 10% platform fee
    platform_fee_destination: "aduanext-platform-account"
    idempotency_key: "{dua-id}-hold"
  }
```

Later, `aduanext-api` calls:

```
ReleaseEscrow(intent_id, milestone: "dua_signed")
ReleaseEscrow(intent_id, milestone: "levante_received")
```

`EscrowPort` is the sole source of truth for funds. AduaNext is the sole
source of truth for what `"levante_received"` means. `payments-core` does
not know or care about customs regulation — it only matches the milestone
string against the condition set at hold time.

## Flow B — Subscription

**Scenario.** Customs agencies subscribe to AduaNext in Standalone-SaaS mode.

**Call flow.** Standard `CreateSubscription` / `SwitchSubscription` calls
with `gateway_preference: TILOPAY` for B2B Costa Rican cards or `STRIPE` for
international.

No AduaNext-specific shape.

## Flow C — Customs duty payment (deferred)

**Scenario.** An importer pays customs duties to the Ministry of Finance
after DUA liquidation.

**Status.** Out of scope for `payments-core` v1. AduaNext surfaces a "pay
duties" action that links to Hacienda's own portal. If a regulated SINPE /
BCCR API becomes reachable from private software, a future
[`customs-duty-payment-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-duty-payment-port)
lands.

**Why not now.** No API to call. Building a port without a rail is the
ecosystem rubric's §9 anti-pattern.

**Trigger to revisit.** A regulated SINPE / BCCR / cooperative API becomes
reachable from private software **and** AduaNext's product team confirms a
customer will use it.

## Flow D — Customs bonds (deferred)

**Scenario.** Some import regimes (temporary admission, customs warehousing)
require a bond. Bond issuers in Costa Rica are insurance companies; none
currently expose an API.

**Status.** Out of scope for v1. Documented as
[`customs-bond-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-bond-port),
proposal-only.

**Trigger to revisit.** ≥1 bond issuer publishes an API **and** ≥1 AduaNext
customer is actively using temporary-admission / warehouse regimes at
volume.

## Flow E — Cross-border broker/consultant payments

**Scenario.** Pyme pays international consultant, or non-resident importer
pays CR broker.

**Call flow.** Standard `InitiateCheckout` / `CreatePayout` with
`gateway_preference` in `{REVOLUT, CONVERA, RIPPLE_XRPL, STRIPE}`. The
choice is AduaNext's based on corridor + currency; the relevant adapter
changes (`revolut-adapter`, `convera-adapter`, `ripple-xrpl-adapter`,
`stripe-adapter-p0`) each note "used by AduaNext for Flow E".

## Flow F — Platform fees

Modeled on `EscrowPort` with `platform_fee_minor` + `platform_fee_destination`.
Maps cleanly to Stripe Connect `application_fee_amount` and to OnvoPay's
equivalent parameter. For gateways without native platform-fee support,
`payments-core` emits a separate transfer event after release.

The full field contract, adapter-support matrix, and per-gateway rounding
rules live in the [`escrow-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port).

## What AduaNext keeps inside `aduanext-api`

Explicit list to prevent scope creep:

- DUA state (drafted, validated, signed, presented, rectified, levante).
- Tariff calculations (duties, IVA, other taxes).
- Broker assignment workflow (invitation, role, signing authority scope).
- ATENA / RIMM integration.
- SIAA document management.

None of these belong in `payments-core`. The boundary is: if the state is
about money, it is in `payments-core`; if it is about regulation or
documents, it is in `aduanext-api`.

## Milestone taxonomy

Because milestone-based escrow release is a general pattern, `EscrowPort`
treats the milestone string as opaque. AduaNext agrees internally to use
these specific strings:

- `"dua_signed"` — broker signed the DUA (digitally, via the
  hacienda-sidecar XAdES-EPES pipeline).
- `"levante_received"` — ATENA returned the levante acknowledgment.
- `"cancelled"` — DUA cancelled; triggers the refund path, not release.

Other AduaNext customers (future enterprise SaaS mode) MAY define their own
milestone strings; the port does not care, provided the strings used in
`ReleaseEscrow` match the ones passed in `HoldEscrow.milestone_condition`.

**String stability warning.** These strings are API surface on AduaNext's
side. Renaming `"dua_signed"` → `"signed_by_broker"` would break escrow
records keyed on the old string. Treat renames as breaking changes; use an
additive migration (accept both strings during transition) rather than a
hard cut-over.

## Testing considerations for AduaNext

- **Sandbox.** Stripe test mode + Tilopay sandbox cover the card flows.
  Cross-border cross-check in Revolut / Convera sandboxes.
- **E2E.** AduaNext's own E2E suite invokes `payments-core` via the gRPC
  client generated from the v1 proto. Dedicated test ATENA responses
  trigger the milestone calls.
- **Milestone ordering.** Tests must confirm that releasing `"levante_received"`
  before `"dua_signed"` is rejected with `INVALID_STATE`, matching the port
  contract.

## See also

- [`aduanext-integration-needs` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/aduanext-integration-needs)
  — proposal, design, and tasks that produced this page.
- [`escrow-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port)
  — `milestone_condition` and `platform_fee_*` field contract, adapter
  support matrix, adapter-side bookkeeping pattern.
- [`customs-duty-payment-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-duty-payment-port)
  — deferred stub for Flow C.
- [`customs-bond-port` change](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-bond-port)
  — deferred stub for Flow D.
