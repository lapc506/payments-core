// =============================================================================
// Stripe error mapping — Stripe SDK error classes → DomainError subclasses.
// -----------------------------------------------------------------------------
// The adapter never leaks Stripe-specific error types back to the application
// layer. Every outbound call that catches a thrown error runs it through
// `mapStripeError(...)` first, which returns a `DomainError` suitable for the
// application-layer error contract.
//
// Mapping:
//   StripeCardError                 → GATEWAY_CARD_DECLINED
//   StripeRateLimitError            → GATEWAY_RATE_LIMITED
//   StripeAuthenticationError       → GATEWAY_AUTH_FAILED (logged, not leaked)
//   StripeConnectionError           → GATEWAY_UNAVAILABLE (domain subclass)
//   StripePermissionError           → GATEWAY_AUTH_FAILED
//   StripeInvalidRequestError       → GATEWAY_INVALID_REQUEST
//   StripeIdempotencyError          → IdempotencyConflictError
//   StripeSignatureVerificationError → WebhookSignatureError
//   StripeAPIError                  → GATEWAY_INTERNAL
//   anything else                   → GATEWAY_INTERNAL (with logged context)
//
// All codes live in a single `StripeGatewayErrorCode` union so application-
// layer consumers can exhaustively switch on it.
// =============================================================================

import {
  DomainError,
  GatewayUnavailableError,
  IdempotencyConflictError,
} from '../../../../domain/index.js';
import { StripeErrors } from './client.js';

export type StripeGatewayErrorCode =
  | 'GATEWAY_CARD_DECLINED'
  | 'GATEWAY_RATE_LIMITED'
  | 'GATEWAY_AUTH_FAILED'
  | 'GATEWAY_INVALID_REQUEST'
  | 'GATEWAY_INTERNAL'
  | 'GATEWAY_WEBHOOK_SIGNATURE';

/**
 * Error thrown when Stripe's `webhooks.constructEvent(...)` rejects a
 * signature. Distinct subclass so the application layer can match it for
 * gRPC `UNAUTHENTICATED` translation.
 */
export class WebhookSignatureError extends DomainError {
  constructor(message: string) {
    super('GATEWAY_WEBHOOK_SIGNATURE', `Stripe webhook signature invalid: ${message}`);
    this.name = 'WebhookSignatureError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Generic Stripe-originated failure that does not correspond to a more
 * specific DomainError subclass. The application layer reads `code` to
 * pick a gRPC status; `stripeType` is preserved for logging only.
 */
export class StripeGatewayError extends DomainError {
  public readonly stripeType: string | undefined;
  public readonly declineCode: string | undefined;
  public readonly statusCode: number | undefined;
  public readonly requestId: string | undefined;

  constructor(
    code: StripeGatewayErrorCode,
    message: string,
    details: {
      readonly stripeType?: string;
      readonly declineCode?: string;
      readonly statusCode?: number;
      readonly requestId?: string;
    } = {},
  ) {
    super(code, message);
    this.name = 'StripeGatewayError';
    this.stripeType = details.stripeType;
    this.declineCode = details.declineCode;
    this.statusCode = details.statusCode;
    this.requestId = details.requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Normalizes any thrown value from a Stripe SDK call into a DomainError
 * subclass. The caller does `throw mapStripeError(e)`.
 */
export function mapStripeError(err: unknown): DomainError {
  // Programming errors caught earlier should not land here; re-wrap
  // non-error throwables into a StripeGatewayError with the best-effort
  // message so the caller still sees a DomainError.
  if (!(err instanceof Error)) {
    return new StripeGatewayError(
      'GATEWAY_INTERNAL',
      `Non-Error thrown from Stripe SDK: ${String(err)}`,
    );
  }

  if (err instanceof StripeErrors.StripeCardError) {
    return new StripeGatewayError(
      'GATEWAY_CARD_DECLINED',
      err.message,
      buildDetails(err.type, err.statusCode, err.requestId, err.decline_code),
    );
  }
  if (err instanceof StripeErrors.StripeRateLimitError) {
    return new StripeGatewayError(
      'GATEWAY_RATE_LIMITED',
      err.message,
      buildDetails(err.type, err.statusCode, err.requestId),
    );
  }
  if (
    err instanceof StripeErrors.StripeAuthenticationError ||
    err instanceof StripeErrors.StripePermissionError
  ) {
    return new StripeGatewayError(
      'GATEWAY_AUTH_FAILED',
      'Stripe authentication failed',
      buildDetails(err.type, err.statusCode, err.requestId),
    );
  }
  if (err instanceof StripeErrors.StripeConnectionError) {
    // Return the dedicated domain subclass — the application layer
    // already maps `GatewayUnavailableError` to gRPC `UNAVAILABLE`.
    return new GatewayUnavailableError('stripe', err.message);
  }
  if (err instanceof StripeErrors.StripeInvalidRequestError) {
    return new StripeGatewayError(
      'GATEWAY_INVALID_REQUEST',
      err.message,
      buildDetails(err.type, err.statusCode, err.requestId),
    );
  }
  if (err instanceof StripeErrors.StripeIdempotencyError) {
    // Distinct domain subclass — the application layer translates this
    // to gRPC `ALREADY_EXISTS` via existing wiring.
    return new IdempotencyConflictError(err.message);
  }
  if (err instanceof StripeErrors.StripeSignatureVerificationError) {
    return new WebhookSignatureError(err.message);
  }
  if (err instanceof StripeErrors.StripeAPIError) {
    return new StripeGatewayError(
      'GATEWAY_INTERNAL',
      `Stripe API error: ${err.message}`,
      buildDetails(err.type, err.statusCode, err.requestId),
    );
  }
  if (err instanceof StripeErrors.StripeError) {
    return new StripeGatewayError(
      'GATEWAY_INTERNAL',
      err.message,
      buildDetails(err.type, err.statusCode, err.requestId),
    );
  }
  // Any non-Stripe Error that leaked through (e.g. a raw `TypeError`).
  return new StripeGatewayError(
    'GATEWAY_INTERNAL',
    `Unexpected error from Stripe SDK: ${err.message}`,
  );
}

/**
 * Build the optional-field details record in a way that honours
 * `exactOptionalPropertyTypes: true` — only set keys whose values are
 * actually defined.
 */
function buildDetails(
  stripeType: string,
  statusCode: number | undefined,
  requestId: string | undefined,
  declineCode?: string,
): ConstructorParameters<typeof StripeGatewayError>[2] {
  const out: Mutable<NonNullable<ConstructorParameters<typeof StripeGatewayError>[2]>> = {
    stripeType,
  };
  if (statusCode !== undefined) out.statusCode = statusCode;
  if (requestId !== undefined) out.requestId = requestId;
  if (declineCode !== undefined) out.declineCode = declineCode;
  return out;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
