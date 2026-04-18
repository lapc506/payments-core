# crowdfunding-deferred (archive entry)

**Status:** deferred
**Archived on:** 2026-04-18
**Change directory:** [`openspec/changes/crowdfunding-deferred/`](../changes/crowdfunding-deferred/)
**Docs page:** [`docs/content/docs/donations/crowdfunding.md`](../../docs/content/docs/donations/crowdfunding.md)

## Why this entry exists

`payments-core` does not ship a `CrowdfundingPort`. The reasoning — the
Vaki / Coopeservidores collapse, the limits of Kickstarter / Indiegogo
APIs, and why direct donations via existing adapters cover the real
pain — is captured in the change directory above and in the published
docs page.

This archive entry exists so that:

- A reader browsing `openspec/specs/` can see that the decision was made
  deliberately and find the full context in one click.
- When the re-evaluation trigger fires, a new change directory can
  supersede this entry without losing the prior analysis.

## Re-evaluation trigger (verbatim from `proposal.md`)

> This change moves from "deferred" to "active" when **both** of these conditions are met:
>
> 1. **Two or more** consumer backends have a concrete product requirement for a campaign/progress-bar/multi-donor primitive that cannot be modeled as a repeated `Donation` with the same `campaign_id` metadata field.
> 2. A viable regulated LATAM crowdfunding rail **exists and is reachable via API** (post-Vaki replacement, or a direct partnership with a regulated cooperative).

Until both hold, the correct answer is "AltruPets uses `DonationPort`
with `campaign_id` metadata; the campaign UI lives in altrupets-api".

## Related changes

- `donations-port` — the implementation change that actually ships
  `DonationPort`.
- `ripple-xrpl-adapter` — long-horizon blockchain donation option;
  independent timeline.
