# Proposal — AduaNext integration needs

## Context

`aduanext-api` is one of the five committed consumers of `payments-core`. AduaNext is a multi-hacienda customs-compliance platform (starting with Costa Rica's ATENA) that serves pymes importing specialized components, freelance customs brokers (agentes aduanales), and full-service customs agencies. It operates in three modes: Importer-Led, Standalone SaaS, and Sidecar K8s.

Different flows in AduaNext touch money in different ways. Before we write adapter code, this change maps each flow to the right `payments-core` port (or to "out of scope") so subsequent adapter changes know what to ship first.

## Why this is a dedicated change

AduaNext is unusual among our consumers:

- **Regulatory surface**: customs duties are paid to the Ministry of Finance, not to a merchant. Standard card gateways do not cover that rail.
- **Marketplace-like triangle**: pymes contract freelance brokers for a single signature. Payment flows between three parties (pyme → platform → broker) with release contingent on regulatory events (DUA signed, DUA presented, DUA "levante" received).
- **Optional post-v1 rails**: SINPE / Banco Central CR automations exist only conceptually today.

The other consumers (dojo-os, altrupets, habitanexus, vertivolatam) are more conventional and mostly live inside the existing port set. AduaNext needs an explicit mapping to avoid scope creep into `payments-core` of things that belong in `aduanext-api`.

## AduaNext flows and their `payments-core` fit

### Flow A — Broker escrow

Pyme hires a freelance broker for a specific DUA. The pyme pays upfront, the money is held in escrow, and released to the broker only when the DUA reaches an agreed milestone (signed by broker → presented to ATENA → "levante" received).

- **Port fit**: `EscrowPort` with `milestone_condition` metadata.
- **State machine**: held → partial_release (on signature) → final_release (on levante) | refunded (on cancellation) | disputed.
- **Open question**: does "levante" trigger come from ATENA via `aduanext-api`? Yes — aduanext-api calls `ReleaseEscrow(intent_id, milestone: "levante_received")`. `payments-core` is blind to customs regulation.

**In scope** of this change: document the API call shape and the `milestone_condition` metadata fields.

### Flow B — Subscription (Standalone SaaS mode)

Customs agencies subscribe to AduaNext monthly/yearly.

- **Port fit**: `SubscriptionPort`. Fully covered by `stripe-adapter-p0` + `tilopay-adapter-p1` (Tilopay because it is Costa-Rica-native for B2B).
- Out of this change: nothing AduaNext-specific beyond tagging `consumer="aduanext-api"` on the RPC.

### Flow C — Customs duty payment (pyme → Hacienda)

When DUA is liquidated, the importer must pay customs duties to the Ministry of Finance. This is **not** a standard merchant flow: the payee is a government treasury, rails are Costa Rica-specific (SINPE Móvil, direct bank transfer to a Hacienda account, BCCR settlement).

- **Port fit**: none today.
- **Decision**: **out of scope for v1**. AduaNext surfaces a "pay duties" UX and links to Hacienda's own payment portal. When/if a regulated SINPE API becomes reachable to private software, we add a `CustomsDutyPaymentPort` in a new change.
- **Why**: the rubric's §9 anti-pattern "construir antes de consumidor" — we would be building something no consumer can actually call because the rail is not reachable.

### Flow D — Customs bonds / garantías aduaneras

Some import regimes require a bond (garantía) held while goods are in transit or in customs warehouse.

- **Port fit**: `EscrowPort` can model bonds, but the counterparties are `aduanext-api` (holder on behalf of Hacienda) and the importer. Regulated bond issuers exist (Costa Rican insurance companies) and do not have an API surface today.
- **Decision**: **out of scope for v1**. Documented as a future adapter if a bond issuer exposes an API.

### Flow E — Cross-border payments for international importers

Non-resident importers paying Costa-Rican freelance brokers, or Costa-Rican pymes paying international freelancers for compliance consulting.

- **Port fit**: `PaymentGatewayPort` + `PayoutPort`. Best rails:
  - `revolut-adapter` — multi-currency accounts, FX.
  - `convera-adapter` — bulk B2B cross-border, ex-Western Union Business Solutions, Ripple stablecoin rails on the roadmap (Convera announcement 2025).
  - `ripple-xrpl-adapter` — long-horizon on-chain settlement.
- **Decision**: covered by the existing adapter changes; AduaNext consumers call `InitiateCheckout(gateway_preference: REVOLUT)` etc. No AduaNext-specific port needed.

### Flow F — Platform fee on broker escrow

When AduaNext brokers a freelance relationship, the platform charges a fee on the escrow amount.

- **Port fit**: `EscrowPort` release supports `platform_fee_minor` and a `platform_fee_destination` account. Maps to Stripe Connect `application_fee_amount` or OnvoPay equivalent.
- **In scope** of this change: document the fee model and the metadata fields.

## What this change produces

Two artifacts:

1. `docs/content/docs/integrations/consumers/aduanext.md` — a consumer-integration page mirroring the five flows above, with example gRPC calls and metadata shape.
2. Follow-up OpenSpec change **stubs** (proposal-only) for:
   - `customs-duty-payment-port` — deferred, re-evaluates if SINPE/BCCR API becomes reachable.
   - `customs-bond-port` — deferred, re-evaluates if a bond-issuer API appears.

## Alternatives rejected

- **AduaNext-specific service in `payments-core`** — rejected. The ports cover AduaNext's needs; a dedicated service would violate the sidecar pattern.
- **`customs-core`** — we considered a dedicated `-core` for customs-specific money flows. Applying the ecosystem rubric yields at most 2 / 5 (single consumer, no other candidate in the pipeline). Rejected per §9.
- **Wait for AduaNext v2 to decide** — rejected because AduaNext v1 already has the broker escrow flow as a product requirement; we need to pin its shape in `payments-core` before the Stripe adapter ships.

## Acceptance

1. `docs/content/docs/integrations/consumers/aduanext.md` renders in MkDocs with all five flows + their status.
2. `EscrowPort` design (in a separate change) explicitly supports `milestone_condition` and `platform_fee_*` metadata fields.
3. Two deferred-stub changes (`customs-duty-payment-port/`, `customs-bond-port/`) exist with `proposal.md` only, stating the re-evaluation trigger.
4. No runtime code in this change.
