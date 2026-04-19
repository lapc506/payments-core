// =============================================================================
// OnvoPay adapter barrel
// -----------------------------------------------------------------------------
// Single import surface for the composition root. Consumers wire the OnvoPay
// gateway into `GatewayRegistry` by importing from this file; nothing else
// should reach into individual module files.
//
// Hard constraint (enforced by ESLint `no-restricted-imports` on
// `src/adapters/outbound/gateways/onvopay/**`): no sibling adapter imports.
// This adapter depends only on:
//   - `src/domain/**`           (ports, entities, value objects, errors)
//   - Node built-ins            (`node:crypto` for HMAC, `node:http` in tests)
//   - `msw` (test-only)
// =============================================================================

export {
  OnvoPayHttpClient,
  createOnvoPayHttpClient,
  OnvoPayHttpError,
  OnvoPayNetworkError,
  type OnvoPayClientConfig,
  type OnvoPayRequest,
} from './client.js';

export {
  mapOnvoPayError,
  OnvoPayAuthError,
  OnvoPayCardDeclinedError,
  OnvoPayInvalidRequestError,
  OnvoPayRateLimitedError,
} from './errors.js';

export {
  assertOnvoPaySupportedCurrency,
  toConfirmStatus,
  toGatewayRef,
  toOnvoPayAmount,
  toSubscriptionProjection,
  toSubscriptionStatus,
  type OnvoPayCharge,
  type OnvoPayRefund,
  type OnvoPaySubscription,
  type OnvoPayWebhookEvent,
} from './mappers.js';

export { OnvoPayPaymentGateway } from './payment-gateway.js';
export { OnvoPaySubscriptionGateway } from './subscription.js';

export {
  InMemoryOnvoPayDedupeStore,
  OnvoPayWebhookVerifier,
  WebhookDuplicateEventError,
  WebhookSignatureError,
  type OnvoPayWebhookDedupeStore,
  type OnvoPayWebhookVerifierConfig,
} from './webhook-verifier.js';
