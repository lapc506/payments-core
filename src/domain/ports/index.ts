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

import type { Dispute } from '../entities/simple-entities.js';
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
 * the contract documented in `openspec/changes/aduanext-integration-needs/`.
 *
 * Implemented by Stripe Connect, OnvoPay, Tilopay.
 */
export interface EscrowPort {
  readonly gateway: GatewayName;

  hold(input: HoldEscrowInput): Promise<HoldEscrowResult>;
  release(input: ReleaseEscrowInput): Promise<ReleaseEscrowResult>;
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
// Re-exports consumed by `src/domain/index.ts`.
// ---------------------------------------------------------------------------

export type { Payout, Refund };
