// =============================================================================
// Stripe ↔ domain mappers.
// -----------------------------------------------------------------------------
// Single translation point between Stripe SDK shapes and the domain value
// objects / port result types. No other file in the adapter performs this
// translation; leaking Stripe-specific fields outside the adapter violates
// the hexagonal boundary.
//
// Key translations:
//   - Money ↔ Stripe amounts. Domain carries `bigint`, Stripe's TS types
//     carry `number` (cents). We cast with an explicit guard against
//     Number.MAX_SAFE_INTEGER to keep precision safe for any realistic
//     transaction (see `design.md` §stripe-adapter.ts shape).
//   - Subscription status enum. Stripe has more granular statuses
//     (`incomplete_expired`, `unpaid`, `trialing`, `paused`) — we collapse
//     them onto the five-state domain enum.
//   - Payment intent status → `ConfirmPaymentResult.status`.
//   - Generic metadata object: Stripe types `Metadata` as
//     `{[k: string]: string}` which matches our domain's
//     `Readonly<Record<string, string>>`. Passed through unchanged.
// =============================================================================

import type { GatewayName, GatewayRef, Money, Subscription } from '../../../../domain/index.js';
import { createGatewayRef, createThreeDSChallenge } from '../../../../domain/index.js';
import type {
  StripePaymentIntent,
  StripePaymentIntentStatus,
  StripeRefund,
  StripeSubscriptionStatus,
} from './client.js';

const STRIPE: GatewayName = 'stripe';
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Convert a domain `Money` amount to the Stripe SDK's expected `number`
 * (minor units; Stripe treats amounts as integers in cents). Guards against
 * exceeding `Number.MAX_SAFE_INTEGER` so we never silently lose precision.
 */
export function moneyToStripeAmount(amount: Money): number {
  if (amount.amountMinor > MAX_SAFE_BIGINT) {
    throw new RangeError(
      `Stripe adapter refuses amounts over Number.MAX_SAFE_INTEGER (${MAX_SAFE_BIGINT}); got ${amount.amountMinor}.`,
    );
  }
  if (amount.amountMinor < 0n) {
    throw new RangeError(`Stripe adapter refuses negative amounts; got ${amount.amountMinor}.`);
  }
  return Number(amount.amountMinor);
}

/**
 * Stripe currency codes are lowercase three-letter ISO 4217 strings.
 */
export function currencyToStripe(currency: string): string {
  return currency.toLowerCase();
}

/**
 * Construct a domain `GatewayRef` pointing at Stripe.
 */
export function stripeRef(externalId: string): GatewayRef {
  const r = createGatewayRef(STRIPE, externalId);
  if (!r.ok) throw r.error;
  return r.value;
}

/**
 * Produces an opaque `ThreeDSChallenge` when the PaymentIntent requires one.
 * The payload is the Stripe `client_secret` — the caller (frontend SDK)
 * uses it to complete the 3DS step-up via `confirmCardPayment`.
 */
export function threeDsChallengeFromIntent(
  intent: StripePaymentIntent,
): ReturnType<typeof createThreeDSChallenge> {
  const secret = intent.client_secret ?? '';
  return createThreeDSChallenge(intent.id, new TextEncoder().encode(secret));
}

/**
 * Map a Stripe subscription status onto the five-state domain enum.
 */
export function mapSubscriptionStatus(
  status: StripeSubscriptionStatus,
): Subscription['status'] {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    default: {
      // Exhaustiveness guard for future Stripe additions.
      const _exhaustive: never = status;
      void _exhaustive;
      return 'canceled';
    }
  }
}

/**
 * Map a Stripe PaymentIntent status onto the `ConfirmPaymentResult` status.
 */
export function mapPaymentIntentStatus(
  status: StripePaymentIntentStatus,
): 'succeeded' | 'failed' | 'requires_action' {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
    case 'requires_capture':
    case 'processing':
      return 'requires_action';
    case 'canceled':
      return 'failed';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 'failed';
    }
  }
}

/**
 * Map a Stripe Refund status onto the port's `succeeded | failed` shape.
 * Stripe's `pending` status is rolled up as `succeeded` (refund request
 * accepted; final confirmation lands via webhook).
 */
export function mapRefundStatus(status: StripeRefund['status']): 'succeeded' | 'failed' {
  if (status === 'succeeded' || status === 'pending') return 'succeeded';
  return 'failed';
}

/**
 * Convert a domain metadata record into the `Record<string, string>` shape
 * Stripe expects. Stripe caps metadata at 50 keys with 500-char values; we
 * pass through unchanged and let the SDK surface the validation error.
 */
export function toStripeMetadata(
  metadata: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...metadata, ...extra };
}
