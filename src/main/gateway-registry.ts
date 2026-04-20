// =============================================================================
// Gateway registry — composition-root helpers.
// -----------------------------------------------------------------------------
// Turns env-sourced credentials into a set of ready-to-use outbound adapters,
// keyed by `GatewayName`. The composition root (`src/main.ts`) wires these
// into the use-case factories; adapters without real implementations yet
// (`EscrowPort`, `PayoutPort`, …) keep their stub fallbacks there.
//
// Design choices:
//   - An adapter is only registered when its env vars are present. A missing
//     key means the sidecar still boots; requests for that specific gateway
//     surface `GatewayUnavailableError('<name>', 'not configured')` and map
//     to gRPC `UNAVAILABLE`. Dev environments without real secrets keep
//     working.
//   - Each port has its own registry map. A caller can legitimately want
//     Stripe for payments but reuse the shared `IdempotencyPort` for webhook
//     dedupe on both gateways. Splitting avoids a single giant factory.
//   - No fallbacks between gateways. An explicit `stripe` request never
//     silently routes to `onvopay` and vice versa.
// =============================================================================

import {
  type GatewayName,
  type IdempotencyPort,
  type PaymentGatewayPort,
  type SubscriptionPort,
  type WebhookVerifierPort,
} from '../domain/index.js';
import {
  OnvoPayPaymentGateway,
  OnvoPaySubscriptionGateway,
  OnvoPayWebhookVerifier,
  InMemoryOnvoPayDedupeStore,
  createOnvoPayHttpClient,
} from '../adapters/outbound/gateways/onvopay/index.js';
import {
  StripePaymentGateway,
  StripeSubscriptionAdapter,
  StripeWebhookVerifier,
  createStripeClient,
} from '../adapters/outbound/gateways/stripe/index.js';

/**
 * Subset of the process env relevant to outbound-adapter construction. The
 * composition root parses `process.env` once, validates required pieces, and
 * hands a frozen copy to the registry builders. Tests construct this shape
 * directly to avoid mutating `process.env`.
 */
export interface AdapterEnv {
  readonly stripeSecretKey?: string;
  readonly stripeWebhookSigningSecret?: string;
  readonly onvopayApiKey?: string;
  readonly onvopayApiBaseUrl?: string;
  readonly onvopayWebhookSigningSecret?: string;
}

/**
 * Build the `PaymentGatewayPort` registry. Only adapters whose env vars are
 * present are registered. An empty map is a valid outcome — it means every
 * real payment gateway will return `UNAVAILABLE` until secrets are supplied.
 */
export function buildPaymentGatewayRegistry(
  env: AdapterEnv,
): Map<GatewayName, PaymentGatewayPort> {
  const map = new Map<GatewayName, PaymentGatewayPort>();

  if (typeof env.stripeSecretKey === 'string' && env.stripeSecretKey.length > 0) {
    const client = createStripeClient({ secretKey: env.stripeSecretKey });
    map.set('stripe', new StripePaymentGateway({ client }));
  }

  if (
    typeof env.onvopayApiKey === 'string' &&
    env.onvopayApiKey.length > 0 &&
    typeof env.onvopayApiBaseUrl === 'string' &&
    env.onvopayApiBaseUrl.length > 0
  ) {
    const http = createOnvoPayHttpClient({
      apiKey: env.onvopayApiKey,
      apiBaseUrl: env.onvopayApiBaseUrl,
    });
    map.set('onvopay', new OnvoPayPaymentGateway(http));
  }

  return map;
}

/**
 * Build the `SubscriptionPort` registry. Same contract as the payment-gateway
 * builder — only adapters with env keys land in the map.
 */
export function buildSubscriptionPortRegistry(
  env: AdapterEnv,
): Map<GatewayName, SubscriptionPort> {
  const map = new Map<GatewayName, SubscriptionPort>();

  if (typeof env.stripeSecretKey === 'string' && env.stripeSecretKey.length > 0) {
    const client = createStripeClient({ secretKey: env.stripeSecretKey });
    map.set('stripe', new StripeSubscriptionAdapter({ client }));
  }

  if (
    typeof env.onvopayApiKey === 'string' &&
    env.onvopayApiKey.length > 0 &&
    typeof env.onvopayApiBaseUrl === 'string' &&
    env.onvopayApiBaseUrl.length > 0
  ) {
    const http = createOnvoPayHttpClient({
      apiKey: env.onvopayApiKey,
      apiBaseUrl: env.onvopayApiBaseUrl,
    });
    map.set('onvopay', new OnvoPaySubscriptionGateway(http));
  }

  return map;
}

/**
 * Build the `WebhookVerifierPort` registry. Requires the matching signing
 * secret as well as the API key — a verifier without its signing secret has
 * no way to validate payloads.
 *
 * Stripe's verifier reuses the application-layer `IdempotencyPort` for
 * duplicate-event detection until a dedicated `WebhookEventRepositoryPort`
 * lands. OnvoPay's verifier ships with its own in-memory dedupe store — a
 * multi-process deployment should swap that for Redis/Postgres later.
 */
export function buildWebhookVerifierRegistry(
  env: AdapterEnv,
  idempotency: IdempotencyPort,
): Map<GatewayName, WebhookVerifierPort> {
  const map = new Map<GatewayName, WebhookVerifierPort>();

  if (
    typeof env.stripeSecretKey === 'string' &&
    env.stripeSecretKey.length > 0 &&
    typeof env.stripeWebhookSigningSecret === 'string' &&
    env.stripeWebhookSigningSecret.length > 0
  ) {
    const client = createStripeClient({ secretKey: env.stripeSecretKey });
    map.set(
      'stripe',
      new StripeWebhookVerifier({
        client,
        signingSecret: env.stripeWebhookSigningSecret,
        idempotency,
      }),
    );
  }

  if (
    typeof env.onvopayWebhookSigningSecret === 'string' &&
    env.onvopayWebhookSigningSecret.length > 0
  ) {
    map.set(
      'onvopay',
      new OnvoPayWebhookVerifier({
        signingSecret: env.onvopayWebhookSigningSecret,
        dedupe: new InMemoryOnvoPayDedupeStore(),
      }),
    );
  }

  return map;
}

/**
 * Dispatcher factory — returns a resolver that honors the registry contract:
 * present → real adapter; absent → stub that raises `GatewayUnavailableError`.
 *
 * Callers pass a `stubFactory` so the caller decides whether an unconfigured
 * slot is a fatal error (production) or a predictable `UNAVAILABLE` response
 * (local dev). The stub factory receives the requested `GatewayName` so the
 * resulting error message can be specific.
 */
export function makeResolver<P>(
  registry: ReadonlyMap<GatewayName, P>,
  stubFactory: (gateway: GatewayName) => P,
): (gateway: GatewayName) => P {
  return (gateway: GatewayName): P => {
    const adapter = registry.get(gateway);
    if (adapter !== undefined) return adapter;
    return stubFactory(gateway);
  };
}
