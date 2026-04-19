// =============================================================================
// Escrow entity
// -----------------------------------------------------------------------------
// Lifecycle per issue #17:
//
//   held → released
//        → refunded
//        → disputed
//
// Carries two fields that honor the `aduanext-integration-needs` contract:
//
//   - `milestoneCondition` — opaque to the domain; AduaNext (and other
//     future customers) publishes its own milestone strings. The domain only
//     stores them as metadata and the `EscrowPort.release` adapter checks
//     their presence before releasing.
//   - `platformFeeMinor` — amount in minor units of the held currency that
//     routes to `platformFeeDestination` on release. Maps to Stripe Connect
//     `application_fee_amount` at the adapter layer.
//
// Once an escrow is `disputed`, all other operations are rejected (see
// `DisputeOngoingError`). Resolution of the dispute transitions it to
// `released` (payee wins) or `refunded` (payer wins).
// =============================================================================

import { DisputeOngoingError, InvalidStateTransitionError } from '../errors.js';
import type { GatewayRef } from '../value_objects/opaque-refs.js';
import type { IdempotencyKey } from '../value_objects/idempotency-key.js';
import type { Money } from '../value_objects/money.js';

export type EscrowStatus = 'held' | 'released' | 'refunded' | 'disputed';

const ESCROW_TRANSITIONS: Readonly<Record<EscrowStatus, readonly EscrowStatus[]>> = {
  held: ['released', 'refunded', 'disputed'],
  // A dispute can end in either release (payee wins) or refund (payer wins).
  disputed: ['released', 'refunded'],
  released: [],
  refunded: [],
};

export function canTransitionEscrow(from: EscrowStatus, to: EscrowStatus): boolean {
  return ESCROW_TRANSITIONS[from].includes(to);
}

/**
 * Milestone spec handed to `EscrowPort.hold`. The domain treats every entry
 * as opaque; semantics live with the caller (e.g. AduaNext's `dua_signed`,
 * `levante_received`). Release splits are percentages that sum to 100.
 */
export interface MilestoneCondition {
  readonly milestones: readonly string[];
  readonly releaseSplit: readonly number[];
}

export interface Escrow {
  readonly id: string;
  readonly consumer: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly amount: Money;
  readonly status: EscrowStatus;
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  /** Total of all previously-released tranches, in the same currency as `amount`. */
  readonly releasedAmount: Money;
  readonly milestoneCondition: MilestoneCondition | null;
  readonly platformFeeMinor: bigint;
  readonly platformFeeDestination: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface CreateEscrowInput {
  readonly id: string;
  readonly consumer: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly amount: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly milestoneCondition?: MilestoneCondition;
  readonly platformFeeMinor?: bigint;
  readonly platformFeeDestination?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
}

/**
 * Construct a fresh Escrow in the `held` state. Escrows are only ever
 * created after the hold has been confirmed by the outbound gateway adapter,
 * so `held` is the only legal initial status.
 */
export function createEscrow(input: CreateEscrowInput): Escrow {
  const zero = { amountMinor: 0n, currency: input.amount.currency } as Money;
  return {
    id: input.id,
    consumer: input.consumer,
    payerReference: input.payerReference,
    payeeReference: input.payeeReference,
    amount: input.amount,
    status: 'held',
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    releasedAmount: zero,
    milestoneCondition: input.milestoneCondition ?? null,
    platformFeeMinor: input.platformFeeMinor ?? 0n,
    platformFeeDestination: input.platformFeeDestination ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}

export interface TransitionEscrowArgs {
  readonly to: EscrowStatus;
  readonly gatewayRef?: GatewayRef;
}

/**
 * Advance the Escrow to a new status. A currently-disputed escrow is the
 * only state that forbids direct transitions to anything other than the two
 * resolution states (`released`, `refunded`); any other attempt raises
 * `DisputeOngoingError` to make the failure mode explicit.
 */
export function transitionEscrow(escrow: Escrow, args: TransitionEscrowArgs): Escrow {
  if (
    escrow.status === 'disputed' &&
    args.to !== 'released' &&
    args.to !== 'refunded'
  ) {
    throw new DisputeOngoingError(escrow.id);
  }
  if (!canTransitionEscrow(escrow.status, args.to)) {
    throw new InvalidStateTransitionError(escrow.status, ESCROW_TRANSITIONS[escrow.status]);
  }
  return {
    ...escrow,
    status: args.to,
    gatewayRef: args.gatewayRef ?? escrow.gatewayRef,
  };
}
