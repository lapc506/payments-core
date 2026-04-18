# Proposal — DonationPort

## Context

The `crowdfunding-deferred` change established that `payments-core` should ship a **`DonationPort`** today — covering one-time and recurring donations — while deferring the full crowdfunding primitive (campaigns, progress bars, multi-donor aggregation) until the re-evaluation trigger fires. This change is the implementation of that port.

The primary driver is `altrupets-api` (AltruPets Foundation), which needs to accept donations from both CR and international donors, issue fiscally deductible receipts via `invoice-core`, and — crucially — attach a **`campaign_id` metadata hook** so the consumer backend can model campaign concepts in its own UI without `payments-core` needing to know what a campaign is.

## Why now

Altrupets is ready to ship its donation flow. Stripe (P0) and OnvoPay (P0) are the two gateways it needs: Stripe for international donors, OnvoPay for CR donors. Without `DonationPort`, Altrupets would have to call the generic `PaymentGatewayPort` and layer the donation-specific concerns (recurrence, donor visibility, campaign tag) in its own code. That leaks donation semantics into the application layer of every donation-accepting consumer.

A dedicated port keeps those semantics in `payments-core` where the persistence model (the `Donation` entity from `domain-skeleton`) is already shaped for them.

## Scope

### The port (declared in `domain-skeleton`, expanded here)

```ts
export interface DonationPort {
  initiateDonation(input: InitiateDonationInput): Promise<InitiateDonationResult>;
  setupRecurringDonation(input: SetupRecurringDonationInput): Promise<SetupRecurringDonationResult>;
  cancelRecurringDonation(input: CancelRecurringDonationInput): Promise<void>;
  listDonationsForCampaign(campaignId: string, page: PageCursor): Promise<DonationListResult>;
}
```

### Input shapes

```ts
export interface InitiateDonationInput {
  readonly amount: Money;
  readonly donor: DonorRef;                    // email + display name + opt-in flags
  readonly campaignId?: string;                // opaque to payments-core
  readonly donorVisibility: 'anonymous' | 'public' | 'pseudonymous';
  readonly recurrence?: DonationRecurrence;    // present → triggers setupRecurring path
  readonly gatewayPreference: GatewayPreference;
  readonly consumer: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
}

export type DonationRecurrence =
  | { interval: 'month'; count: 1 }
  | { interval: 'year'; count: 1 }
  | { interval: 'custom'; daysBetween: number };
```

### The `campaign_id` metadata hook

`campaignId` is the **only** field in the port that acknowledges crowdfunding semantics, and it does so **opaquely**:

- `payments-core` stores it on the `Donation` entity, indexes it (so `listDonationsForCampaign` is fast), and emits it on `DonationReceived` events.
- `payments-core` **never** validates the id, checks ownership, or attaches any campaign state.
- The consumer backend (altrupets-api today, others later) owns the campaign concept: target amounts, progress bars, donor walls, close dates, campaign UIs. It uses `listDonationsForCampaign` to aggregate and `DonationReceived` event subscriptions to react.

This pattern is the direct technical answer to `crowdfunding-deferred`'s re-evaluation question: as long as consumers can model campaigns as repeated `Donation`s keyed by `campaign_id`, no `CrowdfundingPort` is needed. If a future consumer requires cross-donor aggregation logic that cannot be expressed as a `listDonationsForCampaign` query, `crowdfunding-deferred` re-opens.

### Gateway coverage in v1

`DonationPort` has implementations backed by:

- Stripe adapter (via `stripe-adapter-p0`) — one-time + recurring for international donors.
- OnvoPay adapter (via `onvopay-adapter-p0`) — one-time + recurring for CR donors.

Tilopay (P1) and dLocal (P2) will get donation paths as their adapters land. Ripple-XRPL is explicitly not a donation rail in v1 (open question in `crowdfunding-deferred`).

## Explicitly out of scope

- **Campaign entity, campaign state machine, campaign UIs** — these live in consumer backends.
- **Fiscal receipt generation** — lives in `invoice-core`. `DonationPort` emits `DonationReceived`; `invoice-core` subscribes and issues the receipt.
- **Donor KYC for high-value donations** — lives in `compliance-core`. `payments-core` may be called with a `compliance_check_id` in metadata but does not validate it.
- **Crypto donations** — deferred. Ripple-XRPL adapter exists for on-chain payments but donation semantics on that rail are unclear today.
- **Apple Pay / Google Pay for donation checkout** — handled by the frontend's donor-facing widget; server-side token verification lives in `apple-google-pay-verify-p2`.

## Alternatives rejected

- **No DonationPort — consumers call `PaymentGatewayPort` directly with donation metadata** — rejected. Donation recurrence + donor visibility + campaign id are shared across every donation-accepting consumer; codifying them once in a port is cheaper than repeating the shape five times.
- **Ship a full `CampaignPort` now** — rejected per `crowdfunding-deferred`. One consumer, speculative second consumer, no regulated LATAM rail.
- **Merge donations into the generic `PaymentIntent` entity** — rejected. A `Donation` has fields (`campaign_id`, `donor_visibility`, `recurrence`) that do not apply to purchases. Separate entity, separate port.
- **Use Stripe Invoicing as the donation rail** — rejected. Couples donations to `invoice-core`. Stripe's `payment_intents` + `subscriptions` give us the same acceptance rates without the coupling.

## Acceptance

1. `DonationPort` expanded in `src/domain/ports/donation-port.ts` per this proposal.
2. Implementations exist in `stripe-adapter-p0` and `onvopay-adapter-p0`: `StripeDonationAdapter` and `OnvoPayDonationAdapter`, each delegating to the gateway's existing charge + recurring-billing surfaces while persisting as `Donation` entities.
3. Application use case `InitiateDonation` (new, in `application-use-cases` follow-up or added here) handles both one-time and recurring paths.
4. `listDonationsForCampaign` is covered by a repository impl that indexes `campaign_id` and returns paginated results.
5. `DonationReceived` and `RecurringDonationActivated` events are emitted as declared in `proto-contract-v1`.
6. `altrupets-api` integration smoke test (in that repo) can accept a one-time donation, a recurring donation, and list both for a given `campaign_id`.
7. Documentation page `docs/content/docs/donations/index.md` expands to include the `campaign_id` pattern and cross-references `crowdfunding-deferred`.
