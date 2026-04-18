# Tasks — Governance rubric adoption

## Linear

- Linear issue: _to be created at the moment this change moves from Draft to Ready for implementation._
- Suggested title: `payments-core: adopt ecosystem -core governance rubric (OpenSpec)`
- Suggested labels: `documentation`, `governance`.
- Base branch: `main`. Branch naming: `docs/PCR-{issue-id}-governance-rubric-adoption`.

## Implementation checklist

- [ ] Worktree created under `.claude/worktrees/{issue-id}/` against `main`.
- [ ] `openspec/changes/governance-rubric-adoption/proposal.md` present and unchanged.
- [ ] `openspec/changes/governance-rubric-adoption/design.md` present and unchanged.
- [ ] `openspec/changes/governance-rubric-adoption/tasks.md` present (this file).
- [ ] `docs/content/docs/governance/index.md` created, matching the content outline in `design.md`.
- [ ] The MkDocs nav entry for `Governance` is wired in `docs/mkdocs.yml` (added by `mkdocs-site` change; if that change has not merged yet, scaffold a TODO comment referencing the nav update).
- [ ] `docs/content/docs/governance/rubric.md` added with the five criteria paraphrased from the ecosystem document. Links out to the ecosystem rubric at its canonical location are acceptable.
- [ ] A short `CHANGELOG.md` entry is added under `Unreleased` pointing at the governance adoption.
- [ ] The `README.md` Governance section already links to `openspec/changes/governance-rubric-adoption/`; verify the link still resolves in the final tree.

## Verification

- [ ] `mkdocs build --strict` passes locally (no broken links, no missing nav entries) assuming the `mkdocs-site` change has already landed.
- [ ] `grep -R "governance-rubric-adoption" .` returns the expected set of references.
- [ ] The rendered governance page reads sensibly to a contributor who has never seen the ecosystem rubric.

## PR

- [ ] PR opened against `main` with title `docs(governance): adopt ecosystem -core rubric verdict (5/5)`.
- [ ] PR body links the Linear issue and the proposal.md.
- [ ] Author line includes `Created by Claude Code on behalf of @lapc506`.
- [ ] `@greptile review` requested.
- [ ] All Greptile / CodeRabbit / Graphite findings replied to with fixes or explicit rationale; threads resolved.

## Post-merge

- [ ] Linear issue moved to `Done`, comment with the PR link.
- [ ] Worktree removed (`git worktree remove`) and local branch deleted.
- [ ] Maintainer updates the ecosystem-wide rubric document (outside this repo) to add the `payments-core` row under §5, matching the verdict table here.

## Explicitly NOT in this change

- No runtime code.
- No `package.json` / `tsconfig` / build tooling.
- No proto contract.
- No adapter documentation.
- No CI workflow files (that is the `repo-bootstrap` change).
