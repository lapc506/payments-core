// =============================================================================
// Payout, Refund, Dispute, Donation entities
// -----------------------------------------------------------------------------
// Four entities share this file because each one is small (≤ 3-5 statuses,
// no cross-cutting invariants) and splitting them one-per-file would bust
// the 15-file budget without improving readability. The state machines are
// completely independent.
//
// Payout    : pending → paid | failed
// Refund    : requested → succeeded | failed
// Dispute   : opened → evidence_submitted → won | lost, opened → withdrawn
// Donation  : intent → pending → succeeded | failed → refunded (mirrors
//             PaymentIntent) + one-time vs recurring flag + campaign metadata
//             hook consumed by altrupets-api.
// =============================================================================

import { InvalidStateTransitionError } from '../errors.js';
import type { GatewayRef } from '../value_objects/opaque-refs.js';
import type { IdempotencyKey } from '../value_objects/idempotency-key.js';
import type { Money } from '../value_objects/money.js';

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------

export type PayoutStatus = 'pending' | 'paid' | 'failed';

const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  pending: ['paid', 'failed'],
  paid: [],
  failed: [],
};

export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export interface Payout {
  readonly id: string;
  readonly consumer: string;
  readonly beneficiaryReference: string;
  readonly amount: Money;
  readonly status: PayoutStatus;
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface CreatePayoutInput {
  readonly id: string;
  readonly consumer: string;
  readonly beneficiaryReference: string;
  readonly amount: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
}

export function createPayout(input: CreatePayoutInput): Payout {
  return {
    id: input.id,
    consumer: input.consumer,
    beneficiaryReference: input.beneficiaryReference,
    amount: input.amount,
    status: 'pending',
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}

export function transitionPayout(
  payout: Payout,
  to: PayoutStatus,
  gatewayRef?: GatewayRef,
): Payout {
  if (!canTransitionPayout(payout.status, to)) {
    throw new InvalidStateTransitionError(payout.status, PAYOUT_TRANSITIONS[payout.status]);
  }
  return { ...payout, status: to, gatewayRef: gatewayRef ?? payout.gatewayRef };
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

export type RefundStatus = 'requested' | 'succeeded' | 'failed';

const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  requested: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

export interface Refund {
  readonly id: string;
  readonly intentId: string;
  readonly amount: Money;
  readonly status: RefundStatus;
  readonly reason: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  readonly createdAt: Date;
}

export interface CreateRefundInput {
  readonly id: string;
  readonly intentId: string;
  readonly amount: Money;
  readonly reason: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly createdAt?: Date;
}

export function createRefund(input: CreateRefundInput): Refund {
  return {
    id: input.id,
    intentId: input.intentId,
    amount: input.amount,
    status: 'requested',
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    createdAt: input.createdAt ?? new Date(),
  };
}

export function transitionRefund(
  refund: Refund,
  to: RefundStatus,
  gatewayRef?: GatewayRef,
): Refund {
  if (!canTransitionRefund(refund.status, to)) {
    throw new InvalidStateTransitionError(refund.status, REFUND_TRANSITIONS[refund.status]);
  }
  return { ...refund, status: to, gatewayRef: gatewayRef ?? refund.gatewayRef };
}

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

export type DisputeStatus =
  | 'opened'
  | 'evidence_submitted'
  | 'won'
  | 'lost'
  | 'withdrawn';

const DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  opened: ['evidence_submitted', 'withdrawn', 'lost'],
  evidence_submitted: ['won', 'lost'],
  won: [],
  lost: [],
  withdrawn: [],
};

export function canTransitionDispute(from: DisputeStatus, to: DisputeStatus): boolean {
  return DISPUTE_TRANSITIONS[from].includes(to);
}

export interface Dispute {
  readonly id: string;
  readonly intentId: string;
  readonly reason: string;
  readonly status: DisputeStatus;
  readonly evidence: readonly string[];
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  readonly createdAt: Date;
}

export interface CreateDisputeInput {
  readonly id: string;
  readonly intentId: string;
  readonly reason: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly createdAt?: Date;
}

export function createDispute(input: CreateDisputeInput): Dispute {
  return {
    id: input.id,
    intentId: input.intentId,
    reason: input.reason,
    status: 'opened',
    evidence: [],
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    createdAt: input.createdAt ?? new Date(),
  };
}

/**
 * Attach evidence and move to `evidence_submitted`. Evidence items are
 * caller-supplied URLs or document ids; the domain does not interpret them.
 */
export function submitDisputeEvidence(dispute: Dispute, evidence: readonly string[]): Dispute {
  if (!canTransitionDispute(dispute.status, 'evidence_submitted')) {
    throw new InvalidStateTransitionError(
      dispute.status,
      DISPUTE_TRANSITIONS[dispute.status],
    );
  }
  return { ...dispute, status: 'evidence_submitted', evidence };
}

export function transitionDispute(
  dispute: Dispute,
  to: DisputeStatus,
  gatewayRef?: GatewayRef,
): Dispute {
  if (!canTransitionDispute(dispute.status, to)) {
    throw new InvalidStateTransitionError(
      dispute.status,
      DISPUTE_TRANSITIONS[dispute.status],
    );
  }
  return { ...dispute, status: to, gatewayRef: gatewayRef ?? dispute.gatewayRef };
}

// ---------------------------------------------------------------------------
// Donation — separate from PaymentIntent to carry campaign metadata hooks
// consumed by altrupets-api and future donation-focused callers.
// ---------------------------------------------------------------------------

export type DonationStatus =
  | 'intent'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded';

export type DonationKind = 'one_time' | 'recurring';

const DONATION_TRANSITIONS: Readonly<Record<DonationStatus, readonly DonationStatus[]>> = {
  intent: ['pending', 'failed'],
  pending: ['succeeded', 'failed'],
  succeeded: ['refunded'],
  failed: [],
  refunded: [],
};

export function canTransitionDonation(from: DonationStatus, to: DonationStatus): boolean {
  return DONATION_TRANSITIONS[from].includes(to);
}

export interface Donation {
  readonly id: string;
  readonly consumer: string;
  readonly donorReference: string;
  /** Opaque campaign id. AltruPets attaches its own cause id here. */
  readonly campaignId: string;
  readonly kind: DonationKind;
  readonly amount: Money;
  readonly status: DonationStatus;
  readonly idempotencyKey: IdempotencyKey;
  readonly gatewayRef: GatewayRef | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface CreateDonationInput {
  readonly id: string;
  readonly consumer: string;
  readonly donorReference: string;
  readonly campaignId: string;
  readonly kind: DonationKind;
  readonly amount: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
}

export function createDonation(input: CreateDonationInput): Donation {
  return {
    id: input.id,
    consumer: input.consumer,
    donorReference: input.donorReference,
    campaignId: input.campaignId,
    kind: input.kind,
    amount: input.amount,
    status: 'intent',
    idempotencyKey: input.idempotencyKey,
    gatewayRef: null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}

export function transitionDonation(
  donation: Donation,
  to: DonationStatus,
  gatewayRef?: GatewayRef,
): Donation {
  if (!canTransitionDonation(donation.status, to)) {
    throw new InvalidStateTransitionError(
      donation.status,
      DONATION_TRANSITIONS[donation.status],
    );
  }
  return { ...donation, status: to, gatewayRef: gatewayRef ?? donation.gatewayRef };
}
