# Tasks — AduaNext integration needs

## Linear

- Title: `payments-core: document AduaNext integration needs + deferral stubs`
- Labels: `documentation`, `integration`.
- Base branch: `main`. Branch: `docs/PCR-{issue-id}-aduanext-integration-needs`.
- Related to: `escrow-port` (must support the `milestone_condition` metadata documented here).

## Implementation checklist

### Primary page

- [ ] `docs/content/docs/integrations/consumers/aduanext.md` created, content per `design.md` outline.
- [ ] All six flows (A–F) documented with explicit status (in scope / deferred).
- [ ] Milestone taxonomy section lists the three AduaNext strings (`dua_signed`, `levante_received`, `cancelled`).
- [ ] AduaNext's "kept inside aduanext-api" section makes scope boundaries unambiguous.

### Deferred-stub changes

- [ ] `openspec/changes/customs-duty-payment-port/proposal.md` — deferred stub, trigger documented.
- [ ] `openspec/changes/customs-bond-port/proposal.md` — deferred stub, trigger documented.
- Neither stub gets a `design.md` or `tasks.md` (deferred changes proposal-only until triggered).

### Nav

- [ ] `docs/mkdocs.yml` nav updated to include the AduaNext consumer page under `Integrations → Consumers`.

### Cross-references

- [ ] The `escrow-port` change (when it lands) references back to this page for the milestone contract.
- [ ] The `ripple-xrpl-adapter`, `revolut-adapter`, and `convera-adapter` changes each add a one-line "Used by AduaNext for Flow E" in their docs.

## Verification

- [ ] `mkdocs build --strict` passes.
- [ ] Page renders, all internal links resolve.
- [ ] A reader familiar with AduaNext (but not `payments-core`) can map each of their flows to a concrete RPC within five minutes.
- [ ] A reader familiar with `payments-core` (but not AduaNext) understands why C and D are deferred.

## PR

- [ ] Title: `docs(integrations): AduaNext consumer page + customs deferral stubs`.
- [ ] Body links proposal, design, and the stub proposals.
- [ ] `@greptile review`.

## Pitfalls to avoid

- Do not add customs-specific RPCs to `payments-core`. The port stays generic; AduaNext uses `milestone_condition` metadata.
- Do not document SINPE or BCCR integration as "coming soon". The trigger is external, not on our roadmap.
- Do not claim a bond-port will exist in any specific timeframe.
- Do not ship the two deferred stubs with `design.md` files. Proposal-only means proposal-only.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] The `escrow-port` change blocks on this document landing, because its `milestone_condition` shape comes from here.
