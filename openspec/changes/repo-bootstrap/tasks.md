# Tasks — Repo bootstrap

## Linear

- Suggested title: `payments-core: bootstrap TypeScript skeleton (tooling + CI)`
- Suggested labels: `chore`, `infra`.
- Base branch: `main`. Branch name: `chore/PCR-{issue-id}-repo-bootstrap`.

## Implementation checklist

### Tooling files (root)

- [ ] `package.json` per the design spec (no runtime deps).
- [ ] `tsconfig.json` strict as in design.
- [ ] `tsconfig.build.json` extending the above.
- [ ] `.prettierrc.json` (2-space indent, single quotes, trailing commas "all", print width 100).
- [ ] `eslint.config.js` (flat config) with the baseline rules from design.
- [ ] `vitest.config.ts` (defaults + coverage reporter `text-summary`).
- [ ] `Makefile` with the six targets.
- [ ] `.nvmrc` pinning Node 20.11+.
- [ ] `.env.example` (empty, documentation-only for now).
- [ ] `src/index.ts` with `export {};` so the build has something to emit.

### GitHub wiring

- [ ] `.github/workflows/ci.yml` as specified.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` linking back to the relevant OpenSpec change.
- [ ] `.github/CODEOWNERS` with `* @lapc506`.

### First run

- [ ] `pnpm install` runs cleanly, commits `pnpm-lock.yaml`.
- [ ] `pnpm lint` passes (zero warnings acceptable, zero errors required).
- [ ] `pnpm build` emits `dist/index.js` and `dist/index.d.ts`.
- [ ] `pnpm test` runs Vitest with zero tests and exits 0.
- [ ] `git status` is clean; no build artifacts tracked (verify `.gitignore` covers them).

### Verification on the PR

- [ ] CI workflow runs and is green on the PR.
- [ ] Greptile has zero P1/P2 findings (or they are addressed inline).
- [ ] CodeRabbit has no blockers.
- [ ] Reviewer can check out the branch, run `make install test build`, and see green.

## Pitfalls to avoid

- Do not add runtime dependencies here. Each adapter adds its own in its own change.
- Do not add framework-specific ESLint plugins (no `eslint-plugin-import`, no `eslint-plugin-n`) unless a later change has a rule it must enforce.
- Do not add husky / lint-staged / pre-commit hooks. The ecosystem uses CI as the enforcement boundary; local hooks cause divergence between contributors.
- Do not split the tsconfig into `tsconfig.base.json` + `tsconfig.lib.json` etc. v0.1 has one package, two tsconfigs (dev + build).

## Post-merge

- [ ] Linear `Done`, comment with the PR link.
- [ ] Worktree removed.
- [ ] Branch deleted.
- [ ] `proto-contract-v1` change can now safely open a PR against the bootstrapped `main`.
