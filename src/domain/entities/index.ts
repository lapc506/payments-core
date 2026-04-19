// =============================================================================
// Entities barrel
// -----------------------------------------------------------------------------
// The top-level `src/domain/index.ts` barrel re-exports from here; consumers
// should import from `@/domain` rather than deep-importing individual entity
// files.
// =============================================================================

export {
  canTransitionPaymentIntent,
  createPaymentIntent,
  transitionPaymentIntent,
  type CreatePaymentIntentInput,
  type PaymentIntent,
  type PaymentIntentStatus,
  type TransitionPaymentIntentArgs,
} from './payment-intent.js';

export {
  canTransitionSubscription,
  createSubscription,
  transitionSubscription,
  type CreateSubscriptionInput,
  type Subscription,
  type SubscriptionStatus,
  type TransitionSubscriptionArgs,
} from './subscription.js';

export {
  canTransitionEscrow,
  createEscrow,
  transitionEscrow,
  type CreateEscrowInput,
  type Escrow,
  type EscrowStatus,
  type MilestoneCondition,
  type TransitionEscrowArgs,
} from './escrow.js';

export {
  canTransitionDispute,
  canTransitionDonation,
  canTransitionPayout,
  canTransitionRefund,
  createDispute,
  createDonation,
  createPayout,
  createRefund,
  submitDisputeEvidence,
  transitionDispute,
  transitionDonation,
  transitionPayout,
  transitionRefund,
  type CreateDisputeInput,
  type CreateDonationInput,
  type CreatePayoutInput,
  type CreateRefundInput,
  type Dispute,
  type DisputeStatus,
  type Donation,
  type DonationKind,
  type DonationStatus,
  type Payout,
  type PayoutStatus,
  type Refund,
  type RefundStatus,
} from './simple-entities.js';
