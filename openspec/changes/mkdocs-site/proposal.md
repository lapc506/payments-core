# Proposal — MkDocs site + Stoplight Elements

## Context

`payments-core` needs a published documentation site from day one so external consumers (and future maintainers) can understand the contract, the state machines, and the integration story without reading every `openspec/changes/` directory. The sibling `aduanext` repository already ships a Material-for-MkDocs site (`docs/site/mkdocs.yml`) that we want to match for ergonomic consistency across the ecosystem.

Additionally, `payments-core` is a gRPC service whose public surface is defined by a protobuf file. Protobuf alone is not readable documentation, so we need an OpenAPI mirror of the gRPC surface (generated in a separate change) and an interactive rendering of that OpenAPI descriptor inside the docs site. [Stoplight Elements](https://stoplight.io/open-source/elements) is the component that does this — it is a standalone Web Component, open source, and embeddable in any static site.

## Why now

Two reasons converge:

1. The `governance-rubric-adoption` change creates a `docs/content/docs/governance/index.md` page that has nowhere to render until the site itself exists. Without this change, every subsequent documentation-producing change blocks.
2. Choosing the API-reference renderer after adapters are already written forces a retrofit. Choosing it before the first adapter lands means the `api/reference.md` page is wired once and every later change just writes more OpenAPI paths.

## Scope

- `docs/mkdocs.yml` — Material for MkDocs configuration cloned in shape from `aduanext/docs/site/mkdocs.yml`, adapted to `payments-core` metadata, nav, and a custom stylesheet.
- `docs/requirements.txt` — Python deps pinned (mkdocs-material, pymdown-extensions).
- `docs/content/index.md` — landing page.
- `docs/content/docs/` — the hierarchy of section index pages (governance, architecture, ports, adapters, integrations, donations, security, api, references, legal, operations). Each section index is a short orientation page; individual topic pages land in their owning changes.
- `docs/content/assets/stylesheets/payments-core.css` — minimal brand overrides.
- `docs/content/assets/javascripts/stoplight-elements.js` — loader that registers the `<elements-api>` Web Component and wires it to the OpenAPI descriptor path.
- `docs/content/docs/api/reference.md` — the one page that embeds `<elements-api>`. The OpenAPI descriptor itself is written by the `proto-contract-v1` change; this change only establishes the rendering.
- `.github/workflows/docs-deploy.yml` — builds the site on pushes to `main` and deploys to GitHub Pages (`gh-pages` branch).

## Explicitly out of scope

- No adapter-specific documentation pages. Those live inside each adapter change.
- No `mermaid2` plugin in v0.1 — Material's built-in fenced-mermaid via `pymdownx.superfences` is sufficient and has fewer deps.
- No `git-revision-date-localized`, `git-committers`, or `minify` plugins. Leave commented in the config so a future change can enable with a one-line edit.
- No multi-language support. Docs are in English. Spanish-language pages will be added later if a consumer requires it.

## Alternatives rejected

- **Docusaurus / Nextra** — more JS weight, more customization needed, inconsistent with `aduanext`. Reject.
- **Embed Swagger UI instead of Stoplight Elements** — Swagger UI works but the UX is less polished and the component API is older. Stoplight Elements renders Markdown descriptions natively and has a better "try-it" experience. Reject Swagger.
- **Redoc** — good renderer, but no built-in "try-it"; we want that for consumers wiring integrations. Reject.

## Acceptance

1. `mkdocs serve` runs locally against `docs/mkdocs.yml` and opens a browsable site.
2. `mkdocs build --strict` passes on CI (no broken links, all nav entries resolve).
3. `/api/reference/` renders Stoplight Elements with a stub OpenAPI descriptor (the real one lands in `proto-contract-v1`).
4. Every section in the nav has a working index page, even if that page says only "Content lands with the $CHANGE-NAME change."
