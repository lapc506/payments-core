# Design — DonationPort

## File layout (additions)

```
src/domain/ports/
└── donation-port.ts                       (expanded from the domain-skeleton stub)

src/application/use-cases/
├── initiate-donation.ts
├── setup-recurring-donation.ts
├── cancel-recurring-donation.ts
└── list-donations-for-campaign.ts

src/adapters/outbound/stripe/
└── stripe-donation-adapter.ts             implements DonationPort

src/adapters/outbound/onvopay/
└── onvopay-donation-adapter.ts            implements DonationPort

src/application/ports/repositories/
└── donation-repository-port.ts            (expanded from domain-skeleton sketch, indexes campaign_id)
```

## Port expansion

```ts
export interface DonationPort {
  readonly gateway: GatewayName;

  initiateDonation(input: InitiateDonationInput): Promise<InitiateDonationResult>;
  setupRecurringDonation(input: SetupRecurringDonationInput): Promise<SetupRecurringDonationResult>;
  cancelRecurringDonation(subscriptionId: string, idempotencyKey: IdempotencyKey): Promise<void>;
}

export interface InitiateDonationInput {
  readonly amount: Money;
  readonly donor: DonorRef;
  readonly campaignId?: string;
  readonly donorVisibility: DonorVisibility;
  readonly gatewayPreference: GatewayPreference;
  readonly consumer: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
}

export interface InitiateDonationResult {
  readonly donationId: string;
  readonly gatewayRef: GatewayRef;
  readonly requiresAction: boolean;
  readonly challenge?: ThreeDSChallenge;
  readonly checkoutUrl?: string;
}

export type DonorVisibility = 'anonymous' | 'public' | 'pseudonymous';

export interface DonorRef {
  readonly email: string;
  readonly displayName?: string;
  readonly language?: 'es' | 'en';
  readonly optInNewsletter: boolean;
}
```

The adapter concrete types (Stripe, OnvoPay) parallel the generic `PaymentGatewayPort` shape but attach donation-specific metadata keys (`campaign_id`, `donor_visibility`, `recurrence.interval`) into the gateway's metadata map.

## `campaign_id` indexing

`DonationRepositoryPort`:

```ts
export interface DonationRepositoryPort {
  save(donation: Donation): Promise<void>;
  findById(id: string): Promise<Donation | null>;
  listForCampaign(campaignId: string, cursor: PageCursor): Promise<PagedResult<Donation>>;
  listForDonor(donorEmailHash: string, cursor: PageCursor): Promise<PagedResult<Donation>>;
}
```

Postgres schema (added in a follow-up infra change, not this one — we declare the port shape now):

```sql
CREATE TABLE donations (
  id UUID PRIMARY KEY,
  consumer TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  campaign_id TEXT,
  donor_email_hash BYTEA NOT NULL,
  donor_visibility TEXT NOT NULL CHECK (donor_visibility IN ('anonymous','public','pseudonymous')),
  recurrence_interval TEXT,
  recurrence_count INT,
  status TEXT NOT NULL,
  gateway TEXT NOT NULL,
  gateway_ref TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX donations_campaign_id_idx ON donations(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX donations_consumer_idx ON donations(consumer);
CREATE INDEX donations_donor_email_hash_idx ON donations(donor_email_hash);
```

`donor_email_hash` (SHA-256 of lowercase email) is stored instead of the raw email to let us support "list donations for a donor" without storing PII in the clear. The plaintext email lives only in the emitted event (where invoice-core needs it for receipts) and in the gateway's customer record.

## Event emission

```ts
// src/domain/events/donation-events.ts — expanded

export class DonationReceived implements DomainEvent {
  readonly type = 'donation.received';
  constructor(
    readonly donationId: string,
    readonly consumer: string,
    readonly amount: Money,
    readonly donorEmail: string,
    readonly donorDisplayName: string | undefined,
    readonly donorVisibility: DonorVisibility,
    readonly campaignId: string | undefined,
    readonly occurredAt: Date,
    readonly metadata: Readonly<Record<string, string>>,
  ) {}
}

export class RecurringDonationActivated implements DomainEvent {
  readonly type = 'donation.recurring.activated';
  constructor(
    readonly subscriptionId: string,
    readonly consumer: string,
    readonly amount: Money,
    readonly interval: 'month' | 'year' | 'custom',
    readonly campaignId: string | undefined,
    readonly occurredAt: Date,
  ) {}
}
```

These map 1:1 to the proto event messages `DonationReceivedEvent` and `RecurringDonationActivatedEvent` declared in `proto-contract-v1`.

## Gateway-specific notes

### Stripe donation adapter

- Uses `paymentIntents.create` for one-time with `metadata.campaign_id` attached.
- Uses `subscriptions.create` with a `price` of type `recurring` for recurring donations.
- For anonymous donations, sets `receipt_email` only if `donorVisibility === 'public'` (so Stripe's auto-receipt does not leak to anonymous donors).
- Reuses the Stripe client factory pinned at SDK 18.5.0; no separate factory.

### OnvoPay donation adapter

- Uses the standard charge endpoint for one-time.
- Uses OnvoPay's `cargos-recurrentes` flow for recurring (TODO: verify field mapping against docs.onvopay.com).
- Stores `campaign_id` in the OnvoPay `metadata` map, respecting OnvoPay's metadata size limits.

## Cross-references

- `crowdfunding-deferred` — the deferral rationale. This change is what makes that deferral viable.
- `stripe-adapter-p0` — hosts `StripeDonationAdapter`.
- `onvopay-adapter-p0` — hosts `OnvoPayDonationAdapter`.
- `invoice-core` (sibling repo) — subscribes to `DonationReceived` events and issues fiscal receipts. Coordination tracked in an `invoice-core` OpenSpec change (not in this repo).
- `proto-contract-v1` — `DonationReceivedEvent` and `RecurringDonationActivatedEvent` are already declared there.

## Risks

- **Campaign-id explosion** — a malicious consumer could spam `campaign_id` values with unbounded cardinality. Mitigation: the index is `WHERE campaign_id IS NOT NULL` (sparse); we also declare a soft limit of 256 chars in the port input validator. True campaign-registry enforcement is not in `payments-core`'s scope.
- **PII in events** — `DonationReceived` carries `donorEmail` in the clear. Consumers of the event bus must handle PII accordingly. Mitigation: document in `DonationPort` JSDoc and in `docs/content/docs/security/index.md`.
- **Recurring cancellation idempotency** — cancelling an already-cancelled subscription must be safe. Mitigation: `cancelRecurringDonation` is idempotent by `idempotencyKey`; repeat calls no-op.
- **Donor de-duplication** — multiple donors with the same email hash are one donor for query purposes but may have different display names per donation. Mitigation: `donorDisplayName` is per-donation, not per-donor.

## Rollback

Revert. Altrupets cannot accept donations via `payments-core` until re-landed; their fallback is their current direct-to-Stripe integration (which this change replaces). No data loss, because the port is additive to the existing gateway surface.
