# Tasks — DonationPort

> **Landed in PR** (GitHub Issue #27, branch `feat/issue-27-donations-port`).
> Scope delivered: port interface, three wrapper use cases, main.ts stub
> wiring, unit tests. Adapter wrappers (`StripeDonationAdapter`,
> `OnvoPayDonationAdapter`), the Postgres repository, event emission, and the
> docs page land in follow-ups to keep the PR under the 15-file budget.

## Linear

- Title: `payments-core: DonationPort (one-time + recurring, campaign_id metadata hook)`
- Labels: `domain`, `port`, `altrupets`.
- Base branch: `main`. Branch: `feat/PCR-{issue-id}-donations-port`.
- Blocked by: `domain-skeleton`, `application-use-cases`, `stripe-adapter-p0`, `onvopay-adapter-p0`.
- Related: `crowdfunding-deferred` (this port is what makes that deferral viable).

## Implementation checklist

### Port expansion

- [x] `DonationPort` interface added to `src/domain/ports/index.ts` (kept in the single ports file to honor the 15-file budget tracked on the ports module).
- [x] `DonorVisibility`, `DonationRecurrence`, `DonationRef`, `InitiateOneTimeDonationInput`, `InitiateRecurringDonationInput`, `InitiateDonationResult` types declared alongside the port.
- [x] Signatures: `initiateOneTime`, `initiateRecurring`, `pauseRecurring(gatewayRef, idempotencyKey)`, `cancelRecurring(gatewayRef, idempotencyKey)`. `DonorRef` is deferred until the adapter change lands — the port takes a flat `donorReference: string` today, matching how the existing `Donation` entity already models a donor.

### Use cases

- [x] `CreateOneTimeDonation` — validates `Money > 0`, idempotency-checks, calls `DonationPort.initiateOneTime`, persists a one-time `Donation`, returns a `DonationRef`.
- [x] `CreateRecurringDonation` — same shape + `recurrence` spec; kind `recurring`.
- [x] `ManageRecurringDonation` — discriminated-union input (`pause` | `cancel`) addressed by `gatewayRef`. Idempotent by key.
- [ ] `ListDonationsForCampaign` — deferred with the Postgres repository change.

### Adapters

- [ ] `StripeDonationAdapter` — deferred to a follow-up change (keeps this PR ≤ 8 files; DonationPort consumers currently fall through to `stubDonationPortFor` which raises `GatewayUnavailableError`).
- [ ] `OnvoPayDonationAdapter` — deferred, same rationale.
- [ ] Both adapters will attach `campaign_id` (when present), `donor_visibility`, and `recurrence.*` to the gateway's metadata map. The use cases already enrich the metadata on the domain side so the adapter change only needs to pass it through.
- [ ] Anonymous donor handling: `receipt_email` suppression in Stripe when `donorVisibility !== 'public'` — deferred with the adapter.

### Event emission

- [ ] `DonationReceived` emitted on successful one-time donation.
- [ ] `RecurringDonationActivated` emitted on successful first charge of a recurring donation.
- [ ] Both events serialize to the matching proto messages verified by a translator test.

### Repository

- [ ] `DonationRepositoryPort` interface declared with `listForCampaign` + `listForDonor`.
- [ ] In-memory impl added to `src/application/in-memory/in-memory-donation-repository.ts` for tests.
- [ ] Postgres impl + migration SQL file is NOT in this change (deferred to a follow-up infra change); but the SQL in `design.md` is authoritative for that future migration.

### Tests

- [x] Unit: each use case with a fake `DonationPort` implementation + in-memory repo. Happy path, idempotency replay, zero/negative amount rejection, gateway-error surfacing, and campaign_id present/absent branches are all covered.
- [ ] Unit: Stripe adapter one-time donation + recurring donation flow, mocking the SDK — deferred with the adapter change.
- [ ] Unit: OnvoPay adapter one-time + recurring; webhook dispatch to `DonationReceived` event — deferred with the adapter change.
- [ ] Unit: `listForCampaign` pagination + empty-result case — deferred with the repository change.
- [ ] Integration (gated by `STRIPE_SECRET_KEY` + `ONVOPAY_API_KEY`): a live one-time donation on each gateway — deferred.
- [ ] PII guard: email-hash column is SHA-256 of `email.toLowerCase().trim()` — deferred with the Postgres schema.

### Docs

- [ ] `docs/content/docs/donations/index.md` expanded to include:
  - one-time vs recurring decision flow,
  - the `campaign_id` pattern,
  - donor visibility semantics,
  - cross-reference to `crowdfunding-deferred` and to `invoice-core`'s receipt subscription.
- [ ] Nav entry (already present from `mkdocs-site`) verified to render.

### Verification

- [ ] `pnpm lint && pnpm tsc --noEmit && pnpm test && pnpm build` green.
- [ ] Integration tests (when keys available) pass.
- [ ] Manual: a donation with `campaignId: "altrupets-2026-adoption-drive"` round-trips through `InitiateDonation` → `listDonationsForCampaign` in under 50ms against in-memory repo.

## Pitfalls to avoid

- Do not validate `campaign_id` content. It is opaque to payments-core. Max length is the only constraint.
- Do not surface the donor's plaintext email in any log line. Log the hash or the first 3 chars + `***`.
- Do not auto-send receipt emails from `payments-core`. `invoice-core` owns that via event subscription.
- Do not store the gateway's customer object raw — only store `gateway_ref` + minimal metadata.
- Do not assume every gateway supports recurring donations. Tilopay and dLocal support is added later; in v1, a recurring setup on an unsupported gateway throws `GATEWAY_UNSUPPORTED_FEATURE`.
- Do not design a campaign entity here. That is explicitly the consumer's concern per `crowdfunding-deferred`.
- Do not attach PII-heavy fields to the `DonationReceived` event metadata map (donor_id hashes are OK; names and emails are already separate fields).

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] `altrupets-api` can switch to `payments-core` for donation flows (tracked in that repo's own PR).
- [ ] A follow-up infra change lands the `donations` Postgres table from `design.md` §`campaign_id` indexing.
- [ ] The `invoice-core` side adds a subscription to `DonationReceived` for fiscal receipts (tracked in that repo).
