# Tasks — Crowdfunding deferred

## Linear

- Title: `payments-core: document crowdfunding deferral (Vaki/Coopeservidores analysis)`
- Labels: `documentation`, `research`.
- Base branch: `main`. Branch: `docs/PCR-{issue-id}-crowdfunding-deferred`.
- Blocks: none.
- Related to: `donations-port` (the implementation change that actually ships `DonationPort`).

## Implementation checklist

- [ ] `docs/content/docs/donations/crowdfunding.md` created, content per `design.md` outline.
- [ ] Page nav entry added under `Donations & Crowdfunding` in `docs/mkdocs.yml`.
- [ ] `openspec/specs/crowdfunding-deferred.md` — short archive entry pointing back to this change directory.
- [ ] All source URLs verified reachable on the day of PR (mark any that have moved with a note).
- [ ] The re-evaluation trigger is stated verbatim in both `proposal.md` and `crowdfunding.md` so it cannot drift.
- [ ] No runtime code added.

## Verification

- [ ] `mkdocs build --strict` still passes.
- [ ] The page renders, the sources list links out correctly.
- [ ] Spot-check: a reader who lands on `/docs/donations/crowdfunding/` understands in under three minutes **why** the repository does not ship a `CrowdfundingPort` and **what** would change that.

## PR

- [ ] Title: `docs(donations): deferral note with Vaki/Coopeservidores analysis`.
- [ ] Body links `proposal.md` + `design.md`.
- [ ] `@greptile review`. Findings addressed.

## Pitfalls to avoid

- Do not write this page as advocacy against any party. Neutral, factual framing.
- Do not include screenshots of news articles (copyright risk). Link out only.
- Do not declare when the deferral ends. The trigger is the trigger.
- Do not couple this change to any `DonationPort` implementation. That is a separate change and separate PR.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] If Stage 2 of the program (the actual `DonationPort` implementation change) has not started, add a placeholder `openspec/changes/donations-port/` directory in a follow-up so the open task is visible.
