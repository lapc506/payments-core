// =============================================================================
// Domain DomainError → gRPC status translator.
// -----------------------------------------------------------------------------
// Maps every domain error subclass onto the canonical gRPC status code per
// `design.md`. Internal / unknown errors become `INTERNAL` with a generic
// message — the server-side log carries the full detail under the caller's
// request id.
//
// The handler layer is the only caller. If a handler catches a `DomainError`
// (or a Result<_, DomainError>.error), it feeds it through `toGrpcError` to
// build the `ServiceError` object that `callback(err, null)` expects.
// =============================================================================

import * as grpc from '@grpc/grpc-js';

import {
  CurrencyMismatchError,
  DisputeOngoingError,
  DomainError,
  GatewayUnavailableError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidStateTransitionError,
} from '../../../domain/index.js';
import { InvalidEnumMappingError } from './mappers/entities.js';

export interface GrpcError extends grpc.ServiceError {
  readonly code: grpc.status;
  readonly details: string;
  readonly metadata: grpc.Metadata;
}

/**
 * Build a `ServiceError` shape that `@grpc/grpc-js` callbacks consume. The
 * metadata slot is always present; callers can attach a request id or
 * domain code there for observability.
 */
function buildError(
  code: grpc.status,
  details: string,
  domainCode?: string,
): GrpcError {
  const metadata = new grpc.Metadata();
  if (domainCode !== undefined) {
    metadata.add('x-domain-code', domainCode);
  }
  const err = new Error(details) as GrpcError;
  Object.assign(err, {
    code,
    details,
    metadata,
  });
  return err;
}

/**
 * Primary translator. Follows the table from the user-facing brief:
 *
 *   GatewayUnavailableError       → UNAVAILABLE
 *   InvalidStateTransitionError   → FAILED_PRECONDITION
 *   DisputeOngoingError           → FAILED_PRECONDITION
 *   InvalidMoneyError             → INVALID_ARGUMENT
 *   CurrencyMismatchError         → INVALID_ARGUMENT
 *   IdempotencyConflictError      → ALREADY_EXISTS
 *   InvalidEnumMappingError       → INVALID_ARGUMENT
 *   every other DomainError       → INTERNAL (message is generic)
 *   non-DomainError                → INTERNAL (message is generic)
 */
export function toGrpcError(err: unknown): GrpcError {
  if (err instanceof GatewayUnavailableError) {
    return buildError(grpc.status.UNAVAILABLE, err.message, err.code);
  }
  if (err instanceof InvalidStateTransitionError) {
    return buildError(grpc.status.FAILED_PRECONDITION, err.message, err.code);
  }
  if (err instanceof DisputeOngoingError) {
    return buildError(grpc.status.FAILED_PRECONDITION, err.message, err.code);
  }
  if (err instanceof CurrencyMismatchError) {
    // Subclass of InvalidMoneyError — check first to preserve the more
    // specific domain code on the metadata channel.
    return buildError(grpc.status.INVALID_ARGUMENT, err.message, err.code);
  }
  if (err instanceof InvalidMoneyError) {
    return buildError(grpc.status.INVALID_ARGUMENT, err.message, err.code);
  }
  if (err instanceof IdempotencyConflictError) {
    return buildError(grpc.status.ALREADY_EXISTS, err.message, err.code);
  }
  if (err instanceof InvalidEnumMappingError) {
    return buildError(grpc.status.INVALID_ARGUMENT, err.message, err.code);
  }
  if (err instanceof DomainError) {
    // Catch-all for every other DomainError subclass. We still pass the
    // `.code` through the metadata channel for debugging; the user-facing
    // message is scrubbed to avoid leaking implementation details.
    return buildError(grpc.status.INTERNAL, 'internal error', err.code);
  }
  return buildError(grpc.status.INTERNAL, 'internal error');
}

/**
 * Convenience for handlers that need to surface a plain INVALID_ARGUMENT
 * (bad field, missing idempotency key, etc.) without building a DomainError.
 */
export function invalidArgument(details: string): GrpcError {
  return buildError(grpc.status.INVALID_ARGUMENT, details);
}

/**
 * Convenience for handlers that need to surface UNAUTHENTICATED directly.
 */
export function unauthenticated(details: string): GrpcError {
  return buildError(grpc.status.UNAUTHENTICATED, details);
}
