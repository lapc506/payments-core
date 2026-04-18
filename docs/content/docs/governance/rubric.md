# Rubric

The five criteria below paraphrase the ecosystem-wide `-core` governance
rubric. A candidate domain justifies a standalone `-core` repository when it
clears **four of the five** criteria. `payments-core` cleared all five on
2026-04-18; the verdict and evidence are on the [Governance](index.md) page.

The canonical ecosystem rubric is authored and maintained outside this
repository as `2026-04-16-core-governance-rubric.md` by the `-core`
ecosystem maintainer (@lapc506). When the two documents disagree, the
canonical version wins and this page is updated to match.

## Criterion 1 — Real cross-startup reuse

At least two consumers in the portfolio need the domain with a similar
specification on the 12-to-18-month roadmap. The test is **current and
projectable reuse**, not theoretical reuse. "Some other startup might need
this eventually" does not count. Building a shared library before a second
named consumer exists costs more than refactoring the first consumer once
the second arrives.

## Criterion 2 — Bounded domain

The domain owns its own entities, value objects, ports, state machines, and
invariants, and it does not collapse into an existing `-core`. The test
separates a **domain** (with its own ubiquitous language) from a
**destination adapter** (another way to serialise existing data) or a
**utility** (shared code without a state machine). Destinations and
utilities live inside a sibling `-core` or a backend; they do not earn
their own repository.

## Criterion 3 — Non-trivial complexity

Re-implementing the domain in each consumer backend would consume more than
roughly 2k lines of **value-bearing** code — algorithms, cryptographic
protocols, state machines, regulated business rules — excluding CRUD
boilerplate and serialisation. The heuristic threshold: if a competent
engineer can replicate the domain in under three days without consulting
specialised regulation, it probably does not justify a `-core`.

## Criterion 4 — Credential or regulatory isolation

Secrets (`.p12` files, API keys, signing keys) or regulated data (PII, PCI,
HIPAA, SOC 2, AML-scoped transactions) benefit from running in an isolated
pod. Isolation buys two things: **operational** (a compliance layer can be
updated without redeploying every consumer) and **security** (the blast
radius of a single startup compromise does not reach another startup's
credentials).

## Criterion 5 — External integrations with rate-limit or retry

The domain depends on external APIs (payment rails, fiscal authorities,
identity providers, sanctions lists) that benefit from a centralised
circuit breaker, retry policy, and quota budget. Centralising the traffic
in one `-core` gives every consumer the same backoff, the same metrics, and
a single place to coordinate when the upstream degrades.

## How the verdict is applied

For each candidate `-core` the protocol is:

1. Name the candidate.
2. Score each of the five criteria with :material-check: (pass),
   :material-alert: (partial), or :material-close: (fail), with a short
   justification.
3. Count the passes.
4. Four or more passes and the candidate is approved; it enters the
   roadmap. Fewer than four and it is rejected — the decision record
   captures where the domain lives instead (adapter, backend module,
   auxiliary library, or deferred).
5. Approval is a technical verdict only. Implementation priority is set
   separately against regulatory urgency, consumer blockers, and available
   build capacity.

A passing verdict is not a licence to expand scope. The [scope
boundaries](index.md#scope-boundaries) on the Governance page are part of
the rubric decision; stretching them invalidates the verdict and requires a
re-evaluation.

## Related reading

- [Governance verdict for `payments-core`](index.md).
- OpenSpec change:
  [`governance-rubric-adoption`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/governance-rubric-adoption).
- Deferred-crowdfunding companion decision:
  [`crowdfunding-deferred`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/crowdfunding-deferred).
