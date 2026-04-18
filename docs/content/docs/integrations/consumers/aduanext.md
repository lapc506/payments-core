# AduaNext

AduaNext is a customs-compliance platform whose flows intersect
`payments-core` in five concrete ways. This page maps each flow to the port
that owns it, shows the expected gRPC call shape, and flags what stays out of
`payments-core`'s responsibility.

AduaNext starts with Costa Rica's ATENA integration and serves three
audiences: pymes importing specialized components, freelance customs brokers
(agentes aduanales), and full-service customs agencies. It operates in three
modes — Importer-Led, Standalone SaaS, and Sidecar K8s — but the
`payments-core` contract is identical across modes.

## Flow summary

| Flow | Scenario | Port | Status |
|---|---|---|---|
| A | Broker escrow (pyme → broker, milestone release) | `EscrowPort` | In scope for v1 |
| B | Subscription (agencies on Standalone SaaS) | `SubscriptionPort` | In scope for v1 |
| C | Customs duty payment (importer → Hacienda) | none today | Deferred |
| D | Customs bond (garantía aduanera) | none today | Deferred |
| E | Cross-border broker / consultant payments | `PaymentGatewayPort` + `PayoutPort` | In scope for v1 |
| F | Platform fees on brokered flows | `EscrowPort` (`platform_fee_*`) | In scope for v1 |

Flows C and D are deferred because the underlying rail is not reachable via
API today, not because they are roadmap items. See
[Flow C](#flow-c-customs-duty-payment-deferred) and
[Flow D](#flow-d-customs-bonds-deferred) for the exact re-evaluation
triggers.

## Flow A — Broker escrow

**Scenario**: a Costa Rican pyme hires a freelance broker for a single DUA.
The broker charges a fixed fee. AduaNext escrows the fee and releases it in
two tranches: 50% when the broker signs, 50% when ATENA issues levante.

**Port**: [`EscrowPort`](../../ports/index.md) with `milestone_condition`
metadata.

**Call flow** — `aduanext-api` → `payments-core`:

```text
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

Later, AduaNext calls `ReleaseEscrow(intent_id, milestone: "dua_signed")` and
then `ReleaseEscrow(intent_id, milestone: "levante_received")`. The
`EscrowPort` is the sole source of truth for funds; AduaNext is the sole
source of truth for what `"levante_received"` means.

The `milestone_condition` and `platform_fee_*` field contract lives in the
[`escrow-port`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port)
OpenSpec change — that change is the normative source for field types,
validation rules, and the adapter support matrix.

## Flow B — Subscription

**Scenario**: customs agencies subscribe to AduaNext in Standalone-SaaS mode.

**Port**: `SubscriptionPort`.

**Call flow**: standard `CreateSubscription` / `SwitchSubscription` calls
with `gateway_preference: TILOPAY` for B2B Costa Rican cards or `STRIPE` for
international.

No AduaNext-specific shape. Fully covered by `stripe-adapter-p0` and
`tilopay-adapter-p1`.

## Flow C — Customs duty payment (deferred)

**Scenario**: an importer pays customs duties to the Ministry of Finance
after DUA liquidation.

**Status**: out of scope for `payments-core` v1. AduaNext surfaces a "pay
duties" action that links to Hacienda's own portal. If a regulated SINPE /
BCCR API becomes reachable, a future
[`customs-duty-payment-port`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-duty-payment-port)
change lands.

**Why not now**: no API to call. Building a port without a rail is the
rubric's §9 anti-pattern ("construir antes de consumidor") — we would be
shipping something no consumer can actually invoke because the rail is not
reachable from private software.

**Re-evaluation trigger**: a regulated SINPE / BCCR / cooperative API becomes
reachable from private software **and** AduaNext's product team confirms a
customer will use it.

## Flow D — Customs bonds (deferred)

**Scenario**: some import regimes (temporary admission, customs warehousing)
require a bond (garantía). Bond issuers in Costa Rica are insurance
companies; none currently expose an API.

**Status**: out of scope for v1. Documented as the
[`customs-bond-port`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-bond-port)
deferred change.

**Re-evaluation trigger**: at least one bond issuer publishes an API **and**
at least one AduaNext customer is actively using temporary-admission /
warehouse regimes at volume.

## Flow E — Cross-border broker / consultant payments

**Scenario**: a pyme pays an international consultant, or a non-resident
importer pays a Costa Rican broker.

**Ports**: `PaymentGatewayPort` (inbound) and `PayoutPort` (outbound).

**Call flow**: standard `InitiateCheckout` / `CreatePayout` with
`gateway_preference` in `{REVOLUT, CONVERA, RIPPLE_XRPL, STRIPE}`. The
choice is AduaNext's, based on the corridor and currency.

No AduaNext-specific port needed; the existing adapter changes cover this
flow.

## Flow F — Platform fees

**Scenario**: AduaNext charges a platform fee when it brokers a freelance
relationship (Flow A). The fee is deducted from the escrowed amount on
release.

**Port**: `EscrowPort` with `platform_fee_minor` and
`platform_fee_destination`.

**Mapping**:

- Stripe Connect → `application_fee_amount` (native).
- OnvoPay → equivalent platform-fee parameter (native).
- Gateways without native platform-fee support → `payments-core` emits a
  separate transfer event after release; the adapter documents whichever
  path it takes.

The fee is in the same currency as the escrowed amount. Currency mismatch is
rejected at the port contract level.

## What AduaNext keeps inside `aduanext-api`

Explicit list to prevent scope creep — none of the following belong in
`payments-core`:

- DUA state (drafted, validated, signed, presented, rectified, levante).
- Tariff calculations (duties, IVA, other taxes).
- Broker assignment workflow (invitation, role, signing authority scope).
- ATENA / RIMM integration.
- SIAA document management.

## Milestone taxonomy

Because milestone-based escrow release is a general pattern, `EscrowPort`
treats the milestone string as opaque. AduaNext agrees internally to use
these specific strings:

- `"dua_signed"` — broker signed the DUA (digitally, via the
  hacienda-sidecar XAdES-EPES pipeline).
- `"levante_received"` — ATENA returned levante acknowledgment.
- `"cancelled"` — DUA cancelled; triggers the refund path, not release.

Other AduaNext customers (future enterprise SaaS mode) MAY define their own
milestone strings; the port does not care.

!!! warning "Milestone strings are API surface"
    Renaming `"dua_signed"` → `"signed_by_broker"` later is a **breaking
    change** on AduaNext's side. Escrow records are keyed on these strings;
    renaming them orphans in-flight escrows. Treat any rename as a versioned
    migration with a dual-write window.

## Testing considerations

- **Sandbox**: Stripe test mode plus Tilopay sandbox cover the card flows.
  Cross-border cross-check in Revolut and Convera sandboxes.
- **E2E**: AduaNext's own E2E suite invokes `payments-core` via the gRPC
  client generated from the v1 proto. Dedicated test ATENA responses trigger
  the milestone calls.

## Risks

- **Milestone string drift** — if AduaNext renames a milestone later, escrow
  records keyed on the old string break. Mitigation: this page and the
  [`escrow-port`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port)
  change both pin the strings; renames must be treated as versioned API
  changes.
- **Platform-fee accuracy** — Stripe Connect fees round in specific ways
  (minor units, same currency). The `EscrowPort` RPC rejects mismatched
  currencies at the contract level.
- **Reader assumes deferred = "later"** — some readers parse "deferred" as
  "in two quarters". The deferrals for Flows C and D are **event-driven**:
  they hinge on an external rail becoming reachable, not on a calendar.

## Related

- OpenSpec change directory:
  [`openspec/changes/aduanext-integration-needs/`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/aduanext-integration-needs)
  (proposal, design, tasks).
- Escrow field contract:
  [`openspec/changes/escrow-port/`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port)
  — normative source for `milestone_condition` and `platform_fee_*`.
- Deferred stubs:
  [`customs-duty-payment-port/`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-duty-payment-port),
  [`customs-bond-port/`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/customs-bond-port).
- Cross-border adapters: `revolut-adapter`, `convera-adapter`,
  `ripple-xrpl-adapter` (see the
  [Adapters](../../adapters/index.md) index).
