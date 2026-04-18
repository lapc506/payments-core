# Crowdfunding — deferred

!!! note "Status: deferred, not rejected"
    `payments-core` does **not** ship a `CrowdfundingPort` today. This page
    explains why, what the single reachable Costa Rican rail was, what happened
    to it, and the exact conditions that would re-open the decision. Authored
    **2026-04-18**. If you are reading this much later, check the OpenSpec
    change directory linked at the bottom for the current state.

## Summary

Costa Rican non-profits lost the Vaki / Coopeservidores crowdfunding rail when
Coopeservidores entered bankruptcy in 2024. `payments-core` addresses the
**donation** use cases (one-time and recurring, cross-border) via its existing
adapters. True crowdfunding — campaigns, progress bars, multi-donor
aggregation — is deferred until a regulated LATAM rail returns *and* two or
more consumer backends need it. Until then the correct primitive is a
repeated `Donation` carrying a `campaign_id` metadata field; the campaign UI
lives in the consumer backend, not in `payments-core`.

## Timeline

- **Pre-2024** — Coopeservidores launches a Vaki instance for Costa Rican
  non-profits in partnership with Vaki Colombia, per [Observador.cr][1]
  coverage. This is the only integrated, locally-regulated crowdfunding
  vehicle operating at scale in Costa Rica at the time.
- **Mid-2024** — Coopeservidores enters bankruptcy (`concurso mercantil`).
  [SUGEF][4] publishes a public Q&A on depositor protections. The [Juzgado
  Concursal][5] of Costa Rica opens the formal process and publishes
  instructions for creditor appearance.
- **2025–2026** — Affected parties continue to pursue transparency claims.
  A subset of depositors receives a partial additional recovery, reported at
  `12.42%` by [Semanario Universidad][3] in June 2025, bringing total
  recuperation for that subset to `63.10%`. The Vaki–Coopeservidores
  crowdfunding vehicle does not re-open.
- **As of 2026-04-18** — No integrated, API-reachable, locally regulated
  Costa Rican crowdfunding rail exists. See [La Nación][2] for a general
  account of the bankruptcy proceedings.

## Alternatives reviewed

| Option | API surface | Fit for a Costa Rican non-profit | Decision |
|---|---|---|---|
| Kickstarter | [Status-only public API][8]; unofficial scrapers such as [kickscraper][9] | Fragile, ToS-adjacent, no contribution flow | Reject |
| Indiegogo | [Read-only public API][6], community [PHP client][7] | Cannot drive contributions, only observe | Reject |
| Third-party scrapers | Commercial, e.g. [Scrapingbee][10] | Inserts a donor-data intermediary; unacceptable for a regulated non-profit | Reject |
| XRPL donations | `ripple-xrpl-adapter` (separate OpenSpec change) | Regulatory fit for a Costa Rican non-profit is unclear; FX and accounting treatment are open questions | Long-horizon, not a replacement |
| Direct donations via Stripe / OnvoPay / Tilopay / dLocal / Revolut / Convera | Full API coverage via `payments-core` `DonationPort` | Covers the real pain — accept funds, issue a fiscally deductible receipt via `invoice-core` | **Adopt as the v1 solution** |

## What we build instead

`payments-core` exposes `DonationPort` (one-time and recurring). AltruPets
Foundation uses it to accept donations via whichever adapter the donor
prefers. The *campaign concept* — a donation target, a progress bar,
multi-donor aggregation, a public campaign page — is a UX concern that lives
in the consumer backend (`altrupets-api`). `DonationPort` supports this by
accepting metadata fields such as `campaign_id`, `donor_visibility`, and
`campaign_target_minor` on each donation. `N` donations sharing a
`campaign_id` compose a campaign at the application layer.

The `DonationPort` implementation itself is specified in the separate
`donations-port` OpenSpec change.

## Re-evaluation trigger

This deferral moves from "deferred" to "active" when **both** of the
following conditions are met:

1. **Two or more** consumer backends have a concrete product requirement for
   a campaign / progress-bar / multi-donor primitive that cannot be modeled
   as a repeated `Donation` with the same `campaign_id` metadata field.
2. A viable regulated LATAM crowdfunding rail **exists and is reachable via
   API** (a post-Vaki replacement, or a direct partnership with a regulated
   cooperative).

Until both hold, the correct answer is: AltruPets uses `DonationPort` with
`campaign_id` metadata; the campaign UI lives in `altrupets-api`.

## Sources

Verified reachable on **2026-04-18**. If any URL has since moved or
paywalled, the publication name, article title keywords, and approximate
date should be sufficient to locate an archived copy.

**Vaki–Coopeservidores launch (pre-bankruptcy):**

1. [Observador.cr — "Coopeservidores lanza plataforma virtual Vaki para apoyar a grupos sin fines de lucro"][1]
2. [Vaki Costa Rica landing page][vaki-cr]

**Bankruptcy and aftermath:**

3. [La Nación — Coopeservidores bankruptcy proceedings][2]
4. [Semanario Universidad — depositors receive additional `12.42%` recovery, June 2025][3]
5. [Poder Judicial CR — Juzgado Concursal process and creditor appearance instructions][5]
6. [SUGEF — Q&A on Banco Bueno (depositor protections), 2024-08-01][4] *(served over HTTPS with a CA chain some standalone HTTP clients cannot verify; standard browsers load it fine)*

**Crowdfunding API alternatives:**

7. [Indiegogo public API documentation][6]
8. [Indiegogo PHP API client (`backerclub/indiegogo-api-client`)][7]
9. [Kickstarter status API][8]
10. [`kickscraper` (Ruby, markolson)][9]
11. [Scrapingbee Kickstarter scraper API][10]

## Related

- OpenSpec change directory: `openspec/changes/crowdfunding-deferred/`
  (proposal, design, tasks).
- OpenSpec archive entry: `openspec/specs/crowdfunding-deferred.md`.
- Implementation change for the actual donation rail: `donations-port`.

[1]: https://observador.cr/coopeservidores-lanza-plataforma-virtual-vaki-para-apoyar-a-grupos-sin-fines-de-lucro/
[vaki-cr]: https://cs.vaki.co/es/
[2]: https://www.nacion.com/economia/coopeservidores-empieza-proceso-de-quiebra-en/NJIXIUZXOFBCDA3DZRU4K3SCXU/story/
[3]: https://semanariouniversidad.com/pais/afectados-por-quiebra-de-coopeservidores-recibiran-un-1242-adicional-pero-mantienen-protesta-por-falta-de-transparencia/
[4]: https://www.sugef.fi.cr/informacion_relevante/comunicados/Preguntas%20y%20respuestas%20Banco%20Bueno%201-8-2024.pdf
[5]: https://pj.poder-judicial.go.cr/index.php/component/content/article/2147-el-juzgado-concursal-de-costa-rica-informa-proceso-concursal-de-coopeservidores
[6]: https://help.indiegogo.com/article/616-indiegogo-public-api
[7]: https://github.com/backerclub/indiegogo-api-client
[8]: https://status.kickstarter.com/api
[9]: https://github.com/markolson/kickscraper
[10]: https://www.scrapingbee.com/scrapers/kickstarter-scraper-api/
