# Proposal — CustomsBondPort (deferred)

## Context

Some import regimes under Costa Rican customs law (régimen de importación temporal, régimen de depósito fiscal / customs warehouse) require the importer to post a **bond (garantía aduanera)** while goods are in transit or in a customs warehouse. The bond is held by a regulated bond issuer — typically a Costa Rican insurance company — and released when the regime terminates (goods re-exported, duties paid, warehouse period expires).

`aduanext-integration-needs` identified this as Flow D and explicitly deferred it: Costa Rican bond issuers do not currently expose an API that private software may call to request, post, or release bonds.

## Why this is a `proposal` and not an `implementation`

Applying the rubric:

| Criterion | Result |
|---|:---:|
| 1. Cross-startup reuse | ⚠️ (1 consumer: AduaNext) |
| 2. Bounded domain | ✅ (narrow: bond lifecycle is well-defined) |
| 3. Non-trivial complexity | ✅ (multi-party: issuer, importer, Hacienda) |
| 4. Credential / regulatory isolation | ⚠️ (only if issuer API exists) |
| 5. External integrations | ⚠️ (zero reachable issuer APIs today) |

Scores `≤ 3` of `5`. Below the threshold. Implementation **deferred**.

## Re-evaluation trigger

This change moves from "deferred" to "active" when **both** conditions are met:

1. At least one Costa Rican regulated bond issuer (insurance company or equivalent) publishes a developer-reachable API for bond issuance, status, and release.
2. At least one AduaNext customer is actively using temporary-admission or customs-warehouse regimes at sufficient volume to justify integration (committed customer, committed timeline — not hypothetical).

Until both hold, AduaNext surfaces bond requirements as out-of-band workflows (links to issuer portals, manual receipt upload) and `payments-core` is silent on bonds.

## Scope (if and when triggered)

At implementation time:

- `CustomsBondPort` — port with methods: `requestBond`, `getBondStatus`, `releaseBond`.
- State machine on the `Bond` entity: `requested → issued → active → released | forfeited | expired`.
- One adapter per participating bond issuer.
- Events: `BondIssued`, `BondReleased`, `BondForfeited` on the bus for ATENA reconciliation via `aduanext-api`.
- Documentation under `docs/content/docs/adapters/` per the first issuer that adopts the API.

### Relationship to `EscrowPort`

Bonds are conceptually similar to escrow (funds held on a condition), but the counterparty model differs:

- **Escrow**: payer, payee, platform holds funds.
- **Bond**: importer, Hacienda (beneficiary on default), issuer (guarantor). Funds (or a premium thereof) flow to the issuer; the issuer's obligation to Hacienda is the real contract.

For this reason, bonds get a dedicated port rather than riding on `EscrowPort`. The shape overlaps but the parties and the default handling are different.

## Out of scope (even when triggered)

- **Underwriting risk assessment** — lives with the bond issuer.
- **Bond premium calculation** — lives with the issuer or with AduaNext's quoting module.
- **Re-exportation verification** — AduaNext's domain, not `payments-core`'s.

## Alternatives rejected

- **Model bonds as a variant of Escrow** — rejected per the counterparty discussion above.
- **Require AduaNext to handle bonds entirely out of band** — acceptable today (and is the current state), but not forever: when an issuer API appears, integrating it is the right move.
- **Build speculatively without a reachable issuer** — rejected, rubric §9.

## Acceptance (of this deferral)

1. This `proposal.md` exists and states the trigger.
2. `aduanext-integration-needs` references this stub as the owner of Flow D.
3. No `design.md` or `tasks.md` in this directory; proposal-only until triggered.
4. No runtime code ships.
5. The trigger is re-read whenever a CR insurance-industry API announcement surfaces.
