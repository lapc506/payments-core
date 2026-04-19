// =============================================================================
// Domain errors + Result type
// -----------------------------------------------------------------------------
// The domain never throws bare `Error`. Every throw site uses one of the
// subclasses declared here so the application layer can map errors to gRPC
// status codes in `src/adapters/inbound/grpc/translators.ts` (landing with
// `grpc-server-inbound`).
//
// `Result<T, E>` is the recommended shape for factory-style constructors that
// can fail without throwing — cheap, ergonomic, composable, and does not mix
// Promise rejection with validation. Entities still throw on invalid
// transitions (state-machine violations are programming errors, not user
// errors), but constructors that validate user-supplied values prefer Result.
// =============================================================================

/**
 * Base class for every error originating inside the domain layer.
 *
 * Subclasses MUST set a stable `code` string used by the inbound-gRPC
 * translator to pick a `status.Code`. Do not localize messages at this
 * layer — that is the caller's responsibility.
 */
export class DomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    // Preserve proper prototype chain when the code is compiled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a state machine receives a transition that is illegal from the
 * current status. Programming error, not user error — translators map this to
 * gRPC `FAILED_PRECONDITION`.
 */
export class InvalidStateTransitionError extends DomainError {
  public readonly from: string;
  public readonly allowed: readonly string[];

  constructor(from: string, allowed: readonly string[]) {
    super(
      'DOMAIN_INVALID_STATE_TRANSITION',
      `Invalid transition from '${from}'. Allowed source states: [${allowed.join(
        ', ',
      )}].`,
    );
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.allowed = allowed;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `Money` when a caller constructs an instance with a negative
 * amount or a currency that is not a three-letter ISO-4217 code. Translators
 * map this to gRPC `INVALID_ARGUMENT`.
 */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('DOMAIN_INVALID_MONEY', message);
    this.name = 'InvalidMoneyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when two `Money` values with different currencies are combined.
 * Subclass of InvalidMoneyError so callers can catch either.
 */
export class CurrencyMismatchError extends InvalidMoneyError {
  public readonly left: string;
  public readonly right: string;

  constructor(left: string, right: string) {
    super(`Currency mismatch: '${left}' vs '${right}'.`);
    this.name = 'CurrencyMismatchError';
    this.left = left;
    this.right = right;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `IdempotencyStorePort` implementations when the same idempotency
 * key is reused with a different request body. Translators map this to gRPC
 * `ALREADY_EXISTS`.
 */
export class IdempotencyConflictError extends DomainError {
  public readonly key: string;

  constructor(key: string) {
    super(
      'DOMAIN_IDEMPOTENCY_CONFLICT',
      `Idempotency key '${key}' has already been used with a different request body.`,
    );
    this.name = 'IdempotencyConflictError';
    this.key = key;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a gateway is unavailable (circuit open, outage declared, or
 * capability not implemented). Translators map this to gRPC `UNAVAILABLE`.
 */
export class GatewayUnavailableError extends DomainError {
  public readonly gateway: string;

  constructor(gateway: string, reason: string) {
    super(
      'DOMAIN_GATEWAY_UNAVAILABLE',
      `Gateway '${gateway}' unavailable: ${reason}`,
    );
    this.name = 'GatewayUnavailableError';
    this.gateway = gateway;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an Escrow operation is attempted while the escrow is in
 * `disputed` status. Translators map this to gRPC `FAILED_PRECONDITION`.
 */
export class DisputeOngoingError extends DomainError {
  constructor(escrowId: string) {
    super(
      'DOMAIN_DISPUTE_ONGOING',
      `Escrow '${escrowId}' has an ongoing dispute; operation rejected.`,
    );
    this.name = 'DisputeOngoingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Result<T, E>
// ---------------------------------------------------------------------------

/**
 * Minimal Result type. Chosen over throw-based validation inside factories
 * because it composes cleanly without try/catch and does not mask exceptions
 * from genuinely unexpected runtime errors.
 *
 * Consumers pattern-match on `.ok`:
 *
 *   const r = Money.of(1234n, 'USD');
 *   if (!r.ok) { return handleError(r.error); }
 *   const money = r.value;
 */
export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
