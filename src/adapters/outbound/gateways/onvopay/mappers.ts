// =============================================================================
// OnvoPay <-> domain mappers
// -----------------------------------------------------------------------------
// OnvoPay's wire format (JSON over HTTPS) is translated into domain types
// here and here only. No other file in this adapter constructs domain objects
// from a raw OnvoPay payload; they all call `toDomain*` helpers below.
//
// Currency note: OnvoPay's primary market is Costa Rica, where the Colón
// (CRC) has no practical minor unit (subdivision is notional). The adapter
// forbids non-CRC charges at the gateway boundary so consumers don't
// accidentally route a USD payment through OnvoPay and get a 400 from the
// gateway after the use case has already committed an intent.
//
// TODO: verify against https://docs.onvopay.com/#section/Referencia-API —
// if OnvoPay supports USD, EUR, or multi-currency settlement for specific
// merchants, relax `assertCrcOnly()` and document which currencies are
// accepted in docs/content/docs/adapters/onvopay.md.
// =============================================================================

import { InvalidMoneyError } from '../../../../domain/errors.js';
import type { GatewayRef } from '../../../../domain/value_objects/opaque-refs.js';
import type { Money } from '../../../../domain/value_objects/money.js';
import type { Subscription, SubscriptionStatus } from '../../../../domain/entities/subscription.js';

// ---------------------------------------------------------------------------
// OnvoPay wire types (reverse-modeled from the docs at time of writing)
// ---------------------------------------------------------------------------

/**
 * OnvoPay charge resource. Field shapes are reverse-modeled from
 * https://docs.onvopay.com/#section/Referencia-API — every field is marked
 * with a TODO until verified against a live sandbox response.
 */
export interface OnvoPayCharge {
  /** Charge id, e.g. `chr_abc123`. */
  readonly id: string;
  /** Integer amount in the currency's minor unit. */
  readonly amount: number;
  /** ISO-4217 currency, typically `CRC` or `USD`. */
  readonly currency: string;
  /**
   * Status string. Likely values (TODO: verify):
   * `pending` | `requires_action` | `succeeded` | `failed` | `refunded`.
   */
  readonly status: string;
  /** URL that hosts a 3DS / redirect challenge, when `status === 'requires_action'`. */
  readonly checkout_url?: string;
  /** Optional structured next-action, gateway-specific. */
  readonly next_action?: { readonly redirect_url?: string } | null;
  /** Failure reason when status is `failed`. */
  readonly failure_reason?: string | null;
}

export interface OnvoPaySubscription {
  readonly id: string;
  readonly status: string;
  readonly plan_id?: string;
  readonly customer_id?: string;
}

export interface OnvoPayRefund {
  readonly id: string;
  readonly status: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly charge_id?: string;
}

/**
 * OnvoPay webhook event envelope. TODO: verify field names against
 * https://docs.onvopay.com/ webhook section. Some gateways nest payload
 * under `data.object`; OnvoPay may use `data` or `resource` instead.
 */
export interface OnvoPayWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly created_at?: string;
  readonly data?: unknown;
}

// ---------------------------------------------------------------------------
// Outbound: domain -> OnvoPay wire
// ---------------------------------------------------------------------------

/**
 * Guard that enforces the OnvoPay CRC-only contract at the adapter boundary.
 * Throws InvalidMoneyError for any other currency so consumers see a
 * domain-level error rather than a gateway 400.
 *
 * TODO: verify OnvoPay's full supported-currency list. If USD (or any other
 * currency) is supported, widen this guard accordingly.
 */
export function assertOnvoPaySupportedCurrency(money: Money): void {
  if (money.currency !== 'CRC') {
    throw new InvalidMoneyError(
      `OnvoPay adapter only supports CRC at this time; got '${money.currency}'. ` +
        `Route non-CRC payments through a different gateway.`,
    );
  }
}

/**
 * Serialize a `Money` into the OnvoPay charge body shape. OnvoPay's minor-unit
 * convention for CRC is not explicitly documented; we pass the integer
 * amount through unchanged and expect the gateway to interpret it as
 * "minor units" per industry convention.
 *
 * TODO: verify minor-unit convention for CRC against
 * https://docs.onvopay.com/#section/Referencia-API — if OnvoPay expects
 * whole Colones (amount/100) instead of minor units, change the conversion
 * here and nowhere else.
 */
export function toOnvoPayAmount(money: Money): number {
  assertOnvoPaySupportedCurrency(money);
  const n = Number(money.amountMinor);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidMoneyError(
      `Amount ${money.amountMinor.toString()} is not representable as a JSON number`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Inbound: OnvoPay wire -> domain
// ---------------------------------------------------------------------------

export function toGatewayRef(onvopayId: string): GatewayRef {
  return { gateway: 'onvopay', externalId: onvopayId };
}

/**
 * Map OnvoPay charge status to the discriminator expected by
 * `ConfirmPaymentResult.status`. Unknown statuses degrade to 'failed' so
 * the use case layer can still emit a terminal event; the raw OnvoPay
 * status is preserved in `failureReason` for operators.
 *
 * TODO: verify complete status enum against
 * https://docs.onvopay.com/#section/Referencia-API.
 */
export function toConfirmStatus(
  onvopayStatus: string,
): 'succeeded' | 'failed' | 'requires_action' {
  switch (onvopayStatus) {
    case 'succeeded':
    case 'captured':
      return 'succeeded';
    case 'requires_action':
    case 'pending_confirmation':
      return 'requires_action';
    default:
      return 'failed';
  }
}

/**
 * Map OnvoPay subscription status onto the domain Subscription state
 * machine. Any unmapped status becomes 'incomplete' rather than 'canceled'
 * because a subscription that shows up with an unknown status should be
 * treated as recoverable until explicitly canceled by the gateway.
 *
 * TODO: verify status enum against
 * https://docs.onvopay.com/#tag/Cargos-recurrentes.
 */
export function toSubscriptionStatus(onvopayStatus: string): SubscriptionStatus {
  switch (onvopayStatus) {
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
    case 'awaiting_first_charge':
      return 'incomplete';
    case 'intent':
    case 'created':
      return 'intent';
    default:
      return 'incomplete';
  }
}

/**
 * Project an OnvoPay subscription payload into a partial domain Subscription
 * — just enough for the CreateSubscription use case to know the external id
 * and status. The adapter does not own the full domain entity (id,
 * customerReference, etc. are supplied by the use case layer).
 */
export function toSubscriptionProjection(
  sub: OnvoPaySubscription,
): Pick<Subscription, 'status' | 'gatewayRef'> {
  return {
    status: toSubscriptionStatus(sub.status),
    gatewayRef: toGatewayRef(sub.id),
  };
}
