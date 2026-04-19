// =============================================================================
// OnvoPay error mapper
// -----------------------------------------------------------------------------
// Translates OnvoPay-specific failures (HTTP errors surfaced by `client.ts`,
// plus generic unknown errors) into `DomainError` subclasses defined in
// `src/domain/errors.ts`. Keeping the mapping here — rather than in each
// adapter method — means every port implementation benefits uniformly and the
// set of adapter-specific error codes stays in one file.
//
// The mapping is deliberately coarse; OnvoPay's documented error codes are
// not exhaustively enumerated and the response body shape is not guaranteed
// stable. We map by HTTP status class and surface the raw body inside the
// message so ops can trace the exact failure without needing adapter-local
// logging.
//
// TODO: verify OnvoPay's documented error response schema against
// https://docs.onvopay.com/#section/Referencia-API — if they publish a
// `{ code, message, doc_url }` envelope, add a thin parse step here so the
// mapped error carries the OnvoPay-side error code in a structured field.
// =============================================================================

import { DomainError, GatewayUnavailableError, IdempotencyConflictError } from '../../../../domain/errors.js';
import { OnvoPayHttpError, OnvoPayNetworkError } from './client.js';

export class OnvoPayCardDeclinedError extends DomainError {
  constructor(message: string) {
    super('ADAPTER_ONVOPAY_CARD_DECLINED', message);
    this.name = 'OnvoPayCardDeclinedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OnvoPayAuthError extends DomainError {
  constructor(message: string) {
    super('ADAPTER_ONVOPAY_AUTH', message);
    this.name = 'OnvoPayAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OnvoPayInvalidRequestError extends DomainError {
  constructor(message: string) {
    super('ADAPTER_ONVOPAY_INVALID_REQUEST', message);
    this.name = 'OnvoPayInvalidRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OnvoPayRateLimitedError extends DomainError {
  constructor(message: string) {
    super('ADAPTER_ONVOPAY_RATE_LIMITED', message);
    this.name = 'OnvoPayRateLimitedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Map a caught error into a DomainError subclass. Never throws. Always
 * returns a mapped error that the caller can re-throw.
 */
export function mapOnvoPayError(err: unknown): DomainError {
  if (err instanceof OnvoPayHttpError) {
    switch (err.status) {
      case 401:
      case 403:
        return new OnvoPayAuthError(
          `OnvoPay authentication failed (${err.status}): ${err.body}`,
        );
      case 402:
        // TODO: verify against https://docs.onvopay.com/ — OnvoPay may use
        // 400 + a specific error code instead of HTTP 402 for declines.
        return new OnvoPayCardDeclinedError(`OnvoPay card declined: ${err.body}`);
      case 409:
        return new IdempotencyConflictError(
          `OnvoPay reported idempotency conflict: ${err.body}`,
        );
      case 400:
      case 422:
        return new OnvoPayInvalidRequestError(
          `OnvoPay rejected request (${err.status}): ${err.body}`,
        );
      case 429:
        return new OnvoPayRateLimitedError(
          `OnvoPay rate limit hit: ${err.body}`,
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return new GatewayUnavailableError(
          'onvopay',
          `HTTP ${err.status}: ${err.body}`,
        );
      default:
        return new DomainError(
          'ADAPTER_ONVOPAY_UNKNOWN',
          `Unmapped OnvoPay HTTP ${err.status}: ${err.body}`,
        );
    }
  }
  if (err instanceof OnvoPayNetworkError) {
    return new GatewayUnavailableError('onvopay', err.message);
  }
  if (err instanceof DomainError) {
    // Already a domain error — pass through without double-wrapping.
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new DomainError('ADAPTER_ONVOPAY_UNKNOWN', `Unexpected OnvoPay error: ${message}`);
}
