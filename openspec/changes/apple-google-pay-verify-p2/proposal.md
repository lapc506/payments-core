# Proposal — Apple Pay / Google Pay server-side token verification (P2)

## Context

When a mobile consumer app uses Apple Pay or Google Pay, the device produces an **encrypted payment token** representing the user's card. That token is forwarded to a backend, which verifies + decrypts it and presents the resulting card credentials (or a tokenized reference) to a gateway for charging. In the `payments-core` boundary:

- **Client-side SDK work** — the frontend uses `flutter_stripe`, `@stripe/stripe-js`, or equivalent mobile SDKs to produce the token. This is **out of `payments-core`'s scope**.
- **Server-side token handling** — `payments-core` receives the opaque token via `ConfirmCheckoutRequest.wallet_token` (already declared in `proto-contract-v1`) and forwards it to the selected gateway's verify/decrypt endpoint.

The primary consumer is `dojo-os` mobile (iOS + Android). Their app ships wallet checkout as a native UX; the server needs to verify the payment succeeded without accepting an unverified device-produced blob.

## Why P2

Stripe P0 already handles the Apple Pay / Google Pay case when the token is attached to a Stripe `PaymentMethod` on the client side — Stripe's SDK wraps verification transparently. The P2 scope here is the **direct-verification** path for cases where:

- The consumer routes the wallet token to a non-Stripe gateway (e.g. OnvoPay) that does not natively ingest Apple Pay payloads.
- The consumer wants a gateway-agnostic audit of what the device certified, for fraud-analysis reasons, before dispatching to whichever gateway's processing flow.

Both are niche today; dojo-os's v1 mobile flow uses Stripe's native integration. Hence P2.

## Scope

### Server-side verifiers

Under `src/adapters/outbound/wallet/`:

- `apple-pay-verifier.ts` — verifies the Apple Pay payload:
  - Parses the PKPaymentToken JSON.
  - Validates the payload's `signature` against Apple's PKI root (TODO: verify Apple's published cert chain for 2026).
  - Decrypts the `paymentData` using the merchant's identity certificate + private key.
  - Returns the decrypted DPAN + expiry + metadata.
- `google-pay-verifier.ts` — verifies the Google Pay payload:
  - Parses the PaymentMethodTokenizationData.
  - Verifies the intermediate signing key against Google's published JWKS (TODO: verify canonical URL).
  - Decrypts the inner payload.
  - Returns the decrypted DPAN or the Google-tokenized card reference.

### Integration into ConfirmCheckout

The `ConfirmCheckout` use case, when it receives a `wallet_token`, delegates to the verifier for the token's `provider`. On success, it hands the decrypted payment credentials to the selected gateway's confirm step. Gateways that already handle the wallet token natively (Stripe) bypass the verifier.

### PCI scope

Direct verification + decryption places `payments-core` **inside PCI SAQ D** scope for the flow that uses it. This change documents the scope change explicitly and adds deployment guidance (HSM for the merchant private key, logging-redaction rules, DPAN retention limits). Consumers who cannot accept SAQ D scope route wallet payments exclusively through Stripe (which handles verification inside its own scope).

## Explicitly out of scope

- **Client-side SDK code** — `flutter_stripe`, `react-native-payments`, `@stripe/stripe-js` — lives in frontend repos.
- **Merchant certificate issuance** — consumer apps request their own Apple Merchant IDs and Google Pay tokenization configs.
- **Google Pay DIRECT protocol with PSP network tokens** — the Stripe path covers this; direct-verification is only for cases where the consumer explicitly wants raw decryption.
- **Samsung Pay, WeChat Pay, etc.** — not planned. `WalletToken.Provider` enum in the proto has `APPLE_PAY` and `GOOGLE_PAY` only in v1.

## Alternatives rejected

- **Always route wallet tokens through Stripe** — rejected; removes the gateway-agnostic option for consumers that need it.
- **Never implement direct verification; require all wallet flows to use Stripe** — partially correct. In v1 this is the de facto state; the P2 change exists as a documented path for when a consumer has a valid reason to opt out of it.
- **Run verification in a separate sidecar** — rejected. Adds operational complexity without reducing PCI scope meaningfully; the sidecar would have the same merchant private key.
- **Store decrypted DPANs for reuse** — **rejected outright**. Decrypted DPANs are used once per transaction and never persisted. Reuse requires network-tokenization flows (Stripe handles this).

## Acceptance

1. `src/adapters/outbound/wallet/` implements `AppleWalletVerifierPort` and `GoogleWalletVerifierPort`.
2. Signature-chain validation uses the currently-published Apple / Google roots; the certificate paths are loaded at startup from an env-configured directory.
3. Fixture tests cover a valid Apple Pay payload + a tampered one (from Apple's published test fixtures) and the same for Google Pay.
4. `ConfirmCheckout` wires the verifier for non-Stripe gateways; Stripe bypass is unit-tested.
5. Decrypted DPANs never appear in any log line. Enforced by a log-redaction test.
6. `docs/content/docs/adapters/apple-google-pay.md` documents the PCI SAQ D implication and the HSM deployment guidance.
7. `docs/content/docs/security/index.md` updated with the DPAN-handling rules.
