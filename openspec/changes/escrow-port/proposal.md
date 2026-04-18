# Proposal — EscrowPort (detailed specification)

## Context

`EscrowPort` was sketched in `domain-skeleton` as one of the nine ports. The `aduanext-integration-needs` change defined the concrete requirements for it — specifically the `milestone_condition` metadata pattern used by AduaNext Flow A (broker escrow) and the `platform_fee_minor` / `platform_fee_destination` fields used by AduaNext Flow F. This change promotes the port from "declared interface" to "detailed specification with field-level docs, adapter requirements, and a reference implementation".

Other consumers benefit:

- `altrupets-api` — not today, but potential future use for campaign funds held until a matched-contribution condition is met.
- `habitanexus-api` — HOA improvement funds held until work is approved.
- `marketplace-core-events` — marketplace flows where payment is held until delivery confirmation.

## Why this change

Escrow is the single most detailed port because it involves:

- Multi-party fund flows (payer, payee, platform fee destination, optional arbiter).
- Conditional releases based on external-event milestones.
- Platform-fee primitives that map to Stripe Connect's `application_fee_amount` but that every gateway models differently.
- Dispute flows with possible partial refund.

Shipping this as a separate change (rather than folding it into each adapter) forces the port shape to stay adapter-neutral and gives every future adapter a single specification to implement against.

## Scope

### Port detailed specification

Expanded interface in `src/domain/ports/escrow-port.ts`:

```ts
export interface EscrowPort {
  readonly gateway: GatewayName;

  hold(input: HoldEscrowInput): Promise<HoldEscrowResult>;
  release(input: ReleaseEscrowInput): Promise<ReleaseEscrowResult>;
  refund(input: RefundEscrowInput): Promise<RefundEscrowResult>;
  dispute(input: DisputeEscrowInput): Promise<DisputeEscrowResult>;
}

export interface HoldEscrowInput {
  readonly amount: Money;
  readonly payer: EscrowParty;
  readonly payee: EscrowParty;
  readonly consumer: string;
  readonly idempotencyKey: IdempotencyKey;

  readonly milestoneCondition?: MilestoneCondition;
  readonly platformFeeMinor?: bigint;
  readonly platformFeeDestination?: string;

  readonly metadata: Readonly<Record<string, string>>;
}

export interface MilestoneCondition {
  readonly milestones: readonly string[];     // opaque strings, consumer-defined
  readonly releaseSplit: readonly number[];   // percentages; sum === 100
}

export interface ReleaseEscrowInput {
  readonly escrowId: string;
  readonly milestone?: string;                // matches a MilestoneCondition.milestones entry
  readonly idempotencyKey: IdempotencyKey;
}
```

### `milestone_condition` semantics (from aduanext-integration-needs)

- `milestones` is an ordered list of opaque strings. AduaNext uses `["dua_signed", "levante_received"]`; other consumers define their own.
- `releaseSplit` is an array of percentages matching `milestones.length`. Elements sum to 100.
- Calling `release` with a `milestone` that matches `milestones[i]` releases the funds represented by `releaseSplit[i]`.
- Milestones must be released in order; calling `release` with `milestones[2]` before `milestones[1]` is an error (`INVALID_STATE`).
- Calling `release` with no `milestone` releases the remaining balance (useful when the condition is satisfied externally in one step).

### `platform_fee_*` semantics (from aduanext-integration-needs)

- `platformFeeMinor` is the fee amount in the same currency as `amount`.
- `platformFeeDestination` is a gateway-native account identifier (Stripe Connect `acct_*`, OnvoPay account id, etc.).
- Fee is deducted from each release proportionally to the release split (unless a gateway requires all-fee-on-first-release, in which case the adapter documents this).
- Currency mismatch between fee and escrow amount is rejected at the port level (`CURRENCY_MISMATCH`).

### Adapter support matrix in v1

| Gateway | `hold` | `release` (full) | `release` (milestone split) | `platform_fee_*` | `dispute` |
|---|:---:|:---:|:---:|:---:|:---:|
| Stripe | yes (manual capture + delayed transfer via Connect) | yes | yes | yes | yes (Stripe disputes) |
| OnvoPay | TODO: verify | TODO | limited — may require adapter-side bookkeeping | TODO | TODO |
| Tilopay (P1) | TODO | TODO | probably no (adapter-side bookkeeping) | TODO | TODO |
| dLocal (P2) | deferred | deferred | deferred | deferred | deferred |
| Revolut | likely yes via held-balance accounts | yes | yes | limited | limited |
| Convera | limited | yes | no | no | limited |
| Ripple-XRPL | on-chain via escrow primitive (XRPL native) | yes | no (no native split) | no | n/a (no disputes on-chain) |
| Apple/Google Pay verify | n/a | n/a | n/a | n/a | n/a |

Gateways that cannot split releases natively implement split releases via **adapter-side bookkeeping**: the adapter holds the full sum in the gateway, and the port exposes a consistent milestone-split API by tracking the split in `payments-core`'s own escrow record. The adapter then emits a sequence of internal transfers per release, each an idempotent gateway call.

### Domain entity updates

The `Escrow` entity in `domain-skeleton` is updated to carry:

- `milestoneCondition?: MilestoneCondition`
- `releasedMilestones: string[]`
- `platformFee?: { amount: Money; destination: string }`
- `releasedAmount: Money` (running total)

State machine is unchanged; transitions gain validation that `releasedAmount ≤ amount` and that milestones release in order.

## Out of scope

- **Arbiter / third-party mediator flows** — a neutral mediator approving releases is a future extension. For v1, either party initiates release via `aduanext-api` (and gates it on their own business logic), or disputes go through the gateway's native dispute flow.
- **Multi-currency escrow** — escrow holds a single currency. Cross-currency holding requires FX mechanics that belong one layer higher.
- **Partial custody** — fractional release by amount rather than by milestone. Can be added if a consumer needs it; v1 uses the percentage-based split.
- **Gateway-agnostic dispute UI** — disputes are gateway-specific; the port exposes a unified interface but the consumer reviews each gateway's dashboard.

## Alternatives rejected

- **Leave milestone logic to the consumer** — rejected. Every consumer would reinvent the pattern, and the port's value is exactly in standardizing it.
- **Use a separate `MarketplaceEscrowPort` for multi-party flows** — rejected. Single port, optional multi-party fields. Don't pay for the abstraction until more than one consumer has truly divergent needs.
- **Store escrow state entirely in the gateway** — rejected. Gateways differ in milestone support; adapter-side bookkeeping is necessary for consistent behavior.

## Acceptance

1. `src/domain/ports/escrow-port.ts` expanded per this proposal with full types + JSDoc.
2. `Escrow` entity updated to carry milestone tracking + platform fee fields.
3. Stripe adapter (`stripe-adapter-p0`'s follow-up or a dedicated `stripe-escrow-adapter.ts` in this change) implements the full matrix.
4. OnvoPay adapter implements whatever subset it supports, with gaps documented.
5. The adapter-side bookkeeping pattern is tested against a mock gateway (`FakeEscrowGateway` in `application/in-memory/`).
6. `docs/content/docs/ports/escrow.md` contains the adapter support matrix and the adapter-side-bookkeeping rationale, cross-referenced from `docs/content/docs/integrations/consumers/aduanext.md`.
7. AduaNext Flow A gRPC integration test (from `aduanext-api`) exercises the milestone-split release end-to-end against Stripe Connect.
