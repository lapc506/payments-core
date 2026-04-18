# Design — MkDocs site + Stoplight Elements

## File layout

```
docs/
├── mkdocs.yml
├── requirements.txt
├── content/
│   ├── index.md
│   ├── assets/
│   │   ├── stylesheets/payments-core.css
│   │   └── javascripts/stoplight-elements.js
│   └── docs/
│       ├── governance/index.md           (detailed page in governance-rubric-adoption)
│       ├── architecture/index.md         (detailed pages land with domain / application / adapters)
│       ├── ports/index.md
│       ├── adapters/
│       │   ├── index.md
│       │   ├── stripe.md                 (stripe-adapter-p0)
│       │   ├── onvopay.md                (onvopay-adapter-p0)
│       │   ├── tilopay.md                (tilopay-adapter-p1)
│       │   ├── dlocal.md                 (dlocal-adapter-p2)
│       │   ├── revolut.md                (revolut-adapter)
│       │   ├── convera.md                (convera-adapter)
│       │   ├── ripple.md                 (ripple-xrpl-adapter)
│       │   └── apple-google-pay.md       (apple-google-verify-p2)
│       ├── integrations/
│       │   ├── index.md
│       │   ├── agentic-core.md
│       │   ├── marketplace-core.md
│       │   ├── invoice-core.md
│       │   ├── compliance-core.md
│       │   └── consumers/
│       │       ├── dojo-os.md
│       │       ├── altrupets.md
│       │       ├── habitanexus.md
│       │       ├── vertivolatam.md
│       │       └── aduanext.md
│       ├── donations/
│       │   ├── index.md
│       │   └── crowdfunding.md          (Vaki / Kickstarter / Indiegogo analysis)
│       ├── security/index.md
│       ├── api/
│       │   ├── index.md
│       │   └── reference.md             (Stoplight Elements embed)
│       ├── references/index.md
│       ├── legal/index.md
│       └── operations/index.md
└── site/                                 (build output, gitignored)
```

**This change** creates every `index.md` file listed above (as short orientation stubs) plus the two asset files plus the Stoplight wiring. **It does not** create the per-topic pages (`stripe.md`, `habitanexus.md`, etc.) — those land with their owning changes.

## `mkdocs.yml` essentials

Copied from `aduanext/docs/site/mkdocs.yml` with these changes:

- `site_name: payments-core`
- `site_description: One payments sidecar for the -core ecosystem`
- `site_url: https://lapc506.github.io/payments-core`
- `repo_url: https://github.com/lapc506/payments-core`
- `repo_name: lapc506/payments-core`
- `docs_dir: content`
- `site_dir: site`
- Language: `en` (aduanext uses `es`). Switching to Spanish later is an additive change.
- Nav (abbreviated):
  ```yaml
  nav:
    - Home: index.md
    - Governance: docs/governance/index.md
    - Architecture: docs/architecture/index.md
    - Ports: docs/ports/index.md
    - Adapters: docs/adapters/index.md
    - Integrations: docs/integrations/index.md
    - Donations & Crowdfunding: docs/donations/index.md
    - Security: docs/security/index.md
    - API Reference: docs/api/reference.md
    - References: docs/references/index.md
    - Legal: docs/legal/index.md
    - Operations: docs/operations/index.md
  ```
- Markdown extensions: match `aduanext` verbatim (admonition, attr_list, def_list, footnotes, md_in_html, tables, toc, pymdownx.* family, mermaid fence).
- `extra_css: [stylesheets/payments-core.css]`
- `extra_javascript: [javascripts/stoplight-elements.js]`
- `dev_addr: 0.0.0.0:8002` (aduanext uses 8001, offset so they can run side-by-side).

## Stoplight Elements integration

Stoplight Elements is distributed as an ES module. The loader file `assets/javascripts/stoplight-elements.js` registers the Web Component from the CDN and sets default attributes:

```js
// assets/javascripts/stoplight-elements.js
import 'https://unpkg.com/@stoplight/elements/web-components.min.js';
import 'https://unpkg.com/@stoplight/elements/styles.min.css';
```

The `api/reference.md` page uses `md_in_html` to embed the component:

```markdown
# API Reference

<div>
<elements-api
  apiDescriptionUrl="/payments-core/openapi/payments_core.yaml"
  router="hash"
  layout="sidebar"
></elements-api>
</div>
```

The URL path assumes the site is served under `/payments-core/` on GitHub Pages. The OpenAPI descriptor itself is written by `proto-contract-v1`. Until then, this page ships with a **stub** descriptor that declares one placeholder operation, so the page renders without a 404.

## GitHub Pages deployment

A workflow at `.github/workflows/docs-deploy.yml` runs on pushes to `main`, installs Python 3.12 + `docs/requirements.txt`, runs `mkdocs build --strict`, and publishes `docs/site/` to the `gh-pages` branch via `peaceiris/actions-gh-pages@v4`.

## Accessibility and i18n

- Material for MkDocs ships accessible defaults; we do not disable navigation landmarks.
- `lang="en"` is set in the theme config.
- Stoplight Elements has its own a11y story; we do not override it.

## Risks

- **Stoplight Elements CDN outage** — unlikely but real. If desired later, we can vendor the component under `assets/vendor/stoplight/`. Not worth it for v0.1.
- **OpenAPI stub drift** — if the stub is forgotten and left in place after `proto-contract-v1` lands, the docs show a fake endpoint. Mitigation: `proto-contract-v1` explicitly removes the stub in its `tasks.md`.
- **Strict build failures on broken links** — some index pages reference pages that do not yet exist. Mitigation: every index stub lists its child pages as `(landing with $CHANGE-NAME)` in plain text, not as links, until the pages exist.

## Rollback

Revert. The repository loses its docs site but the `openspec/` tree and runtime code remain functional.
