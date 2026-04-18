# Design — AduaNext integration needs

## Page content: `docs/content/docs/integrations/consumers/aduanext.md`

### 1. Intro paragraph

AduaNext is a customs-compliance platform whose flows intersect `payments-core` in five concrete ways. This page maps each flow to the port that owns it, shows the expected gRPC call shape, and flags what stays out of `payments-core`'s responsibility.

### 2. Flow A — Broker escrow

**Scenario**: a Costa Rican pyme hires a freelance broker for a single DUA. The broker charges a fixed fee. AduaNext escrows the fee and releases it in two tranches: 50% when the broker signs, 50% when ATENA issues levante.

**Call flow**:
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

Later, AduaNext calls `ReleaseEscrow(intent_id, milestone: "dua_signed")` then `ReleaseEscrow(intent_id, milestone: "levante_received")`. The `EscrowPort` is the sole source of truth for funds; AduaNext is the sole source of truth for what "levante_received" means.

### 3. Flow B — Subscription

**Scenario**: customs agencies subscribe to AduaNext in Standalone-SaaS mode.

**Call flow**: standard `CreateSubscription` / `SwitchSubscription` calls with `gateway_preference: TILOPAY` for B2B Costa Rican cards or `STRIPE` for international.

No AduaNext-specific shape.

### 4. Flow C — Customs duty payment (deferred)

**Scenario**: an importer pays customs duties to the Ministry of Finance after DUA liquidation.

**Status**: out of scope for `payments-core` v1. AduaNext surfaces a "pay duties" action that links to Hacienda's own portal. If a regulated SINPE / BCCR API becomes reachable, a future `customs-duty-payment-port` change lands.

**Why not now**: no API to call. Building a port without a rail is the rubric's §9 anti-pattern.

### 5. Flow D — Customs bonds (deferred)

**Scenario**: some import regimes (temporary admission, customs warehousing) require a bond. Bond issuers in Costa Rica are insurance companies; none currently expose an API.

**Status**: out of scope for v1. Documented as `customs-bond-port` deferred change.

### 6. Flow E — Cross-border broker/consultant payments

**Scenario**: pyme pays international consultant, or non-resident importer pays CR broker.

**Call flow**: standard `InitiateCheckout` / `CreatePayout` with `gateway_preference` in `{REVOLUT, CONVERA, RIPPLE_XRPL, STRIPE}`. The choice is AduaNext's based on corridor + currency.

### 7. Flow F — Platform fees

Modeled on `EscrowPort` with `platform_fee_minor` + `platform_fee_destination`. Maps cleanly to Stripe Connect `application_fee_amount` and to OnvoPay's equivalent parameter. For gateways without native platform-fee support, `payments-core` emits a separate transfer event after release.

### 8. What AduaNext keeps inside `aduanext-api`

Explicit list to prevent scope creep:

- DUA state (drafted, validated, signed, presented, rectified, levante).
- Tariff calculations (duties, IVA, other taxes).
- Broker assignment workflow (invitation, role, signing authority scope).
- ATENA / RIMM integration (out of scope for `payments-core`).
- SIAA document management.

### 9. Milestone taxonomy

Because milestone-based escrow release is a general pattern, `EscrowPort` treats the milestone string as opaque. AduaNext agrees internally to use these specific strings:

- `"dua_signed"` — broker signed the DUA (digitally, via hacienda-sidecar XAdES-EPES pipeline).
- `"levante_received"` — ATENA returned levante acknowledgment.
- `"cancelled"` — DUA cancelled; triggers refund path, not release.

Other AduaNext customers (future enterprise SaaS mode) MAY define their own milestone strings; the port does not care.

### 10. Testing considerations for AduaNext

- Sandbox: Stripe test mode + Tilopay sandbox cover the card flows. Cross-border cross-check in Revolut / Convera sandboxes.
- E2E: AduaNext's own E2E suite invokes `payments-core` via gRPC client generated from v1 proto. Dedicated test ATENA responses trigger the milestone calls.

## Follow-up stub changes produced

### `customs-duty-payment-port/proposal.md`

A single proposal file stating:
- Problem: customs duties are not a merchant rail.
- Trigger: when SINPE / BCCR / a cooperative exposes an API reachable from private software AND AduaNext's product team confirms a customer will use it.
- Scope if triggered: one port, one adapter, no state machine (duties payment is one-shot, confirmed by ATENA receipt).

### `customs-bond-port/proposal.md`

Same shape:
- Problem: bonds require an issuer with an API.
- Trigger: ≥1 bond issuer publishes an API AND ≥1 AduaNext customer is actively using temporary-admission / warehouse regimes at volume.

## Risks

- **Milestone string drift** — if AduaNext renames `dua_signed` → `signed_by_broker` later, the escrow records keyed on the old string break. Mitigation: document the strings in the page, and treat them as API-surface (changing them is a breaking change on AduaNext's side, not on `payments-core`).
- **Platform-fee accuracy** — Stripe Connect fees round in specific ways (minor units, same currency). The page documents this and the `EscrowPort` RPC rejects mismatched currencies at the contract level.
- **Reader assumes deferred = "later"** — some readers read "deferred" as "in two quarters". The page explicitly uses "triggers" language to frame it as event-driven, not time-driven.

## Rollback

Revert. The consumer page disappears from the docs, the stubs remain as archived proposals.
