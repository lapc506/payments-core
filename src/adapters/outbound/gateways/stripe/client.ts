// =============================================================================
// Stripe client factory — DOJ-3287 pattern.
// -----------------------------------------------------------------------------
// This is the ONLY file in the repo that imports the `stripe` package. Every
// other adapter file imports the SDK types and the constructed client through
// this module. An ESLint `no-restricted-imports` rule (see `eslint.config.js`)
// enforces that constraint.
//
// Why a factory:
//   1. DOJ-3287 — sibling `dojo-os` had a production regression when
//      Dependabot silently upgraded the Stripe SDK across edge functions that
//      each instantiated `new Stripe(...)` directly. The fix centralised
//      instantiation in `_shared/payments-core/stripe-client.ts`. We inherit
//      that lesson.
//   2. Exact SDK pin — `stripe@18.5.0` with the matching `STRIPE_API_VERSION`
//      below is the single source of truth. Bumping either is its own
//      OpenSpec change.
//   3. No top-level side effects — env reads happen inside the factory call.
//      Tests construct the client with a stub `secretKey` and a mocked
//      transport; production wires it from validated env.
//
// Consumer-facing contract:
//   `getStripeClient(secretKey, apiVersion?)` returns a ready-to-use client.
//   `createStripeClient(config)` is the rich variant with retry / timeout /
//   appInfo knobs for the composition root.
// =============================================================================

import Stripe from 'stripe';

/**
 * The Stripe API version this adapter was authored against. Matched to SDK
 * `18.5.0`'s `Stripe.LatestApiVersion` at the time of writing. Upgrading is a
 * deliberate action (new OpenSpec change) — do not drift this to track the
 * SDK's latest constant automatically.
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-08-27.basil';

/**
 * The exact SDK version this adapter is pinned against. Cross-checked by the
 * `package.json` entry `"stripe": "18.5.0"` — drift between the two should be
 * caught by a CI step or a code review.
 */
export const STRIPE_SDK_VERSION = '18.5.0' as const;

export interface StripeClientConfig {
  /** `sk_live_*` or `sk_test_*` — validated at the composition root. */
  readonly secretKey: string;
  /** Defaults to STRIPE_API_VERSION above. Override only if you know why. */
  readonly apiVersion?: Stripe.LatestApiVersion;
  /** Stripe SDK retry count. Default 2 — the adapter does not retry itself. */
  readonly maxNetworkRetries?: number;
  /** Request timeout in ms. Default 15_000 (Stripe SDK default is 80_000). */
  readonly timeoutMs?: number;
  /** App info surfaced on Stripe's dashboard request log. */
  readonly appInfo?: Stripe.AppInfo;
  /**
   * Optional override used by tests. Production code never sets this.
   * `stripe-mock` exposes itself on a local host:port; tests wire it through.
   */
  readonly host?: string;
  readonly port?: number;
  readonly protocol?: 'http' | 'https';
}

/**
 * Rich factory — the composition root uses this to pass retry / timeout /
 * appInfo. Equivalent to `getStripeClient` for simple callers.
 *
 * This is the single `new Stripe(...)` call in the repo.
 */
export function createStripeClient(config: StripeClientConfig): Stripe {
  if (
    typeof config.secretKey !== 'string' ||
    config.secretKey.length === 0
  ) {
    throw new Error('createStripeClient: secretKey must be a non-empty string');
  }
  const options: Stripe.StripeConfig = {
    apiVersion: config.apiVersion ?? STRIPE_API_VERSION,
    maxNetworkRetries: config.maxNetworkRetries ?? 2,
    timeout: config.timeoutMs ?? 15_000,
    ...(config.appInfo !== undefined ? { appInfo: config.appInfo } : {}),
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.protocol !== undefined ? { protocol: config.protocol } : {}),
  };
  // This is the ONE allowed `new Stripe(...)` call site in the repo.
  // The `no-restricted-syntax` rule in `eslint.config.js` exempts this file;
  // any other file constructing Stripe trips the rule.
  return new Stripe(config.secretKey, options);
}

/**
 * Convenience factory for the common case where defaults are fine.
 */
export function getStripeClient(
  secretKey: string,
  apiVersion: Stripe.LatestApiVersion = STRIPE_API_VERSION,
): Stripe {
  return createStripeClient({ secretKey, apiVersion });
}

/**
 * Re-exports of narrow Stripe SDK types we pass around inside the adapter.
 * Every other file in the adapter imports these from `./client.js` — never
 * from `stripe` directly. The ESLint guard enforces this.
 */
export type StripeClient = Stripe;
export type StripeRawError = Stripe.StripeRawError;
export type StripePaymentIntent = Stripe.PaymentIntent;
export type StripePaymentIntentStatus = Stripe.PaymentIntent.Status;
export type StripeRefund = Stripe.Refund;
export type StripeSubscription = Stripe.Subscription;
export type StripeSubscriptionStatus = Stripe.Subscription.Status;
export type StripeCheckoutSession = Stripe.Checkout.Session;
export type StripeEvent = Stripe.Event;
export type StripeInvoice = Stripe.Invoice;
export type StripeRequestOptions = Stripe.RequestOptions;

/**
 * Error class references. Kept as a namespace export so callers can use
 * `if (e instanceof StripeErrors.StripeCardError)` without pulling `Stripe`
 * into their import graph.
 */
export const StripeErrors = Stripe.errors;
