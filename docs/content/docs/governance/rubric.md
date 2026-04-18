# The `-core` rubric

The rubric below is paraphrased from the ecosystem-wide `-core` governance
document. That document is the canonical source; it lives outside this
repository and is maintained by the ecosystem maintainer. This page exists so
that a reader of `payments-core` can understand what the rubric asks without
leaving the site.

If this page and the canonical rubric ever disagree, the canonical rubric
wins. Open a PR against this file to re-sync.

## How the rubric is used

Before a new `-core` repository is created, the candidate is scored against
five criteria. A score of **4 of 5** or higher is required for approval. The
scored verdict is then captured in the candidate repo as an OpenSpec change
(for `payments-core`, see
[`governance-rubric-adoption`](https://github.com/lapc506/payments-core/tree/main/openspec/changes/governance-rubric-adoption))
and mirrored on the ecosystem document under its §5.

The same rubric is used in reverse to reject candidates that do not clear the
bar: when a proposal comes in, the rubric justifies either "yes, extract this"
or "no, this stays as an adapter / module / deferred concern".

## The five criteria

### 1. Cross-startup reuse

Does the capability have multiple committed consumers today, or in the
immediate near-term roadmap? A single consumer is never enough; the rubric
explicitly rejects "someone might want this" as evidence.

Strong evidence looks like a list of specific backends or products, each named
and with a concrete use case. Weak evidence looks like a generic appeal to
reusability.

### 2. Bounded domain

Does the capability live inside a coherent bounded context with its own state
machines, invariants, and vocabulary? If the candidate spans two bounded
contexts, it is typically better to keep them separate and let events connect
them.

Strong evidence looks like a list of state machines the candidate owns,
contrasted with the state machines that neighboring `-core` repositories own.

### 3. Non-trivial complexity

Does the capability carry enough inherent complexity — protocol-level quirks,
regulatory constraints, failure-mode richness — that extracting it saves
duplication across consumers?

Strong evidence looks like a list of hard problems the adapter layer must
solve (idempotency, retries, webhook verification, multi-currency FX, PCI
scope, dispute handling, etc.).

### 4. Credential / regulatory isolation

Would isolating the capability into its own sidecar meaningfully reduce the
credential or compliance surface in each consumer? Repositories that collapse
many secret types and regulatory scopes into a single pod score higher than
repositories that only hold a handful of generic API keys.

Strong evidence looks like a list of the secrets, regulated data, and audit
scopes that stop crossing the consumer boundary once the sidecar exists.

### 5. External integrations with rate-limit / retry concerns

Does the capability talk to multiple external services that each impose their
own rate limits, retry semantics, idempotency requirements, and webhook
verification rituals? Centralizing those concerns tends to justify the
sidecar even when the domain itself looks simple.

Strong evidence looks like a list of named external integrations the repo
plans to adopt, each with its own retry / verification profile.

## Interpreting the score

- **5 of 5** — strong justification; all rubric criteria clearly satisfied.
  At the time of writing, only `compliance-core` and `payments-core` sit in
  this bracket.
- **4 of 5** — approved, with the failing criterion documented as an
  accepted trade-off.
- **3 of 5 or lower** — rejected. The candidate should live as an adapter
  inside an existing `-core`, as a module inside a consumer backend, or be
  deferred until the rubric changes.

## Anti-patterns the rubric rejects

The ecosystem document lists anti-patterns that the rubric is designed to
block. The ones most relevant when scoring `payments-core` are paraphrased
in the [Governance overview](index.md#anti-patterns-we-avoid).
