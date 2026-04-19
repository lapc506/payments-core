// =============================================================================
// Escrow use cases — 3 of 14 (proto RPCs: HoldEscrow, ReleaseEscrow,
// DisputeEscrow).
// -----------------------------------------------------------------------------
// The `milestone_condition`, `platform_fee_minor`, and
// `platform_fee_destination` fields honor the AduaNext contract documented
// in `openspec/changes/aduanext-integration-needs/`.
//
// `milestone` on release is an opaque string — the domain doesn't interpret
// it. Partial releases are supported via the optional `amount` param.
// =============================================================================

import {
  Money,
  createEscrow,
  transitionEscrow,
  DisputeOngoingError,
  DomainError,
  err,
  ok,
  type Escrow,
  type EscrowPort,
  type EscrowStatus,
  type GatewayName,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type MilestoneCondition,
  type Result,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Ports local to the application layer
// ---------------------------------------------------------------------------

export interface EscrowRepositoryPort {
  save(escrow: Escrow): Promise<void>;
  findById(id: string): Promise<Escrow | null>;
}

export interface EscrowRegistryPort {
  resolveEscrowGateway(gateway: GatewayName): EscrowPort;
}

// =============================================================================
// 7. HoldEscrow
// =============================================================================

export interface HoldEscrowInput {
  readonly id: string;
  readonly consumer: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly amount: Money;
  readonly gateway: GatewayName;
  readonly milestoneCondition?: MilestoneCondition;
  readonly platformFeeMinor?: bigint;
  readonly platformFeeDestination?: string;
  readonly releaseAfter?: Date;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface HoldEscrowOutput {
  readonly escrow: Escrow;
}

export interface HoldEscrowDeps {
  readonly gateways: EscrowRegistryPort;
  readonly repo: EscrowRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeHoldEscrow =
  (deps: HoldEscrowDeps) =>
  async (input: HoldEscrowInput): Promise<Result<HoldEscrowOutput, DomainError>> => {
    const cached = await deps.idempotency.check<HoldEscrowOutput>(input.idempotencyKey);
    if (cached !== null) return ok(cached);

    const escrow = createEscrow({
      id: input.id,
      consumer: input.consumer,
      payerReference: input.payerReference,
      payeeReference: input.payeeReference,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      ...(input.milestoneCondition !== undefined
        ? { milestoneCondition: input.milestoneCondition }
        : {}),
      ...(input.platformFeeMinor !== undefined
        ? { platformFeeMinor: input.platformFeeMinor }
        : {}),
      ...(input.platformFeeDestination !== undefined
        ? { platformFeeDestination: input.platformFeeDestination }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    const gateway = deps.gateways.resolveEscrowGateway(input.gateway);

    let gatewayResult;
    try {
      gatewayResult = await gateway.hold({
        consumer: input.consumer,
        payerReference: input.payerReference,
        payeeReference: input.payeeReference,
        amount: input.amount,
        ...(input.milestoneCondition !== undefined
          ? { milestoneCondition: input.milestoneCondition }
          : {}),
        ...(input.platformFeeMinor !== undefined
          ? { platformFeeMinor: input.platformFeeMinor }
          : {}),
        ...(input.platformFeeDestination !== undefined
          ? { platformFeeDestination: input.platformFeeDestination }
          : {}),
        ...(input.releaseAfter !== undefined ? { releaseAfter: input.releaseAfter } : {}),
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
      });
    } catch (e) {
      return wrapError(e);
    }

    // Attach the gateway ref; the entity is already `held` from createEscrow.
    const persisted: Escrow = { ...escrow, gatewayRef: gatewayResult.gatewayRef };
    await deps.repo.save(persisted);
    const out: HoldEscrowOutput = { escrow: persisted };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// 8. ReleaseEscrow
// =============================================================================

export interface ReleaseEscrowInput {
  readonly escrowId: string;
  /** Opaque milestone string; must match one of the original
   *  `milestoneCondition.milestones` if milestones were set. */
  readonly milestone?: string;
  /** Optional partial amount. Omit to release the full remaining balance. */
  readonly amount?: Money;
  readonly idempotencyKey: IdempotencyKey;
}

export interface ReleaseEscrowOutput {
  readonly escrow: Escrow;
  readonly releasedAmount: Money;
  readonly gatewayRef: GatewayRef;
}

export interface ReleaseEscrowDeps {
  readonly gateways: EscrowRegistryPort;
  readonly repo: EscrowRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeReleaseEscrow =
  (deps: ReleaseEscrowDeps) =>
  async (
    input: ReleaseEscrowInput,
  ): Promise<Result<ReleaseEscrowOutput, DomainError>> => {
    const cached = await deps.idempotency.check<ReleaseEscrowOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const existing = await deps.repo.findById(input.escrowId);
    if (existing === null || existing.gatewayRef === null) {
      return err(
        new DomainError(
          'APPLICATION_ESCROW_NOT_FOUND',
          `Escrow '${input.escrowId}' not found or missing gatewayRef.`,
        ),
      );
    }

    const gateway = deps.gateways.resolveEscrowGateway(existing.gatewayRef.gateway);

    let gatewayResult;
    try {
      gatewayResult = await gateway.release({
        gatewayRef: existing.gatewayRef,
        ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      return wrapError(e);
    }

    // A `released` gateway status is authoritative — the escrow has fully
    // settled. For partial releases, the gateway replies with
    // `status === 'held'` and the escrow stays in the same state.
    const advanced = applyEscrowStatus(existing, gatewayResult.status);
    // The domain's `createEscrow` initializes `releasedAmount` as a plain
    // object literal rather than a real `Money` instance, so `.add()` is
    // unavailable. We sum amounts directly and rebuild the `Money` via the
    // smart constructor to restore instance methods.
    const releasedAccum = Money.of(
      existing.releasedAmount.amountMinor + gatewayResult.releasedAmount.amountMinor,
      existing.releasedAmount.currency,
    );
    const persisted: Escrow = { ...advanced, releasedAmount: releasedAccum };
    await deps.repo.save(persisted);
    const out: ReleaseEscrowOutput = {
      escrow: persisted,
      releasedAmount: gatewayResult.releasedAmount,
      gatewayRef: gatewayResult.gatewayRef,
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// 9. DisputeEscrow
// =============================================================================

export interface DisputeEscrowInput {
  readonly escrowId: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly idempotencyKey: IdempotencyKey;
}

export interface DisputeEscrowOutput {
  readonly escrow: Escrow;
  readonly disputeId: string;
}

export interface DisputeEscrowDeps {
  readonly gateways: EscrowRegistryPort;
  readonly repo: EscrowRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeDisputeEscrow =
  (deps: DisputeEscrowDeps) =>
  async (
    input: DisputeEscrowInput,
  ): Promise<Result<DisputeEscrowOutput, DomainError>> => {
    const cached = await deps.idempotency.check<DisputeEscrowOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const existing = await deps.repo.findById(input.escrowId);
    if (existing === null || existing.gatewayRef === null) {
      return err(
        new DomainError(
          'APPLICATION_ESCROW_NOT_FOUND',
          `Escrow '${input.escrowId}' not found or missing gatewayRef.`,
        ),
      );
    }
    if (existing.status === 'disputed') {
      return err(new DisputeOngoingError(existing.id));
    }

    const gateway = deps.gateways.resolveEscrowGateway(existing.gatewayRef.gateway);

    let gatewayResult;
    try {
      gatewayResult = await gateway.dispute({
        gatewayRef: existing.gatewayRef,
        reason: input.reason,
        evidence: input.evidence,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      return wrapError(e);
    }

    let advanced: Escrow;
    try {
      advanced = transitionEscrow(existing, { to: 'disputed' });
    } catch (e) {
      return wrapError(e);
    }
    await deps.repo.save(advanced);
    const out: DisputeEscrowOutput = {
      escrow: advanced,
      disputeId: gatewayResult.disputeId,
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyEscrowStatus(escrow: Escrow, next: EscrowStatus): Escrow {
  if (escrow.status === next) return escrow;
  return transitionEscrow(escrow, { to: next });
}

function wrapError<T>(e: unknown): Result<T, DomainError> {
  if (e instanceof DomainError) return err(e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(new DomainError('APPLICATION_UNEXPECTED', msg));
}
