# Proposal — Ripple / XRPL adapter

## Context

The XRP Ledger (XRPL) is a public blockchain tailored for payments, with sub-second settlement and minimal fees. Documentation lives at https://xrpl.org/docs/ (TODO: verify canonical URL at implementation time). Ripple (https://ripple.com/, TODO: verify) is the primary commercial contributor and publishes SDKs + operator tooling for XRPL-based payment flows, including their **RLUSD stablecoin** issued natively on XRPL.

This change introduces an XRPL adapter that lets `payments-core` initiate, observe, and reconcile on-chain XRPL payments. It is a **long-horizon** adapter: no committed consumer has a production XRPL flow today. The adapter exists to:

1. Position `payments-core` for the MeshCommerceChain appchain direction (see §Cross-core coordination).
2. Offer an alternative rail for high-value international donations (`altrupets-api`) when a donor prefers on-chain.
3. Serve as a hedge for corridor gaps that neither Revolut, Convera, nor dLocal cover cost-effectively.

## Why this change (timing)

Long-horizon. Priority is below P0/P1/P2. The adapter lands when **one** of these triggers fires:

- A committed consumer has a concrete XRPL flow in production planning.
- MeshCommerceChain appchain architecture requires `payments-core` to speak on-chain to an appchain bridge.
- Convera's RLUSD rail becomes controllable per-request (Convera adapter forwards the flag), creating a native demand inside the ecosystem.

Until then, this proposal sits in `openspec/changes/` as a parked roadmap item.

## Scope (when implementation is triggered)

Adapter files under `src/adapters/outbound/ripple-xrpl/`:

- `xrpl-client-factory.ts` — single construction site for the `xrpl.js` library client.
- `xrpl-adapter.ts` — implements `PaymentGatewayPort` for on-chain payments. `initiate` returns a transaction hash + address; `confirm` polls ledger closure; `refund` is NOT supported on-chain (refunds require a counter-transaction, which is a separate domain concept).
- `xrpl-payout-adapter.ts` — implements `PayoutPort`. Payouts on XRPL are just on-chain transfers to the beneficiary address.
- `xrpl-ledger-watcher.ts` — subscribes to ledger-close events and maps them to domain events. Equivalent of a webhook verifier but protocol-native.
- `xrpl-reconciliation-reader.ts` — queries the ledger for transactions on a date.
- `xrpl-error-mapper.ts`.
- `xrpl-wallet-store-port.ts` — **new port** to abstract where the signing key lives (KMS, HSM, cloud vault). The default impl uses an environment-held secret in non-prod; prod deployment requires HSM or cloud KMS.

### XRPL vs custodian-held-balance

The adapter supports two modes:

- **Custodian mode** — `payments-core` holds an XRPL wallet on behalf of the consumer; funds in, funds out, internal bookkeeping. Requires HSM/KMS + PCI/AML considerations (out of `payments-core`'s scope; the consumer is responsible for KYC/AML).
- **Pass-through mode** — `payments-core` watches an address the consumer controls and emits events when funds arrive; does not hold keys. Preferred for v1 because it moves regulatory weight to the consumer.

The proposal defaults to pass-through mode. Custodian mode is an additive future scope.

## Cross-core coordination

**MeshCommerceChain appchain** (future, in planning) is a cosmos-SDK appchain for marketplace-style settlement across the ecosystem. If/when that appchain ships, `payments-core` may need an on-chain bridge. The XRPL adapter is the pattern-proof: we know how to make `payments-core` speak on-chain. When the appchain is committed, an `appchain-bridge-adapter` change will apply similar patterns (pass-through watcher, ledger-close events, wallet-store port) to the cosmos stack.

## Out of scope

- **Smart contracts on XRPL** — XRPL has limited scripting (no Turing-complete VM); smart-contract flows belong on EVM or cosmos chains.
- **Cross-chain bridges from XRPL to other chains** — not in v1; if needed, a separate adapter mediates.
- **AMM / DEX operations on XRPL** — `payments-core` is not a trading venue.
- **XRP / RLUSD custody with automatic rebalancing** — treasury operations belong outside `payments-core`.
- **Direct integration with Ripple's enterprise ODL product** — separate change if it becomes relevant; Convera's adapter is the current path for Ripple rails.

## Alternatives rejected

- **Use Convera's RLUSD flag instead of building an XRPL adapter** — partially accepted for the fiat-to-RLUSD case. Direct XRPL is needed for donors or consumers who want self-custodied on-chain flows without a cross-border gateway intermediary.
- **Build on Ethereum / Solana / Polygon first** — rejected for `payments-core` v1+. XRPL is payments-native; other chains are application-native. Other chains can be added later if an ecosystem consumer requires them.
- **Use a hosted provider (BitGo, Fireblocks, Circle) instead of xrpl.js directly** — under consideration for custodian mode. For pass-through mode, xrpl.js + public RPC is sufficient.
- **Implement now even without a committed consumer** — rejected per the rubric's §9 (construir antes de consumidor). This proposal stays deferred until a trigger fires.

## Acceptance (when implementation is triggered)

1. `src/adapters/outbound/ripple-xrpl/` implements `PaymentGatewayPort` (pass-through mode) and `PayoutPort`.
2. `XrplWalletStorePort` is declared and has at least two implementations: env-backed (dev only) and an HSM / cloud-KMS-backed (pluggable, e.g. AWS KMS, GCP KMS).
3. Ledger-close subscription runs reliably across public RPC node outages (multiple RPC endpoints with failover).
4. Integration tests run against the XRPL testnet; no real funds required for CI.
5. Documentation page `docs/content/docs/adapters/ripple.md` covers the pass-through vs custodian modes, the regulatory attribution (the consumer is the entity handling money — `payments-core` is merely the rail), and the key-management guidance.
6. Composition root wires the adapter under the `ripple_xrpl` key.
7. The adapter does not implement `SubscriptionPort`, `DonationPort`, or agentic surfaces in v1 — only the core payment-in and payout flows.
