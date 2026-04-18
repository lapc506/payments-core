# OpenSpec — agent conventions for `payments-core`

This directory is the source of truth for every significant change to this repository. Before writing code, subagents and humans alike MUST read the relevant `openspec/changes/{change-name}/` folder and follow the three-file convention below.

## The three files

Each change lives in `openspec/changes/{change-name}/` and contains exactly three files:

1. **`proposal.md`** — answers **WHY**. Problem statement, user/consumer impact, alternatives considered, why this change wins. One page max.
2. **`design.md`** — answers **HOW**. Architecture, APIs, data shapes, diagrams (mermaid), trade-offs, risk, rollback plan. As long as needed, but focused.
3. **`tasks.md`** — answers **WHAT**. A flat checklist of implementation steps, acceptance criteria, test plan, and the review checklist for reviewers. Checkboxes in Markdown.

## Naming

- Directory name: kebab-case, short, stable. Example: `stripe-adapter-p0`.
- Prefixes are NOT required (no `feat-`, no `chore-`). The change type is implicit in the scope.

## Lifecycle

1. **Draft**: all three files exist but `tasks.md` is mostly unchecked. A Linear issue MAY exist but is not required until the change is ready for implementation.
2. **Ready for implementation**: `proposal.md` approved, `design.md` reviewed, Linear issue opened and linked, `tasks.md` items actionable.
3. **In progress**: Linear issue `In Progress`, a subagent is working in a worktree, tasks checked off as they land.
4. **Merged**: PR merged to `main`, Linear `Done`. Change directory MAY be kept as an archive or moved to `openspec/changes/archived/` at maintainer discretion.

## Subagent dispatch

Changes are implemented via the `/make-no-mistakes:implement` protocol with worktree isolation. Each subagent receives:

- the `openspec/changes/{change-name}/` directory path,
- the corresponding Linear issue ID,
- the repo root, base branch (`main`), and branch naming pattern,
- hard constraints from this file.

## Hard constraints for all changes

1. **Target `main`** — this repo has a single long-lived branch. No `develop`, no `release/*`.
2. **Every change gets its own worktree** — no shared worktrees across subagents.
3. **Every PR has passing CI + Greptile findings addressed** before merge.
4. **One PR per change** — if the scope exceeds ~15 files, split the change into two change directories with clear dependency links in their `proposal.md` files.
5. **Never commit secrets** — `.env` is gitignored, `.p12`/`.pem`/`.key` blocked globally.
6. **No debug logs in merged code** — `console.log`, `debugger`, ad-hoc `debug(` calls are removed before PR is ready for review.
7. **No premature abstractions** — if only one adapter implements a port, do not generalize the port further than that adapter needs.

## Relationship to the sibling rubric

The ecosystem-wide `-core` governance rubric (see `docs/content/docs/governance/rubric.md`) evaluates whether a standalone `-core` is justified. That rubric is evaluated **once per core repo** and the verdict is captured in `openspec/changes/governance-rubric-adoption/`. Individual changes within this repo do not re-run the rubric; they inherit it.

## Relationship to sibling repos

Some changes in this repo require corresponding changes in sibling repos (`agentic-core`, `marketplace-core`, `invoice-core`, consumer backends). Those coordinated changes are tracked as separate OpenSpec proposals in the sibling repo, with a `proposal.md` cross-reference here.

Examples:
- `agentic-core-extension` here → a matching `payments-core-client-port` change in `agentic-core`.
- `marketplace-core-events` here → a matching `storefront-checkout-events` change in `marketplace-core`.

Neither side is merged until both sides' changes pass review, to keep the cross-repo contract consistent.
