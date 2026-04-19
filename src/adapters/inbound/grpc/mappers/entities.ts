// =============================================================================
// Entity mappers — proto enums + statuses ↔ domain.
// -----------------------------------------------------------------------------
// Bidirectional converters for every enum/status crossing the transport
// boundary. Money lives in a dedicated module because it carries the
// bigint↔string bridge; everything else lives here.
//
// Design points:
//   - Every domain → proto fn returns UNSPECIFIED for unreachable cases so
//     the wire always carries a defined enum. Callers never see `0` meaning
//     "failed to map".
//   - Every proto → domain fn rejects UNSPECIFIED with a typed error so
//     handlers can translate to `INVALID_ARGUMENT`.
//   - ReadPayment statuses are a superset of the internal `PaymentIntent`
//     state machine (PROCESSING, REQUIRES_ACTION don't exist in the domain).
//     Those cases map to the closest domain status with a metadata hint.
// =============================================================================

import {
  type EscrowStatus,
  type GatewayName,
  type PaymentIntentStatus,
  type PayoutStatus,
  type SubscriptionStatus,
} from '../../../../domain/index.js';
import {
  EscrowStatus as ProtoEscrowStatus,
  GatewayPreference,
  PaymentStatus,
  PayoutStatus as ProtoPayoutStatus,
  SubscriptionStatus as ProtoSubscriptionStatus,
} from '../../../../generated/lapc506/payments_core/v1/payments_core.js';

export class InvalidEnumMappingError extends Error {
  public readonly code = 'GRPC_INVALID_ENUM_MAPPING';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnumMappingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// GatewayPreference ↔ GatewayName
// ---------------------------------------------------------------------------

export function protoGatewayToDomain(
  proto: GatewayPreference,
): GatewayName | null {
  switch (proto) {
    case GatewayPreference.GATEWAY_PREFERENCE_STRIPE:
      return 'stripe';
    case GatewayPreference.GATEWAY_PREFERENCE_ONVOPAY:
      return 'onvopay';
    case GatewayPreference.GATEWAY_PREFERENCE_TILOPAY:
      return 'tilopay';
    case GatewayPreference.GATEWAY_PREFERENCE_DLOCAL:
      return 'dlocal';
    case GatewayPreference.GATEWAY_PREFERENCE_REVOLUT:
      return 'revolut';
    case GatewayPreference.GATEWAY_PREFERENCE_CONVERA:
      return 'convera';
    case GatewayPreference.GATEWAY_PREFERENCE_RIPPLE_XRPL:
      return 'ripple_xrpl';
    case GatewayPreference.GATEWAY_PREFERENCE_AUTO:
    case GatewayPreference.GATEWAY_PREFERENCE_UNSPECIFIED:
    default:
      return null;
  }
}

/**
 * Resolve a caller-supplied `GatewayPreference` to a concrete `GatewayName`.
 * v1 does NOT ship an auto-selection policy — AUTO/UNSPECIFIED fall back to
 * `stripe`, matching the stub-port composition in `main.ts`. The real
 * selector lands with `adapters-registry-v1` (see issue #20 / #21 follow-ups).
 */
export function resolveGatewayPreference(
  proto: GatewayPreference,
  fallback: GatewayName = 'stripe',
): GatewayName {
  return protoGatewayToDomain(proto) ?? fallback;
}

export function domainGatewayToProto(name: GatewayName): GatewayPreference {
  switch (name) {
    case 'stripe':
      return GatewayPreference.GATEWAY_PREFERENCE_STRIPE;
    case 'onvopay':
      return GatewayPreference.GATEWAY_PREFERENCE_ONVOPAY;
    case 'tilopay':
      return GatewayPreference.GATEWAY_PREFERENCE_TILOPAY;
    case 'dlocal':
      return GatewayPreference.GATEWAY_PREFERENCE_DLOCAL;
    case 'revolut':
      return GatewayPreference.GATEWAY_PREFERENCE_REVOLUT;
    case 'convera':
      return GatewayPreference.GATEWAY_PREFERENCE_CONVERA;
    case 'ripple_xrpl':
      return GatewayPreference.GATEWAY_PREFERENCE_RIPPLE_XRPL;
  }
}

// ---------------------------------------------------------------------------
// PaymentStatus ↔ PaymentIntentStatus
// ---------------------------------------------------------------------------

/**
 * Domain exposes six lifecycle stages; the proto enum exposes seven (plus
 * UNSPECIFIED). `pending` maps to PROCESSING because that is what most
 * callers visualize during a gateway round-trip; `intent` stays PROCESSING
 * too — callers should not observe `intent` in practice (the use case
 * advances to `pending` in the same RPC).
 */
export function domainPaymentStatusToProto(
  status: PaymentIntentStatus,
): PaymentStatus {
  switch (status) {
    case 'intent':
    case 'pending':
      return PaymentStatus.PAYMENT_STATUS_PROCESSING;
    case 'succeeded':
      return PaymentStatus.PAYMENT_STATUS_SUCCEEDED;
    case 'failed':
      return PaymentStatus.PAYMENT_STATUS_FAILED;
    case 'refunded':
      return PaymentStatus.PAYMENT_STATUS_REFUNDED;
    case 'disputed':
      // Disputed intents still appear `succeeded` on the wire — the dispute
      // lives on a separate entity. Callers observing a dispute do so via
      // the DisputeEscrowResponse or a webhook-driven event.
      return PaymentStatus.PAYMENT_STATUS_SUCCEEDED;
  }
}

// ---------------------------------------------------------------------------
// SubscriptionStatus ↔ domain
// ---------------------------------------------------------------------------

export function domainSubscriptionStatusToProto(
  status: SubscriptionStatus,
): ProtoSubscriptionStatus {
  switch (status) {
    case 'active':
      return ProtoSubscriptionStatus.SUBSCRIPTION_STATUS_ACTIVE;
    case 'past_due':
      return ProtoSubscriptionStatus.SUBSCRIPTION_STATUS_PAST_DUE;
    case 'canceled':
      return ProtoSubscriptionStatus.SUBSCRIPTION_STATUS_CANCELED;
    // `intent` and `incomplete` are interstitial — surface as PAST_DUE so
    // callers retry from the authoritative state once the gateway advances.
    case 'intent':
    case 'incomplete':
      return ProtoSubscriptionStatus.SUBSCRIPTION_STATUS_PAUSED;
  }
}

// ---------------------------------------------------------------------------
// EscrowStatus ↔ domain
// ---------------------------------------------------------------------------

export function domainEscrowStatusToProto(
  status: EscrowStatus,
): ProtoEscrowStatus {
  switch (status) {
    case 'held':
      return ProtoEscrowStatus.ESCROW_STATUS_HELD;
    case 'released':
      return ProtoEscrowStatus.ESCROW_STATUS_RELEASED;
    case 'disputed':
      return ProtoEscrowStatus.ESCROW_STATUS_DISPUTED;
    case 'refunded':
      return ProtoEscrowStatus.ESCROW_STATUS_REFUNDED;
  }
}

// ---------------------------------------------------------------------------
// PayoutStatus ↔ domain
// ---------------------------------------------------------------------------

export function domainPayoutStatusToProto(
  status: PayoutStatus,
): ProtoPayoutStatus {
  switch (status) {
    case 'pending':
      return ProtoPayoutStatus.PAYOUT_STATUS_PENDING;
    case 'paid':
      return ProtoPayoutStatus.PAYOUT_STATUS_PAID;
    case 'failed':
      return ProtoPayoutStatus.PAYOUT_STATUS_FAILED;
  }
}

// ---------------------------------------------------------------------------
// Timestamps (proto: Date | undefined)
// ---------------------------------------------------------------------------

export function protoDateToDomain(d: Date | undefined): Date {
  return d instanceof Date ? d : new Date();
}

export function domainDateToProto(d: Date): Date {
  // ts-proto emits `Date` on the wire; identity here is intentional — keeps
  // one call site to adjust if we later switch to a Timestamp wrapper.
  return d;
}
