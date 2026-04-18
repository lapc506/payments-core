# Proposal — Crowdfunding deferred (with Vaki / Coopeservidores analysis)

## Context

Two of the five committed consumers would benefit from crowdfunding rails:

- `altrupets-api` (AltruPets Foundation) — donation drives for animal adoption, medical campaigns, foster-home fundraising.
- `habitanexus-api` (hypothetically, post-v1) — community-funded improvements in shared-housing contexts.

Until 2024, Costa Rica had a viable local crowdfunding rail: **Vaki.co** (Colombian platform) operated a Costa Rica instance in partnership with **Coopeservidores**, a Costa Rican cooperative. The partnership was the only regulated crowdfunding vehicle for Costa Rican non-profits at scale.

In mid-2024 **Coopeservidores entered bankruptcy** (concurso mercantil under the Costa Rican `Juzgado Concursal`). The fallout included:

- SUGEF (the national banking supervisor) issued public Q&A materials on depositor protections.
- Affected parties continue to pursue transparency claims into 2026.
- The Vaki–Coopeservidores Costa Rica crowdfunding vehicle **collapsed** as a usable rail, leaving Costa Rican non-profits without an integrated, locally-regulated crowdfunding option.

## Why this is a `proposal` and not an `implementation`

Applying the ecosystem rubric to a hypothetical `crowdfunding-core` today yields:

| Criterion | Result |
|---|:---:|
| 1. Cross-startup reuse | ⚠️ (1 clear consumer: AltruPets; 1 speculative: HabitaNexus) |
| 2. Bounded domain | ⚠️ (overlaps with DonationPort and EscrowPort already in `payments-core`) |
| 3. Non-trivial complexity | ✅ (regulatory framing is complex, technical implementation is not) |
| 4. Credential / regulatory isolation | ⚠️ (only if a regulated rail exists; today none does) |
| 5. External integrations | ⚠️ (Kickstarter / Indiegogo APIs are limited; no LATAM replacement) |

That yields `≤ 2.5 / 5`, well below the rubric's `≥ 4` threshold. The rubric explicitly rejects premature abstraction. Implementation is **deferred**.

## What this change DOES do

This change is documentation-only and purposefully frozen. It:

1. Captures the **Vaki / Coopeservidores timeline** as project memory so the next contributor does not re-discover it.
2. Reviews the **currently reachable alternatives** for crowdfunding-like flows and their limitations.
3. Defines the **re-evaluation trigger** that would flip this change from "deferred" to "active".
4. Documents a **DonationPort** scope inside `payments-core` that absorbs the one-time + recurring donation use cases that AltruPets actually needs today (the subset of "crowdfunding" that is really just donations). That port lands in a separate implementation change (`donations-port`).

## Alternatives reviewed

### Kickstarter

- Status API: https://status.kickstarter.com/api — uptime only, not usable for integration.
- No official public API. `kickscraper` (Ruby gem by markolson) documents the shape of the unofficial URL-scraping approach; it is fragile and ToS-adjacent.
- Commercial scraper-as-a-service providers (e.g. scrapingbee) work but introduce an untrusted intermediary between us and donor data — **unacceptable** for a regulated non-profit.

### Indiegogo

- Documented public API: https://help.indiegogo.com/article/616-indiegogo-public-api — exists but is **read-only** and the platform team has signaled limited investment.
- An open-source client (`backerclub/indiegogo-api-client`) exists but covers the read-only surface only.

### Ripple / XRPL donations

- Blockchain-based donation rails via XRPL (see `ripple-xrpl-adapter` change) offer an alternative for international donors.
- Regulatory fit in Costa Rica is ambiguous; a non-profit accepting XRP donations faces FX and accounting treatment questions that are not `payments-core`'s to resolve.
- Kept as a long-horizon option via the existing Ripple adapter work, not a crowdfunding replacement.

### Direct donations via existing adapters

- `payments-core` already plans Stripe, OnvoPay, Tilopay, dLocal, Revolut, Convera adapters.
- For AltruPets Foundation's actual pain — accepting one-time + recurring donations from both CR and international donors, issuing fiscally deductible receipts via `invoice-core` — the existing adapters cover the use case.
- The missing primitive is a **campaign concept** (a donation target, a progress bar, multi-donor aggregation, a public campaign page). That is **not** a payments concern; it is an application-level UX concern that belongs in the consumer backend.

## The re-evaluation trigger

This change moves from "deferred" to "active" when **both** of these conditions are met:

1. **Two or more** consumer backends have a concrete product requirement for a campaign/progress-bar/multi-donor primitive that cannot be modeled as a repeated `Donation` with the same `campaign_id` metadata field.
2. A viable regulated LATAM crowdfunding rail **exists and is reachable via API** (post-Vaki replacement, or a direct partnership with a regulated cooperative).

Until both hold, the correct answer is "AltruPets uses `DonationPort` with `campaign_id` metadata; the campaign UI lives in altrupets-api".

## Out of scope (to be clear)

- No `CrowdfundingPort` is defined.
- No Kickstarter / Indiegogo adapters are built.
- The existing `ripple-xrpl-adapter` change continues on its own timeline; this change does not block nor accelerate it.

## Acceptance

1. `docs/content/docs/donations/crowdfunding.md` exists and contains the Vaki / Coopeservidores timeline, the alternatives review, and the re-evaluation trigger, in a form a third party can read without context.
2. The Sources section of that page lists the URLs the maintainer provided on 2026-04-18, with accurate attribution.
3. `openspec/specs/` gains an archived "deferred" entry pointing at this change directory.
4. No runtime code ships.
