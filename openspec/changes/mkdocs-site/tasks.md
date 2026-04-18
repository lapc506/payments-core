# Tasks — MkDocs site + Stoplight Elements

## Linear

- Suggested title: `payments-core: MkDocs site + Stoplight Elements for API reference`
- Labels: `documentation`, `infra`.
- Base branch: `main`. Branch: `docs/PCR-{issue-id}-mkdocs-site`.

## Implementation checklist

### MkDocs wiring

- [ ] `docs/mkdocs.yml` created per design spec.
- [ ] `docs/requirements.txt` with pinned deps: `mkdocs-material`, `pymdown-extensions`.
- [ ] `docs/content/index.md` — landing page with one-paragraph overview + nav-highlight cards pointing to Governance, Architecture, API Reference.
- [ ] `docs/content/assets/stylesheets/payments-core.css` — minimal brand overrides (primary color, accent color to be decided; placeholder is fine).
- [ ] `docs/content/assets/javascripts/stoplight-elements.js` — ES module imports from the Stoplight CDN.

### Section index stubs (all short orientation pages)

- [ ] `docs/content/docs/governance/index.md`
- [ ] `docs/content/docs/architecture/index.md`
- [ ] `docs/content/docs/ports/index.md`
- [ ] `docs/content/docs/adapters/index.md`
- [ ] `docs/content/docs/integrations/index.md`
- [ ] `docs/content/docs/integrations/consumers/index.md` (lists the five consumer backends as unlinked items until their pages land)
- [ ] `docs/content/docs/donations/index.md`
- [ ] `docs/content/docs/security/index.md`
- [ ] `docs/content/docs/api/index.md`
- [ ] `docs/content/docs/api/reference.md` with the `<elements-api>` embed pointing to the OpenAPI stub
- [ ] `docs/content/docs/references/index.md`
- [ ] `docs/content/docs/legal/index.md`
- [ ] `docs/content/docs/operations/index.md`

### OpenAPI stub

- [ ] `openapi/payments_core.yaml` — valid OpenAPI 3.1 document with exactly one path (`/health`) returning `200 { status: "ok" }`. Will be replaced by `proto-contract-v1`.

### GitHub Pages

- [ ] `.github/workflows/docs-deploy.yml` — triggers on push to `main`, builds, publishes to `gh-pages`.
- [ ] Settings in the GitHub repo: Pages source set to `gh-pages` branch, root. (Manual step after the first deploy succeeds.)

### Verification

- [ ] `cd docs && pip install -r requirements.txt && mkdocs serve` renders at `http://localhost:8002` without warnings.
- [ ] `mkdocs build --strict` passes.
- [ ] The `/api/reference/` page loads `<elements-api>` and displays the stub `/health` operation.
- [ ] Navigation menu shows every section listed in `mkdocs.yml`.
- [ ] All section index pages render without broken-link warnings.

### PR

- [ ] PR opened against `main`: `docs(site): bootstrap MkDocs + Stoplight Elements`.
- [ ] PR body links the proposal and design.
- [ ] `@greptile review`.
- [ ] All reviewer threads addressed and resolved.
- [ ] CI (`ci.yml` from `repo-bootstrap`) and docs-deploy workflow pass.

## Pitfalls to avoid

- Do not import Stoplight Elements inline in every page. Use the `extra_javascript` + single embed pattern.
- Do not write section pages that reference topics owned by later changes with live links — use plain text notes like `(landing with stripe-adapter-p0)` until the pages exist.
- Do not enable `mermaid2`, `git-revision-date-localized`, or `minify` plugins in v0.1. Keep them commented in `mkdocs.yml`.
- Do not change the `docs_dir` / `site_dir` layout. Match `aduanext` so anyone who has seen that site finds this one immediately.

## Post-merge

- [ ] Linear `Done` with PR link.
- [ ] Worktree removed, branch deleted.
- [ ] Maintainer enables GitHub Pages in repo settings if not auto-enabled.
- [ ] Subsequent content-producing changes can now land per-topic pages without wiring the site.
