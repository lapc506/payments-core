// =============================================================================
// Opaque gateway references + 3DS challenge payloads
// -----------------------------------------------------------------------------
// Two value objects live together in this file because both are deliberately
// opaque at the domain layer — they carry gateway-side identifiers and
// payloads that the domain must not interpret, only pass through.
//
// `GatewayRef` wraps the external identifier a gateway hands us when a
// PaymentIntent (or Subscription, Escrow, Payout, Dispute) is created.
// `ThreeDSChallenge` wraps the opaque challenge payload returned by a gateway
// when a 3DS / SCA step-up is required. The domain never parses it; the
// outbound adapter that produced it is the only code that decodes.
// =============================================================================

import { DomainError, type Result, err, ok } from '../errors.js';

// ---------------------------------------------------------------------------
// GatewayName — mirrors proto GatewayPreference minus the AUTO/UNSPECIFIED
// sentinels. The domain always deals with a concrete gateway by the time a
// GatewayRef exists: "auto" is resolved upstream.
// ---------------------------------------------------------------------------

export type GatewayName =
  | 'stripe'
  | 'onvopay'
  | 'tilopay'
  | 'dlocal'
  | 'revolut'
  | 'convera'
  | 'ripple_xrpl';

export const GATEWAY_NAMES: readonly GatewayName[] = [
  'stripe',
  'onvopay',
  'tilopay',
  'dlocal',
  'revolut',
  'convera',
  'ripple_xrpl',
];

/**
 * External identifier assigned by a gateway. `externalId` is opaque; never
 * parse it inside the domain layer. The domain only ever compares for
 * equality (reconciliation) or passes it through to an outbound adapter.
 */
export interface GatewayRef {
  readonly gateway: GatewayName;
  readonly externalId: string;
}

/**
 * Thrown when a candidate GatewayRef has an unknown gateway name or an empty
 * external id.
 */
export class InvalidGatewayRefError extends DomainError {
  constructor(message: string) {
    super('DOMAIN_INVALID_GATEWAY_REF', message);
    this.name = 'InvalidGatewayRefError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createGatewayRef(
  gateway: string,
  externalId: string,
): Result<GatewayRef, InvalidGatewayRefError> {
  if (!GATEWAY_NAMES.includes(gateway as GatewayName)) {
    return err(new InvalidGatewayRefError(`Unknown gateway '${gateway}'`));
  }
  if (typeof externalId !== 'string' || externalId.length === 0) {
    return err(new InvalidGatewayRefError('externalId must be a non-empty string'));
  }
  return ok({ gateway: gateway as GatewayName, externalId });
}

export function gatewayRefEquals(a: GatewayRef, b: GatewayRef): boolean {
  return a.gateway === b.gateway && a.externalId === b.externalId;
}

// ---------------------------------------------------------------------------
// ThreeDSChallenge
// ---------------------------------------------------------------------------

/**
 * Opaque 3DS / SCA challenge payload produced by a gateway. Stored only long
 * enough for the caller to complete the step-up flow and re-present the
 * result; never persisted beyond that. The domain must not parse the `data`
 * bytes — each gateway uses a different shape (Stripe: JSON with
 * `client_secret`, OnvoPay: ACS redirect URL, etc.).
 */
export interface ThreeDSChallenge {
  readonly challengeId: string;
  readonly data: Uint8Array;
}

export class InvalidThreeDSChallengeError extends DomainError {
  constructor(message: string) {
    super('DOMAIN_INVALID_THREE_DS_CHALLENGE', message);
    this.name = 'InvalidThreeDSChallengeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createThreeDSChallenge(
  challengeId: string,
  data: Uint8Array,
): Result<ThreeDSChallenge, InvalidThreeDSChallengeError> {
  if (typeof challengeId !== 'string' || challengeId.length === 0) {
    return err(new InvalidThreeDSChallengeError('challengeId must be a non-empty string'));
  }
  if (!(data instanceof Uint8Array)) {
    return err(new InvalidThreeDSChallengeError('data must be a Uint8Array'));
  }
  return ok({ challengeId, data });
}
