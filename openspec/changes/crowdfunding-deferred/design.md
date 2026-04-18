# Design — Crowdfunding deferred

## File produced

One file: `docs/content/docs/donations/crowdfunding.md`.

## Page outline

### 1. One-paragraph summary

Costa Rican non-profits lost the Vaki / Coopeservidores crowdfunding rail when Coopeservidores entered bankruptcy in 2024. `payments-core` addresses the **donation** use cases (one-time + recurring, cross-border) via its existing adapters. True crowdfunding (campaigns, progress bars, multi-donor aggregation) is deferred until a regulated LATAM rail returns and two or more consumers need it.

### 2. Timeline

- **Pre-2024**: Coopeservidores launches a Vaki instance for Costa Rican non-profits as a partnership with Vaki Colombia (per Observador.cr coverage).
- **Mid-2024**: Coopeservidores enters bankruptcy. SUGEF issues Q&A on depositor protections. Processes start in the national `Juzgado Concursal`.
- **2025–2026**: Affected parties continue to demand transparency. Subset of depositors receives partial recovery (`1242` additional per Semanario Universidad coverage), but the crowdfunding vehicle does not re-open.
- **As of 2026-04-18**: No integrated, API-reachable, locally regulated Costa Rican crowdfunding rail exists.

### 3. Alternatives reviewed

Exact same content as `proposal.md` §Alternatives reviewed, condensed into a reader-friendly table:

| Option | API surface | Fit for CR non-profit | Decision |
|---|---|---|---|
| Kickstarter | Status-only public API; unofficial scrapers | Fragile, ToS-adjacent | Reject |
| Indiegogo | Read-only public API | Cannot drive contributions, only observe | Reject |
| Scrapingbee / third-party scrapers | Commercial | Donor-data intermediary = unacceptable | Reject |
| XRPL donations | `ripple-xrpl-adapter` | Regulatory fit unclear for CR non-profit | Long-horizon, not a replacement |
| Direct donations via Stripe / OnvoPay / Tilopay / dLocal / Revolut / Convera | Full API coverage via `payments-core` DonationPort | Covers the real pain (accept money + issue receipt) | **Adopt as the v1 solution** |

### 4. What we build instead

A short paragraph: `payments-core` exposes `DonationPort` (one-time + recurring). AltruPets Foundation uses it to accept donations via whichever adapter the donor prefers. The *campaign concept* (target amount, progress visualization, donor wall) is a UX concern that lives in `altrupets-api`, using donation metadata fields like `campaign_id`, `donor_visibility`, and `campaign_target_minor`.

### 5. Re-evaluation trigger

Restate the two conditions from the proposal verbatim.

### 6. Sources

Attributed, ordered by topic:

- **Vaki–Coopeservidores launch (pre-bankruptcy)**:
  - Observador.cr — <https://observador.cr/coopeservidores-lanza-plataforma-virtual-vaki-para-apoyar-a-grupos-sin-fines-de-lucro/>
  - Vaki Costa Rica landing — <https://cs.vaki.co/es/>
- **Bankruptcy and aftermath**:
  - La Nación — <https://www.nacion.com/economia/coopeservidores-empieza-proceso-de-quiebra-en/NJIXIUZXOFBCDA3DZRU4K3SCXU/story/>
  - Semanario Universidad — <https://semanariouniversidad.com/pais/afectados-por-quiebra-de-coopeservidores-recibiran-un-1242-adicional-pero-mantienen-protesta-por-falta-de-transparencia/>
  - Poder Judicial CR — <https://pj.poder-judicial.go.cr/index.php/component/content/article/2147-el-juzgado-concursal-de-costa-rica-informa-proceso-concursal-de-coopeservidores>
  - SUGEF Q&A — <https://www.sugef.fi.cr/informacion_relevante/comunicados/Preguntas%20y%20respuestas%20Banco%20Bueno%201-8-2024.pdf>
- **Crowdfunding API alternatives**:
  - Indiegogo public API — <https://help.indiegogo.com/article/616-indiegogo-public-api>
  - Indiegogo API client — <https://github.com/backerclub/indiegogo-api-client>
  - Kickstarter status API — <https://status.kickstarter.com/api>
  - kickscraper (Markolson) — <https://github.com/markolson/kickscraper>
  - Scrapingbee Kickstarter scraper — <https://www.scrapingbee.com/scrapers/kickstarter-scraper-api/>

## Risks

- **Source rot** — Observador / Semanario / La Nación URLs may eventually paywall or move. Mitigation: the page lists each URL with publication name and publication date so a reader can find an archived copy if needed.
- **Sensitive topic tone** — the Coopeservidores collapse is a real and painful event for thousands of depositors. The page uses neutral, factual language and does not speculate about attribution.

## Rollback

Revert. The deferral decision is reversible: if the re-evaluation trigger fires before this page is rewritten, a new change supersedes this one.
