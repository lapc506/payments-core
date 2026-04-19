// =============================================================================
// Subscription entity
// -----------------------------------------------------------------------------
// Lifecycle per issue #17:
//
//   intent → active → past_due → canceled
//                   └────────→ canceled
//          → incomplete → active (recovery)
//                       → canceled
//
// `incomplete` is an interstitial state entered when the initial payment
// on the first billing cycle fails a required authentication or is declined
// and the gateway holds it in a retry window (Stripe's `incomplete`, OnvoPay's
// `awaiting_first_charge`). Recovery moves it to `active`; timeout moves it
// to `canceled`.
// =============================================================================

import { InvalidStateTransitionError } from '../errors.js';
import type { GatewayRef } from '../value_objects/opaque-refs.js';
import type { IdempotencyKey } from '../value_objects/idempotency-key.js';

export type SubscriptionStatus =
  | 'intent'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

const SUBSCRIPTION_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  intent: ['active', 'incomplete', 'canceled'],
  active: ['past_due', 'canceled'],
  past_due: ['active', 'canceled'],
  canceled: [],
  incomplete: ['active', 'canceled'],
};

export function canTransitionSubscription(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export interface Subscription {
  readonly id: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface CreateSubscriptionInput {
  readonly id: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly planId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
}

export function createSubscription(input: CreateSubscriptionInput): Subscription {
  return {
    id: input.id,
    consumer: input.consumer,
    customerReference: input.customerReference,
    planId: input.planId,
    status: 'intent',
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}

export interface TransitionSubscriptionArgs {
  readonly to: SubscriptionStatus;
  readonly gatewayRef?: GatewayRef;
}

export function transitionSubscription(
  subscription: Subscription,
  args: TransitionSubscriptionArgs,
): Subscription {
  if (!canTransitionSubscription(subscription.status, args.to)) {
    throw new InvalidStateTransitionError(
      subscription.status,
      SUBSCRIPTION_TRANSITIONS[subscription.status],
    );
  }
  return {
    ...subscription,
    status: args.to,
    gatewayRef: args.gatewayRef ?? subscription.gatewayRef,
  };
}
