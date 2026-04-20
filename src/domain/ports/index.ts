// =============================================================================
// Ports
// -----------------------------------------------------------------------------
// Nine interfaces consumed by the application layer; implemented by outbound
// adapters in `src/adapters/outbound/` (landing with their respective change
// proposals). Every mutating method requires an `IdempotencyKey` so retried
// requests converge on the same persisted record.
//
// All nine ports are declared in this single file to honor the 15-file budget
// tracked on issue #17. Adapter changes re-export any request/response types
// they need to reshape; they do not add new top-level port files.
//
// Hard constraint (enforced by eslint `no-restricted-imports` on
// `src/domain/**`): no import from `@grpc/*`, `stripe`, `@supabase/*`, `axios`,
// `pg`, `node-fetch`, or anything with I/O. Ports are pure interfaces.
// =============================================================================

import type { Dispute, Donation } from '../entities/simple-entities.js';
import type { Escrow, MilestoneCondition } from '../entities/escrow.js';
import type { GatewayName, GatewayRef, ThreeDSChallenge } from '../value_objects/opaque-refs.js';
import type { IdempotencyKey } from '../value_objects/idempotency-key.js';
import type { Money } from '../value_objects/money.js';
import type { PaymentIntent } from '../entities/payment-intent.js';
import type { Payout, Refund } from '../entities/simple-entities.js';
import type { Subscription } from '../entities/subscription.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface WebhookEvent {
  readonly gateway: GatewayName;
  readonly eventId: string;
  readonly eventType: string;
  /** Raw, verified payload. Parsing is the caller's responsibility. */
  readonly payload: Uint8Array;
  readonly occurredAt: Date;
}

export interface ReconciliationDiff {
  readonly kind:
    | 'missing_local'
    | 'missing_gateway'
    | 'amount_mismatch'
    | 'status_mismatch';
  readonly intentId: string | null;
  readonly expected: Money | null;
  readonly actual: Money | null;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// 1. PaymentGatewayPort
// ---------------------------------------------------------------------------

/**
 * Primary charge lifecycle. Implemented by adapters for Stripe, OnvoPay,
 * Tilopay, dLocal, Revolut, Convera, Ripple-XRPL.
 */
export interface PaymentGatewayPort {
  readonly gateway: GatewayName;

  initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  confirm(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult>;
  capture(input: CapturePaymentInput): Promise<CapturePaymentResult>;
  refund(input: RefundPaymentInput): Promise<RefundPaymentResult>;
}

export interface InitiatePaymentInput {
  readonly amount: Money;
  readonly consumer: string;
  readonly customerReference: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  readonly description?: string;
}

export interface InitiatePaymentResult {
  readonly gatewayRef: GatewayRef;
  readonly requiresAction: boolean;
  readonly challenge?: ThreeDSChallenge;
  readonly checkoutUrl?: string;
  readonly clientSecret?: string;
}

export interface ConfirmPaymentInput {
  readonly gatewayRef: GatewayRef;
  readonly idempotencyKey: IdempotencyKey;
  readonly threeDsResult?: string;
  readonly walletTokenPayload?: Uint8Array;
}

export interface ConfirmPaymentResult {
  readonly gatewayRef: GatewayRef;
  readonly status: 'succeeded' | 'failed' | 'requires_action';
  readonly failureReason?: string;
  readonly challenge?: ThreeDSChallenge;
}

export interface CapturePaymentInput {
  readonly gatewayRef: GatewayRef;
  readonly amount?: Money;
  readonly idempotencyKey: IdempotencyKey;
}

export interface CapturePaymentResult {
  readonly gatewayRef: GatewayRef;
  readonly status: 'succeeded' | 'failed';
}

export interface RefundPaymentInput {
  readonly gatewayRef: GatewayRef;
  readonly amount?: Money;
  readonly reason?: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface RefundPaymentResult {
  readonly refundGatewayRef: GatewayRef;
  readonly status: 'succeeded' | 'failed';
}

// ---------------------------------------------------------------------------
// 2. SubscriptionPort
// ---------------------------------------------------------------------------

/**
 * Recurring billing. Implemented by Stripe, OnvoPay, Tilopay.
 */
export interface SubscriptionPort {
  readonly gateway: GatewayName;

  create(input: CreateSubscriptionPortInput): Promise<CreateSubscriptionPortResult>;
  switch(input: SwitchSubscriptionInput): Promise<SwitchSubscriptionResult>;
  cancel(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult>;
  prorate(input: ProrateInput): Promise<ProrateResult>;
}

export interface CreateSubscriptionPortInput {
  readonly consumer: string;
  readonly customerReference: string;
  readonly planId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CreateSubscriptionPortResult {
  readonly gatewayRef: GatewayRef;
  readonly status: Subscription['status'];
}

export interface SwitchSubscriptionInput {
  readonly gatewayRef: GatewayRef;
  readonly newPlanId: string;
  readonly prorationBehavior: 'create_prorations' | 'none' | 'always_invoice';
  readonly idempotencyKey: IdempotencyKey;
}

export interface SwitchSubscriptionResult {
  readonly gatewayRef: GatewayRef;
  readonly status: Subscription['status'];
}

export interface CancelSubscriptionInput {
  readonly gatewayRef: GatewayRef;
  readonly atPeriodEnd: boolean;
  readonly reason?: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface CancelSubscriptionResult {
  readonly gatewayRef: GatewayRef;
  readonly status: Subscription['status'];
  readonly effectiveAt: Date;
}

export interface ProrateInput {
  readonly gatewayRef: GatewayRef;
  readonly newPlanId: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface ProrateResult {
  readonly proratedAmount: Money;
  readonly nextCycleAmount: Money;
}

// ---------------------------------------------------------------------------
// 3. EscrowPort — honors aduanext-integration-needs contract
// ---------------------------------------------------------------------------

/**
 * Escrow hold / release / dispute. The `milestone_condition` +
 * `platform_fee_minor` + `platform_fee_destination` fields on `hold` honor
 * the contract documented in `openspec/changes/aduanext-integration-needs/`
 * and normatively specced in `openspec/changes/escrow-port/design.md`.
 *
 * Implemented by Stripe Connect, OnvoPay, Tilopay. No runtime adapter ships
 * with `payments-core` v1; both Stripe and OnvoPay escrow implementations
 * are P1 follow-up changes.
 *
 * State machine (see `src/domain/entities/escrow.ts`):
 * ```
 *   held → released
 *        → refunded
 *        → disputed → released (payee wins)
 *                  → refunded (payer wins)
 * ```
 *
 * Partial releases stay in `held` until the final tranche (or a
 * full-balance release) advances the entity to `released`.
 */
export interface EscrowPort {
  readonly gateway: GatewayName;

  /**
   * Accept payer funds into gateway custody. Returns a `gatewayRef` used
   * for subsequent `release` / `dispute` calls. `milestoneCondition` and
   * `platformFee*` fields are optional; when present, the adapter binds
   * the release split and platform-fee destination at hold time.
   */
  hold(input: HoldEscrowInput): Promise<HoldEscrowResult>;

  /**
   * Release one tranche (if `milestone` is provided), a partial amount
   * (if `amount` is provided), or the entire remaining balance (if both
   * are omitted). `milestone` and `amount` are mutually exclusive per call
   * — the adapter rejects the combination as `INVALID_INPUT`. Milestones
   * must be released in the order declared in the original
   * `MilestoneCondition.milestones` array; ordering is enforced at the
   * adapter-bookkeeping layer, not in the domain.
   */
  release(input: ReleaseEscrowInput): Promise<ReleaseEscrowResult>;

  /**
   * Open a dispute on the escrow. Returns a `disputeId`; subsequent
   * evidence submission goes through `DisputePort.submitEvidence`, not
   * through this port. The entity transitions to `disputed` and can only
   * resolve to `released` or `refunded`.
   */
  dispute(input: DisputeEscrowInput): Promise<DisputeEscrowResult>;
}

export interface HoldEscrowInput {
  readonly consumer: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly amount: Money;
  readonly milestoneCondition?: MilestoneCondition;
  readonly platformFeeMinor?: bigint;
  readonly platformFeeDestination?: string;
  readonly releaseAfter?: Date;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface HoldEscrowResult {
  readonly gatewayRef: GatewayRef;
  readonly status: Escrow['status'];
}

export interface ReleaseEscrowInput {
  readonly gatewayRef: GatewayRef;
  /** Optional milestone string from the original `milestoneCondition`. */
  readonly milestone?: string;
  /** Optional partial amount. Omit to release the entire remaining balance. */
  readonly amount?: Money;
  readonly idempotencyKey: IdempotencyKey;
}

export interface ReleaseEscrowResult {
  readonly gatewayRef: GatewayRef;
  readonly status: Escrow['status'];
  readonly releasedAmount: Money;
}

export interface DisputeEscrowInput {
  readonly gatewayRef: GatewayRef;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly idempotencyKey: IdempotencyKey;
}

export interface DisputeEscrowResult {
  readonly gatewayRef: GatewayRef;
  readonly disputeId: string;
  readonly status: Escrow['status'];
}

// ---------------------------------------------------------------------------
// 4. WebhookVerifierPort
// ---------------------------------------------------------------------------

/**
 * Verifies gateway-signed webhook payloads and decodes them into a domain
 * event. One implementation per gateway.
 */
export interface WebhookVerifierPort {
  readonly gateway: GatewayName;

  verify(input: VerifyWebhookInput): Promise<WebhookEvent>;
}

export interface VerifyWebhookInput {
  readonly signature: string;
  readonly payload: Uint8Array;
  readonly receivedAt: Date;
  readonly idempotencyKey: IdempotencyKey;
}

// ---------------------------------------------------------------------------
// 5. IdempotencyPort
// ---------------------------------------------------------------------------

/**
 * Persistent idempotency tracker. The default implementation (Postgres)
 * lands with `application-use-cases`.
 */
export interface IdempotencyPort {
  /** Returns the previously-committed result if any, else null. */
  check<T>(key: IdempotencyKey): Promise<T | null>;
  /** Commits a (key, result) pair. Throws IdempotencyConflictError on mismatch. */
  commit<T>(key: IdempotencyKey, result: T): Promise<void>;
}

// ---------------------------------------------------------------------------
// 6. ReconciliationPort
// ---------------------------------------------------------------------------

/**
 * Reads the gateway ledger for a UTC day and returns the diff against the
 * local ledger. Implemented by Stripe, OnvoPay, Tilopay.
 */
export interface ReconciliationPort {
  readonly gateway: GatewayName;

  reconcileDaily(input: ReconcileDailyInput): Promise<ReconcileDailyResult>;
}

export interface ReconcileDailyInput {
  /** UTC calendar day, formatted YYYY-MM-DD. */
  readonly date: string;
}

export interface ReconcileDailyResult {
  readonly date: string;
  readonly matchedCount: number;
  readonly diffs: readonly ReconciliationDiff[];
}

// ---------------------------------------------------------------------------
// 7. AgenticPaymentPort
// ---------------------------------------------------------------------------

/**
 * Agentic commerce entry point. Consumed by agentic-core; implementation
 * details (scoped JWT verification, audit trail requirements, tool-call-id
 * correlation) live in `openspec/changes/agentic-core-extension` and
 * `openspec/changes/stripe-agentic-commerce-p1`.
 */
export interface AgenticPaymentPort {
  initiateAgenticPayment(
    input: InitiateAgenticPaymentInput,
  ): Promise<InitiateAgenticPaymentResult>;
}

export interface InitiateAgenticPaymentInput {
  readonly consumer: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly auditJwt: string;
  readonly customerReference: string;
  readonly amount: Money;
  readonly description?: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface InitiateAgenticPaymentResult {
  readonly intentId: string;
  readonly gatewayRef: GatewayRef;
  readonly status: PaymentIntent['status'];
}

// ---------------------------------------------------------------------------
// 8. FXRatePort
// ---------------------------------------------------------------------------

/**
 * Look up a spot FX rate for a currency pair. Returned rate is expressed as
 * `(1 unit of base) → rate × (1 unit of quote)` in canonical decimal form.
 * Used by cross-border payout and reconciliation logic.
 */
export interface FXRatePort {
  lookup(input: FXRateLookupInput): Promise<FXRateLookupResult>;
}

export interface FXRateLookupInput {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly asOf?: Date;
}

export interface FXRateLookupResult {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  /** Decimal rate as a string to preserve precision across JSON transport. */
  readonly rate: string;
  readonly asOf: Date;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// 9. DisputePort
// ---------------------------------------------------------------------------

/**
 * Submits dispute evidence to the gateway. Separate from `EscrowPort.dispute`
 * because card-issuer chargebacks (Stripe, OnvoPay, Tilopay disputes API)
 * have a different shape from escrow disputes (escrow only releases vs
 * refunds); both patterns coexist.
 */
export interface DisputePort {
  readonly gateway: GatewayName;

  submitEvidence(input: SubmitDisputeEvidenceInput): Promise<SubmitDisputeEvidenceResult>;
}

export interface SubmitDisputeEvidenceInput {
  readonly gatewayRef: GatewayRef;
  readonly evidence: readonly string[];
  readonly idempotencyKey: IdempotencyKey;
}

export interface SubmitDisputeEvidenceResult {
  readonly gatewayRef: GatewayRef;
  readonly status: Dispute['status'];
}

// ---------------------------------------------------------------------------
// 10. DonationPort — one-time + recurring donations for altrupets-api et al.
// ---------------------------------------------------------------------------

/**
 * Donations are distinct from generic `PaymentGatewayPort.initiate` because
 * they carry donation-specific semantics: a `campaignId` metadata hook
 * (opaque to payments-core, owned by the consumer backend), a recurrence
 * specification for monthly/yearly giving, and donor-visibility flags that
 * gate receipt-email delivery on the gateway side.
 *
 * Implementations are thin wrappers around the gateway's charge/subscription
 * surfaces that tag the outbound metadata map with donation markers. See
 * `openspec/changes/donations-port/` for the full rationale and the
 * `crowdfunding-deferred` cross-reference.
 */
export interface DonationPort {
  readonly gateway: GatewayName;

  /**
   * One-shot donation. Returns the donation id assigned by payments-core
   * and the gateway's opaque external reference.
   */
  initiateOneTime(input: InitiateOneTimeDonationInput): Promise<InitiateDonationResult>;

  /**
   * Sets up a recurring donation schedule on the gateway. The first charge
   * may happen synchronously or asynchronously depending on the gateway;
   * the returned `gatewayRef` is the gateway's recurring-plan id, reusable
   * as the handle passed to `pauseRecurring` / `cancelRecurring`.
   */
  initiateRecurring(input: InitiateRecurringDonationInput): Promise<InitiateDonationResult>;

  /**
   * Pauses an active recurring donation. Idempotent by `idempotencyKey`:
   * pausing an already-paused schedule is a no-op and resolves successfully.
   */
  pauseRecurring(gatewayRef: GatewayRef, idempotencyKey: IdempotencyKey): Promise<void>;

  /**
   * Cancels a recurring donation. Idempotent by `idempotencyKey`: cancelling
   * an already-cancelled schedule is a no-op and resolves successfully.
   * The consumer backend still retains the historical `Donation` records.
   */
  cancelRecurring(gatewayRef: GatewayRef, idempotencyKey: IdempotencyKey): Promise<void>;
}

/**
 * Interval specification for recurring donations. `custom.daysBetween` lets
 * consumers request cadences the gateway does not model natively (the
 * adapter maps it to the nearest supported period or raises
 * `GatewayUnsupportedFeature` if the gateway rejects it).
 */
export type DonationRecurrence =
  | { readonly interval: 'month'; readonly count: 1 }
  | { readonly interval: 'year'; readonly count: 1 }
  | { readonly interval: 'custom'; readonly daysBetween: number };

export type DonorVisibility = 'anonymous' | 'public' | 'pseudonymous';

export interface InitiateOneTimeDonationInput {
  readonly amount: Money;
  readonly consumer: string;
  readonly donorReference: string;
  /**
   * Opaque campaign id. AltruPets attaches its own cause id here. Empty
   * string means "no campaign"; callers that have no campaign pass `null`
   * which the application layer coerces to empty before calling the port.
   */
  readonly campaignId: string | null;
  readonly donorVisibility: DonorVisibility;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
}

export interface InitiateRecurringDonationInput {
  readonly amount: Money;
  readonly consumer: string;
  readonly donorReference: string;
  readonly campaignId: string | null;
  readonly donorVisibility: DonorVisibility;
  readonly recurrence: DonationRecurrence;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
}

export interface InitiateDonationResult {
  readonly donationId: string;
  readonly gatewayRef: GatewayRef;
  readonly requiresAction: boolean;
  readonly challenge?: ThreeDSChallenge;
  readonly checkoutUrl?: string;
}

/**
 * Compact reference returned by the donation use cases. The `gatewayRef`
 * is the handle callers must present to pause/cancel a recurring donation.
 */
export interface DonationRef {
  readonly donationId: string;
  readonly gatewayRef: GatewayRef;
  readonly kind: Donation['kind'];
}

// ---------------------------------------------------------------------------
// Re-exports consumed by `src/domain/index.ts`.
// ---------------------------------------------------------------------------

export type { Payout, Refund };
