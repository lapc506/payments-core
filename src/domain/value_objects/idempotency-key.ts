// =============================================================================
// IdempotencyKey value object
// -----------------------------------------------------------------------------
// Branded newtype wrapping a validated string. Required on every mutating
// port method (`PaymentGatewayPort.initiate`, `EscrowPort.hold`, etc.) so
// that retries by upstream callers converge on the same persisted intent.
//
// Format constraint: 8..128 characters, charset `[A-Za-z0-9_\-:]` — this is
// the same shape accepted by Stripe, OnvoPay, and Tilopay idempotency
// headers, so we can pass the key through unchanged in the outbound adapter.
// =============================================================================

import { DomainError, type Result, err, ok } from '../errors.js';

/**
 * Declaration-merged brand used to make `IdempotencyKey` incompatible with
 * bare `string` at the type level without a runtime wrapper.
 */
declare const idempotencyKeyBrand: unique symbol;
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:]{8,128}$/;

/**
 * Thrown when a candidate key fails the format check. Kept narrow; the caller
 * layer will aggregate these with other InvalidArgument issues.
 */
export class InvalidIdempotencyKeyError extends DomainError {
  constructor(candidate: string) {
    super(
      'DOMAIN_INVALID_IDEMPOTENCY_KEY',
      `Idempotency key must match ${IDEMPOTENCY_KEY_PATTERN.toString()}; got length=${candidate.length}`,
    );
    this.name = 'InvalidIdempotencyKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validates and brands a raw string. Returns Result to avoid exceptions at
 * the gRPC boundary where multiple field validations are aggregated.
 */
export function createIdempotencyKey(
  raw: string,
): Result<IdempotencyKey, InvalidIdempotencyKeyError> {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    return err(new InvalidIdempotencyKeyError(raw ?? ''));
  }
  return ok(raw as IdempotencyKey);
}

/**
 * Throw-on-invalid variant, used inside tests and in already-validated
 * factory paths.
 */
export function idempotencyKey(raw: string): IdempotencyKey {
  const r = createIdempotencyKey(raw);
  if (!r.ok) {
    throw r.error;
  }
  return r.value;
}
