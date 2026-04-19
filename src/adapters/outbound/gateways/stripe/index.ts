// =============================================================================
// Stripe adapter barrel.
// -----------------------------------------------------------------------------
// Public surface of `src/adapters/outbound/gateways/stripe/`. The composition
// root (landing with the gRPC inbound change on issue #19) imports from here
// to wire Stripe implementations into the `GatewayRegistry`.
//
// Nothing outside this directory imports `stripe` directly; `./client.js`
// is the only file that does.
// =============================================================================

export {
  STRIPE_API_VERSION,
  STRIPE_SDK_VERSION,
  createStripeClient,
  getStripeClient,
} from './client.js';
export type {
  StripeCheckoutSession,
  StripeClient,
  StripeClientConfig,
  StripeEvent,
  StripeInvoice,
  StripePaymentIntent,
  StripeRawError,
  StripeRefund,
  StripeRequestOptions,
  StripeSubscription,
} from './client.js';

export {
  StripeGatewayError,
  WebhookSignatureError,
  mapStripeError,
} from './errors.js';
export type { StripeGatewayErrorCode } from './errors.js';

export {
  currencyToStripe,
  mapPaymentIntentStatus,
  mapRefundStatus,
  mapSubscriptionStatus,
  moneyToStripeAmount,
  stripeRef,
  threeDsChallengeFromIntent,
  toStripeMetadata,
} from './mappers.js';

export { StripePaymentGateway } from './payment-gateway.js';
export type { StripePaymentGatewayDeps } from './payment-gateway.js';

export {
  STRIPE_CUSTOMER_ID_METADATA_KEY,
  StripeSubscriptionAdapter,
} from './subscription.js';
export type { StripeSubscriptionAdapterDeps } from './subscription.js';

export { StripeWebhookVerifier } from './webhook-verifier.js';
export type { StripeWebhookVerifierDeps } from './webhook-verifier.js';
