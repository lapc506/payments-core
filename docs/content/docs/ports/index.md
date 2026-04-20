# Ports

Ports are the abstract seams that keep the domain isolated from providers.
Each port has one responsibility and a stable contract; adapters plug in on
the outside.

## Planned ports

- **PaymentProviderPort** — charge / authorize / capture / refund.
  (landing with `ports-payment-provider`)
- **DonationProviderPort** — donate / pledge / cancel.
  (landing with `ports-donation-provider`)
- **PayoutProviderPort** — disburse to a merchant or beneficiary.
  (landing with `ports-payout-provider`)
- **WebhookVerifierPort** — authenticate inbound webhook callbacks.
  (landing with `ports-webhook-verifier`)
- **KycPort** — identity verification hooks for high-value operations.
  (landing with `ports-kyc`)
- **OutboxPort** — durable, idempotent event publication for consumers.
  (landing with `ports-outbox`)

Every port page here will document its methods, its error taxonomy, and the
contract tests adapters must pass.

## Landed port pages

- [EscrowPort](escrow.md) — hold / release / dispute with milestone
  conditions and platform fees. Reference consumer: AduaNext.
