# Proposal — Repo bootstrap

## Context

`payments-core` needs a minimal but production-credible TypeScript monorepo skeleton before any domain, adapter, or documentation code can land. Today the repository contains only `README.md`, `LICENSE.md`, `linear-setup.json`, `.gitignore`, and this `openspec/` tree. Nothing compiles because nothing is wired.

## Why now

Every later change (`proto-contract-v1`, `domain-skeleton`, `stripe-adapter-p0`, …) depends on a working `pnpm install && pnpm test && pnpm build` pipeline and on CI green on `main`. Without those in place, every later PR has to relitigate tool choices, which is a pattern the ecosystem rubric's §9 ("construir antes de consumidor") explicitly warns against — and in this case the consumer is the next subagent.

## Scope

Strictly the **skeleton only**:

- `package.json` (private, workspaces disabled in v0.1)
- `tsconfig.json` with strict mode on
- `tsconfig.build.json` for the dist build
- `eslint.config.js` (flat config, inherits the same ruleset as `invoice-core`)
- `.prettierrc.json`
- `vitest.config.ts`
- `Makefile` with targets `install`, `build`, `test`, `lint`, `format`, `clean`
- `.github/workflows/ci.yml` — runs lint + test + build on PR and on push to `main`
- `.github/PULL_REQUEST_TEMPLATE.md` — links to the relevant OpenSpec change
- `.github/CODEOWNERS` — `@lapc506` owns everything until others are added
- `.env.example` — an empty template documenting env var names only
- `src/index.ts` — a single `export {}` so TypeScript + the build pipeline have something to compile

## Explicitly out of scope

- No domain entities, no value objects, no ports.
- No adapters.
- No proto file.
- No MkDocs configuration (`mkdocs-site` change owns that).
- No CI matrix across Node versions. Pin a single Node version and pin it in `.nvmrc` — expansion is a separate change if/when needed.
- No release tooling (changesets, semantic-release). Deferred until the first adapter is public.

## Alternatives rejected

- **Copy the `invoice-core` skeleton wholesale** — rejected because `invoice-core` has accumulated tooling (OpenAPI generators, XAdES helpers) that would create dead weight here. Copy only the three config files that embody ecosystem-wide conventions: `eslint.config.js`, `tsconfig.json`, `.prettierrc.json`.
- **Start with a mono-package-per-adapter layout** — rejected. v0.1 is a single package. When the adapter count grows past ~5 *and* any consumer wants only a subset, split into workspaces.
- **Go with Bun or Deno instead of Node + pnpm** — rejected. All sibling TypeScript `-cores` use pnpm on Node 20 LTS. Cost of deviating is not paid back by the runtime gains at this stage.

## Acceptance

This change is accepted when:

1. `pnpm install` runs cleanly on a fresh clone.
2. `pnpm test`, `pnpm lint`, `pnpm build` all pass (even if `test` runs zero tests against a stub module — the harness must work).
3. `.github/workflows/ci.yml` shows green on the PR that merges this change.
4. A second subagent can open a PR against `main` immediately after, without needing to re-wire tooling.
