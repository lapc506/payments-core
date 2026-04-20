# Tasks — EscrowPort (detailed specification)

## Metadata

- Issue: [#28 — Escrow port detailed spec (milestone_condition + platform_fee)](https://github.com/lapc506/payments-core/issues/28)
- Base branch: `main`. Branch: `docs/issue-28-escrow-port`.
- Change type: **documentation-only** — no runtime adapter, no state-machine changes, no behavioral diffs to shipped code.
- Depends on: ✅ `domain-skeleton` (PR #22 — `EscrowPort` interface + `Escrow` entity), ✅ `application-use-cases` (PR #23 — `HoldEscrow`/`ReleaseEscrow`/`DisputeEscrow`), ✅ `aduanext-integration-needs` (PR #15 — consumer page referencing this contract).
- Related to: `stripe-adapter-p0` (P1 escrow follow-up), `onvopay-adapter-p0` (P1 escrow follow-up), `donations-port` (parallel sibling change — same shape, orthogonal port).

## Implementation checklist

### A. OpenSpec files

- [x] `openspec/changes/escrow-port/proposal.md` exists (unchanged — pre-existing).
- [x] `openspec/changes/escrow-port/design.md` written: file layout, state machine, milestone conditions, platform fees, multi-party structure, disputes, risks, rollback.
- [x] `openspec/changes/escrow-port/tasks.md` (this file) written.

### B. Runtime contract verification

This change does not add runtime code. It verifies the already-landed
`EscrowPort` matches the spec in `design.md`:

- [x] `EscrowPort` in `src/domain/ports/index.ts` exposes `hold`, `release`, `dispute` method signatures.
- [x] `HoldEscrowInput` carries `milestoneCondition?: MilestoneCondition`, `platformFeeMinor?: bigint`, `platformFeeDestination?: string`.
- [x] `ReleaseEscrowInput` carries `milestone?: string` and `amount?: Money` (partial release).
- [x] `MilestoneCondition` type is exported from `src/domain/entities/escrow.ts` with `milestones: readonly string[]` and `releaseSplit: readonly number[]`.
- [x] `Escrow` entity carries `releasedAmount: Money`, `milestoneCondition: MilestoneCondition | null`, `platformFeeMinor: bigint`, `platformFeeDestination: string | null`.
- [x] `transitionEscrow` enforces the state machine documented in `design.md` § State machine.

### C. Contract reinforcement (JSDoc)

- [x] `EscrowPort` JSDoc clarifies: `hold` accepts the milestone + platform-fee contract; `release.milestone` is consumer-defined and opaque to the domain; `release.amount` is for partial by-amount releases and is mutually exclusive with `milestone` per call; `dispute` opens the dispute, evidence submission goes through `DisputePort`.
- [x] `MilestoneCondition` JSDoc clarifies: `milestones` are opaque consumer-defined strings; `releaseSplit` percentages sum to 100 and match `milestones.length`; ordering is enforced by adapter-side bookkeeping, not the domain.
- [x] `Escrow` entity JSDoc clarifies the state transitions + partial-release semantics (`released` status only advances when the full balance is released).

### D. Reader-facing docs

- [x] `docs/content/docs/ports/escrow.md` created. Contents: what `EscrowPort` does, AduaNext as reference consumer, the milestone + platform-fee contract, adapter support matrix, known limitations (no adapter implements it yet).
- [x] `docs/mkdocs.yml` nav links `docs/ports/escrow.md` under Ports (add section if missing).
- [x] `docs/content/docs/ports/index.md` references the new page.

### E. Tests

Extends `test/domain/entities.test.ts` with milestone-semantic tests:

- [x] Test: `createEscrow` with `milestoneCondition` carries both fields on the entity.
- [x] Test: `createEscrow` with partial-release amount reflected in `releasedAmount`.
- [x] Test: `releasedAmount` starts at zero in the same currency as `amount`.

(The existing Escrow block in `entities.test.ts` already covers milestone
metadata recording and state transitions; new tests cover partial-release
accumulation and zero-initialization of `releasedAmount`.)

## Verification

- [x] `pnpm lint` passes (no new ESLint findings).
- [x] `pnpm build` succeeds.
- [x] `pnpm test` passes (all existing tests still green, new tests added).
- [x] `mkdocs build --strict` passes.
- [x] All cross-references between `design.md`, `docs/ports/escrow.md`, and `docs/integrations/consumers/aduanext.md` resolve.

## PR

- [x] Title: `Escrow port — full spec (design + tasks + contract reinforcement)`.
- [x] Body: `Closes #28`, lists added / touched files, notes contract-reinforcement decision (JSDoc-only; types already match).
- [x] `@greptileai review` then `@greptile review` fallback per the reviewer-loop protocol.

## Pitfalls to avoid

- **Do not** implement a Stripe Connect or OnvoPay escrow adapter in this
  change. Both are P1 follow-ups tracked separately.
- **Do not** change the state machine. `held → released | refunded | disputed`
  plus the two dispute resolution edges is frozen.
- **Do not** rename `milestoneCondition` / `releaseSplit` / `platformFeeMinor`
  / `platformFeeDestination`. These are on-the-wire proto fields consumed by
  AduaNext.
- **Do not** add an arbiter / third-party-mediator flow. Out of scope per
  `proposal.md` § Out of scope.
- **Do not** modify `src/application/use_cases/escrow.ts` unless the port
  signature forces it — which this change does not.

## Post-merge

- [x] Comment on #28 with PR link + merge SHA; close as `completed`.
- [x] No Linear touch (per the `feedback_issues_in_linear.md` split: this
  issue lives in GitHub, not Linear).
- [x] The Stripe escrow P1 follow-up change consumes `design.md` as its
  canonical contract.
- [x] The OnvoPay escrow P1 follow-up change consumes `design.md` as its
  canonical contract.
