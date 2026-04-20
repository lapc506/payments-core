# EscrowPort

`EscrowPort` models funds held by a third-party gateway until a release
condition is met. It was sketched in `domain-skeleton` (PR #22) and wired
into use cases in `application-use-cases` (PR #23). This page is the
reader-facing contract.

!!! note "Status: interface landed, no runtime adapter yet"
    The port interface, the `Escrow` entity, and the `HoldEscrow` /
    `ReleaseEscrow` / `DisputeEscrow` use cases are in-tree. **No runtime
    adapter implements `EscrowPort` today.** Stripe Connect and OnvoPay
    escrow adapters are tracked as P1 follow-ups in
    [`stripe-adapter-p0`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/stripe-adapter-p0)
    and
    [`onvopay-adapter-p0`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/onvopay-adapter-p0).
    Stubs throw `UNAVAILABLE` until their respective changes land.

## What the port does

Three operations:

```ts
interface EscrowPort {
  hold(input: HoldEscrowInput): Promise<HoldEscrowResult>;
  release(input: ReleaseEscrowInput): Promise<ReleaseEscrowResult>;
  dispute(input: DisputeEscrowInput): Promise<DisputeEscrowResult>;
}
```

| Method    | Responsibility                                                        | State transition          |
|-----------|------------------------------------------------------------------------|---------------------------|
| `hold`    | Accept payer funds, hold them in gateway custody.                     | `∅ → held`                |
| `release` | Release one tranche (by milestone) or a partial amount to the payee.  | `held → held \| released` |
| `dispute` | Open a dispute against the escrow; evidence via `DisputePort`.        | `held → disputed`         |

Refunds from a disputed escrow use the standard `PaymentGatewayPort.refund`
or dispute-resolution webhook path; the entity transitions
`disputed → refunded` when the resolution lands.

## State machine

```
held ──► released
     ├─► refunded
     └─► disputed ──► released   (payee wins)
                  └─► refunded   (payer wins)
```

Enforced by `transitionEscrow` in `src/domain/entities/escrow.ts`. Key
invariants:

- `held` is the only legal initial status (built by `createEscrow`).
- `released` and `refunded` are terminal.
- From `disputed` only `released` or `refunded` are legal; anything else
  raises `DisputeOngoingError` so the failure mode is operationally distinct
  from generic illegal transitions.
- Partial releases do **not** advance status. The entity stays `held`; the
  gateway reports `status: 'held'` per tranche. Only the final tranche (or a
  full-balance release) advances to `released`.

## Milestone contract

```ts
interface MilestoneCondition {
  readonly milestones: readonly string[];     // opaque consumer-defined
  readonly releaseSplit: readonly number[];   // percentages; sum === 100
}
```

- **Opaque strings.** The domain does not interpret milestone strings.
  AduaNext publishes its own taxonomy (`"dua_signed"`,
  `"levante_received"`, `"cancelled"`); other consumers define their own.
- **Percentage split.** `releaseSplit[i]` is a whole-number percentage.
  Elements sum to `100` and `releaseSplit.length === milestones.length`.
- **Order.** Milestones release in order. Calling `release` with
  `milestones[2]` before `milestones[1]` is an `INVALID_STATE` error surfaced
  by the adapter. The domain is stateless across calls — ordering is enforced
  by the adapter's bookkeeping layer.
- **Full-balance release.** Calling `release` with no `milestone` and no
  `amount` releases the entire remaining balance in one call.
- **By-amount release.** Calling `release` with an explicit `amount` and no
  `milestone` works for gateways that model custody by amount rather than by
  milestone (XRPL). `milestone` and `amount` are mutually exclusive per
  call.

## Platform fee contract

```ts
interface HoldEscrowInput {
  // ...
  readonly platformFeeMinor?: bigint;         // same currency as `amount`
  readonly platformFeeDestination?: string;   // gateway-native account id
}
```

- `platformFeeMinor` is in the same currency as `amount`. Cross-currency is
  rejected at the port contract level (`CURRENCY_MISMATCH`).
- `platformFeeDestination` is gateway-native — Stripe Connect `acct_*`,
  OnvoPay account id. The domain stores it as an opaque string.
- **Default allocation**: fee deducted proportionally to the release split.
  Stripe Connect accounts requiring all-fee-on-first-release override this
  policy; the adapter documents the override in its own proposal.
- **Rounding residue**: absorbed by the final tranche so deducted fees sum
  exactly to `platformFeeMinor`.

## Consumer reference — AduaNext

AduaNext's Flow A (broker escrow) and Flow F (platform fees) are the
reference consumer. See
[integrations/consumers/aduanext.md](../integrations/consumers/aduanext.md)
for the full walkthrough. Short version:

```text
HoldEscrow {
  amount: { amount_minor: 150000, currency: "CRC" }
  milestone_condition: {
    milestones: ["dua_signed", "levante_received"]
    release_split: [50, 50]
  }
  platform_fee_minor: 15000
  platform_fee_destination: "aduanext-platform-account"
}
```

## Adapter support matrix (target for v1)

| Gateway       | `hold` | `release` full | `release` split  | `platform_fee_*` | `dispute` |
|---------------|:------:|:--------------:|:----------------:|:----------------:|:---------:|
| Stripe        |  yes   |      yes       |       yes        |       yes        |    yes    |
| OnvoPay       |  TBD   |      TBD       |  limited (bookkeeping) |    TBD     |    TBD    |
| Tilopay (P1)  |  TBD   |      TBD       |  bookkeeping     |       TBD        |    TBD    |
| dLocal (P2)   |  def.  |      def.      |      def.        |       def.       |   def.    |
| Revolut       | likely |      yes       |       yes        |     limited      |  limited  |
| Convera       |limited |      yes       |        no        |        no        |  limited  |
| Ripple-XRPL   |  yes   |      yes       |        no        |        no        |    n/a    |

*`def.` = deferred. Gateways that cannot split releases natively implement
splits via **adapter-side bookkeeping**: the adapter holds the full sum in
the gateway and emits a sequence of idempotent internal transfers per
release, each tracked in `payments-core`'s own ledger.*

## Disputes

`EscrowPort.dispute` opens a dispute against the gateway and returns a
`disputeId`. Evidence submission goes through
[`DisputePort.submitEvidence`](index.md) — the split exists because
card-issuer chargebacks and escrow disputes share the evidence flow but
differ in how the dispute is opened.

## Known limitations

- **No adapter implements `EscrowPort` today.** Registry resolution to an
  escrow gateway throws `UNAVAILABLE` until the Stripe Connect escrow
  adapter and the OnvoPay escrow adapter land.
- **No arbiter / third-party mediator flows.** Either party initiates
  release via the consumer backend, or disputes go through the gateway's
  native dispute flow. See
  [`proposal.md`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port/proposal.md)
  § Out of scope.
- **Single-currency escrow.** Escrow holds one currency. Cross-currency
  holding is handled one layer higher (FX port).
- **No fractional release by arbitrary amount with milestones.** Partial
  releases are either percentage-based (via `milestoneCondition`) or
  amount-based (raw `amount` on `release`). They do not compose.

## Related

- [`openspec/changes/escrow-port/proposal.md`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port/proposal.md)
  — original proposal.
- [`openspec/changes/escrow-port/design.md`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/escrow-port/design.md)
  — normative design (this page is the reader view of that doc).
- [AduaNext consumer page](../integrations/consumers/aduanext.md)
  — Flow A + Flow F reference consumer.
- [Stripe adapter (P0)](../adapters/stripe.md) — will host the Stripe Connect
  escrow implementation in a P1 follow-up change.
- [OnvoPay adapter (P0)](../adapters/onvopay.md) — will host the OnvoPay
  escrow implementation in a P1 follow-up change.
