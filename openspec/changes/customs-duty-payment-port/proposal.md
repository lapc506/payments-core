# Proposal — CustomsDutyPaymentPort (deferred)

## Context

Costa Rican customs duties, VAT, and other import taxes are paid to the Ministry of Finance (Hacienda) after a DUA is liquidated. The rails are Costa Rica-specific: SINPE Móvil, direct bank transfer to a Hacienda account, BCCR settlement for institutional importers. None of these rails expose an API reachable from private software today; importers pay via the Hacienda portal or their bank.

`aduanext-integration-needs` identified this as Flow C and explicitly deferred it: without a reachable rail, a port would have no adapter to back it, which is the rubric's §9 anti-pattern (build before consumer).

## Why this is a `proposal` and not an `implementation`

As of 2026-04-18, there is no regulated SINPE / BCCR / cooperative API that private software may call to settle customs duties on behalf of an importer. Until that changes, the port's value is zero. Applying the ecosystem rubric:

| Criterion | Result |
|---|:---:|
| 1. Cross-startup reuse | ⚠️ (1 consumer today: AduaNext) |
| 2. Bounded domain | ✅ (simple: one-shot payment to Hacienda, confirmed by ATENA receipt) |
| 3. Non-trivial complexity | ✅ (regulatory: SINPE protocol, BCCR settlement, Hacienda receipt format) |
| 4. Credential / regulatory isolation | ⚠️ (only meaningful if a rail exists) |
| 5. External integrations | ⚠️ (zero reachable rails today) |

Scores `≤ 3` of `5`. Below the rubric's threshold. Implementation is **deferred**.

## Re-evaluation trigger

This change moves from "deferred" to "active" when **both** conditions are met:

1. A regulated Costa Rican rail (SINPE institutional API, BCCR API, Hacienda partner API, or equivalent cooperative) becomes reachable from private software, with a documented API and a path to production credentials.
2. AduaNext's product team confirms a concrete customer flow that will use it — not "might use it someday", but a committed customer with a committed timeline.

Until both hold, the answer to "can AduaNext pay customs duties through payments-core?" remains **no**, and AduaNext's UX links out to Hacienda's own portal.

## Scope (if and when triggered)

At implementation time the scope is:

- `CustomsDutyPaymentPort` — a port with one method `payCustomsDuty(input) → result`, no state machine (one-shot).
- One adapter implementing the port against whichever rail becomes available (SINPE, BCCR, cooperative API, …).
- Events: `CustomsDutyPaid`, `CustomsDutyFailed` emitted to the bus for ATENA reconciliation via `aduanext-api`.
- Documentation in `docs/content/docs/adapters/` named after whichever rail is adopted.

The port's shape is deliberately **not specified here**. The rail dictates the shape; specifying it in advance risks bad assumptions. When triggered, a new OpenSpec change (not this one) lands the design.

## Out of scope (even when triggered)

- **Tariff calculation** — stays in `aduanext-api` (duties are calculated from the DUA line items + tariff codes).
- **Receipt storage** — Hacienda issues the receipt; AduaNext persists it in its own document store.
- **DUA state transitions** — entirely `aduanext-api`'s concern.

## Alternatives rejected

- **Implement a speculative port today** — rejected, rubric §9.
- **Wait for a hypothetical "customs-core"** — rejected. Customs flows touch payments, compliance, and customs-specific regulations; folding them into a dedicated `-core` would overlap with existing `-cores` without clear ownership.
- **Have AduaNext build a bank-bot scraper** — rejected outright. Regulatory risk, fragile, not `payments-core`'s concern.

## Acceptance (of this deferral)

1. This `proposal.md` exists and states the trigger.
2. `aduanext-integration-needs` references this stub as the owner of Flow C.
3. No `design.md` or `tasks.md` exists in this directory (deferred stubs are proposal-only).
4. No runtime code ships in this change.
5. The trigger is re-read whenever a CR government payments-API announcement lands.
