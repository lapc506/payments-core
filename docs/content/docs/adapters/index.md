# Adapters

Concrete integrations that implement one or more ports. Adapters are the only
code that talks to a real provider SDK, a real HTTP endpoint, or a real
blockchain. Swapping one adapter for another must never require touching the
domain or application layers.

## Planned adapters

- **Stripe** — cards + wallets, payments + donations. (landing with
  `stripe-adapter-p0`)
- **OnvoPay** — Costa Rica card acquirer. (landing with `onvopay-adapter-p0`)
- **TiloPay** — LATAM card + SINPE Móvil. (landing with `tilopay-adapter-p1`)
- **dLocal** — LATAM cross-border. (landing with `dlocal-adapter-p2`)
- **Revolut Business** — multi-currency payouts + FX. (landing with
  `revolut-adapter`)
- **Convera** — global corporate FX & payments. (landing with
  `convera-adapter`)
- **Ripple / XRPL** — on-ledger settlement. (landing with
  `ripple-xrpl-adapter`)
- **Apple Pay / Google Pay verification** — token validation before charge.
  (landing with `apple-google-verify-p2`)

Each adapter page will document: supported operations, credentials required,
sandbox/production flags, error-to-domain mapping, and the idempotency
strategy.
