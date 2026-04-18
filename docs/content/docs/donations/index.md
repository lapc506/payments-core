# Donations & Crowdfunding

`payments-core` treats donations as a first-class flow, distinct from
commerce payments. Donations have their own state machine (pledge, capture,
refund-to-donor), their own receipting requirements, and their own fee
model.

## What lands here

- **Donation state machine** — pledge → captured → settled, with cancel/refund
  branches. (landing with `donations-domain-v1`)
- **Provider fit** — which adapters support one-time donations, recurring
  donations, and tip flows. (landing with `donations-provider-matrix`)
- **Crowdfunding analysis** — comparison of Vaki / Kickstarter / Indiegogo
  mechanics against what `payments-core` exposes, and which gaps we plug
  in-house vs. via partnership. (landing with `donations-crowdfunding`)

Until those pages exist, donation flows are covered inline in each adapter
proposal under `openspec/changes/`.
