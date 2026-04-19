// =============================================================================
// PaymentIntent entity
// -----------------------------------------------------------------------------
// Lifecycle stages per GitHub issue #17:
//
//   intent → pending → succeeded → refunded
//                   └→ failed
//                      succeeded → disputed
//
// State machine (canTransition + transition helpers below) is the
// authoritative source for valid edges. Any adapter observing a gateway
// webhook must map the provider-specific status onto this set before calling
// the transition helper, not after.
//
// Entity instances are immutable. Every transition returns a NEW instance so
// the caller can persist the old+new pair atomically if they need audit.
// =============================================================================

import { InvalidStateTransitionError } from '../errors.js';
import type { GatewayRef } from '../value_objects/opaque-refs.js';
import type { IdempotencyKey } from '../value_objects/idempotency-key.js';
import type { Money } from '../value_objects/money.js';

export type PaymentIntentStatus =
  | 'intent'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'disputed';

/**
 * Transition table. Each entry lists the legal target statuses from the key
 * status. Absence of a target means the transition is rejected.
 */
const PAYMENT_INTENT_TRANSITIONS: Readonly<
  Record<PaymentIntentStatus, readonly PaymentIntentStatus[]>
> = {
  intent: ['pending', 'failed'],
  pending: ['succeeded', 'failed'],
  succeeded: ['refunded', 'disputed'],
  failed: [],
  refunded: ['disputed'],
  disputed: [],
};

export function canTransitionPaymentIntent(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): boolean {
  const allowed = PAYMENT_INTENT_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Immutable entity. Transitions return a new instance with the advanced
 * status; persistence is the application layer's job.
 */
export interface PaymentIntent {
  readonly id: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly amount: Money;
  readonly status: PaymentIntentStatus;
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface CreatePaymentIntentInput {
  readonly id: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly amount: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
}

/**
 * Construct a fresh PaymentIntent in the `intent` state. Adapters never
 * instantiate statuses other than `intent` at creation time — subsequent
 * transitions go through `transitionPaymentIntent`.
 */
export function createPaymentIntent(input: CreatePaymentIntentInput): PaymentIntent {
  return {
    id: input.id,
    consumer: input.consumer,
    customerReference: input.customerReference,
    amount: input.amount,
    status: 'intent',
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}

export interface TransitionPaymentIntentArgs {
  readonly to: PaymentIntentStatus;
  readonly gatewayRef?: GatewayRef;
}

/**
 * Advance the PaymentIntent to a new status. Throws
 * `InvalidStateTransitionError` when the edge is not allowed. Returns a new
 * instance; the input is untouched.
 */
export function transitionPaymentIntent(
  intent: PaymentIntent,
  args: TransitionPaymentIntentArgs,
): PaymentIntent {
  if (!canTransitionPaymentIntent(intent.status, args.to)) {
    throw new InvalidStateTransitionError(
      intent.status,
      PAYMENT_INTENT_TRANSITIONS[intent.status],
    );
  }
  return {
    ...intent,
    status: args.to,
    gatewayRef: args.gatewayRef ?? intent.gatewayRef,
  };
}
