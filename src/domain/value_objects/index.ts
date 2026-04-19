// =============================================================================
// Value objects barrel
// -----------------------------------------------------------------------------
// Consumers import from `@/domain/value_objects` (via the top-level barrel in
// `src/domain/index.ts`). Do not deep-import from the individual files — the
// barrel is the stable surface.
// =============================================================================

export { Money } from './money.js';
export {
  createIdempotencyKey,
  idempotencyKey,
  InvalidIdempotencyKeyError,
  type IdempotencyKey,
} from './idempotency-key.js';
export {
  GATEWAY_NAMES,
  InvalidGatewayRefError,
  InvalidThreeDSChallengeError,
  createGatewayRef,
  createThreeDSChallenge,
  gatewayRefEquals,
  type GatewayName,
  type GatewayRef,
  type ThreeDSChallenge,
} from './opaque-refs.js';
