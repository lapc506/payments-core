// =============================================================================
// Donation use cases — 3 orchestrators on top of `DonationPort`.
// -----------------------------------------------------------------------------
// Implements the AltruPets-driven donation flows (one-time + recurring +
// pause/cancel) declared in `openspec/changes/donations-port/`. The
// `campaign_id` metadata hook is carried end-to-end as an opaque string;
// payments-core never interprets it — consumer backends model campaigns.
//
// Three use cases:
//   1. CreateOneTimeDonation    — validates Money, idempotency-checks, calls
//                                  `DonationPort.initiateOneTime`, persists
//                                  the `Donation` entity, returns DonationRef.
//   2. CreateRecurringDonation  — same shape as (1) but with a recurrence spec
//                                  and the `recurring` donation kind.
//   3. ManageRecurringDonation  — pause/cancel via a discriminated union
//                                  input. Lookup is by gatewayRef (the
//                                  subscription-like handle returned by
//                                  `initiateRecurring`).
//
// Pause/cancel do NOT transition the stored `Donation` record: a recurring
// donation's Donation-entity row captures a single charge event, not the
// schedule itself. The schedule lives gateway-side, addressed by gatewayRef.
// =============================================================================

import {
  createDonation,
  DomainError,
  err,
  InvalidMoneyError,
  ok,
  type Donation,
  type DonationPort,
  type DonationRecurrence,
  type DonationRef,
  type DonorVisibility,
  type GatewayName,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type Money,
  type Result,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Ports local to the application layer
// ---------------------------------------------------------------------------

export interface DonationRepositoryPort {
  save(donation: Donation): Promise<void>;
  findById(id: string): Promise<Donation | null>;
}

export interface DonationRegistryPort {
  resolveDonationGateway(gateway: GatewayName): DonationPort;
}

// ---------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------

export interface CreateDonationCommonInput {
  readonly id: string;
  readonly consumer: string;
  readonly donorReference: string;
  readonly amount: Money;
  readonly gateway: GatewayName;
  /** Opaque campaign id. `null` means "no campaign attached". */
  readonly campaignId: string | null;
  readonly donorVisibility: DonorVisibility;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
}

// =============================================================================
// CreateOneTimeDonation
// =============================================================================

export type CreateOneTimeDonationInput = CreateDonationCommonInput;

export interface CreateOneTimeDonationOutput {
  readonly ref: DonationRef;
  readonly donation: Donation;
  readonly requiresAction: boolean;
  readonly checkoutUrl?: string;
}

export interface CreateOneTimeDonationDeps {
  readonly gateways: DonationRegistryPort;
  readonly repo: DonationRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeCreateOneTimeDonation =
  (deps: CreateOneTimeDonationDeps) =>
  async (
    input: CreateOneTimeDonationInput,
  ): Promise<Result<CreateOneTimeDonationOutput, DomainError>> => {
    const cached = await deps.idempotency.check<CreateOneTimeDonationOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const validation = validateDonationAmount(input.amount);
    if (!validation.ok) return validation;

    const metadata = enrichDonationMetadata(input.metadata, input.campaignId, input.donorVisibility);

    const donation = createDonation({
      id: input.id,
      consumer: input.consumer,
      donorReference: input.donorReference,
      campaignId: input.campaignId ?? '',
      kind: 'one_time',
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      metadata,
    });

    const gateway = deps.gateways.resolveDonationGateway(input.gateway);

    let gatewayResult;
    try {
      gatewayResult = await gateway.initiateOneTime({
        amount: input.amount,
        consumer: input.consumer,
        donorReference: input.donorReference,
        campaignId: input.campaignId,
        donorVisibility: input.donorVisibility,
        idempotencyKey: input.idempotencyKey,
        metadata,
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
      });
    } catch (e) {
      return wrapError(e);
    }

    const persisted: Donation = {
      ...donation,
      status: 'pending',
      gatewayRef: gatewayResult.gatewayRef,
    };
    await deps.repo.save(persisted);

    const ref: DonationRef = {
      donationId: persisted.id,
      gatewayRef: gatewayResult.gatewayRef,
      kind: 'one_time',
    };
    const out: CreateOneTimeDonationOutput = {
      ref,
      donation: persisted,
      requiresAction: gatewayResult.requiresAction,
      ...(gatewayResult.checkoutUrl !== undefined
        ? { checkoutUrl: gatewayResult.checkoutUrl }
        : {}),
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// CreateRecurringDonation
// =============================================================================

export interface CreateRecurringDonationInput extends CreateDonationCommonInput {
  readonly recurrence: DonationRecurrence;
}

export interface CreateRecurringDonationOutput {
  readonly ref: DonationRef;
  readonly donation: Donation;
  readonly requiresAction: boolean;
  readonly checkoutUrl?: string;
}

export interface CreateRecurringDonationDeps {
  readonly gateways: DonationRegistryPort;
  readonly repo: DonationRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeCreateRecurringDonation =
  (deps: CreateRecurringDonationDeps) =>
  async (
    input: CreateRecurringDonationInput,
  ): Promise<Result<CreateRecurringDonationOutput, DomainError>> => {
    const cached = await deps.idempotency.check<CreateRecurringDonationOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const validation = validateDonationAmount(input.amount);
    if (!validation.ok) return validation;

    const metadata = enrichDonationMetadata(
      input.metadata,
      input.campaignId,
      input.donorVisibility,
      input.recurrence,
    );

    const donation = createDonation({
      id: input.id,
      consumer: input.consumer,
      donorReference: input.donorReference,
      campaignId: input.campaignId ?? '',
      kind: 'recurring',
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      metadata,
    });

    const gateway = deps.gateways.resolveDonationGateway(input.gateway);

    let gatewayResult;
    try {
      gatewayResult = await gateway.initiateRecurring({
        amount: input.amount,
        consumer: input.consumer,
        donorReference: input.donorReference,
        campaignId: input.campaignId,
        donorVisibility: input.donorVisibility,
        recurrence: input.recurrence,
        idempotencyKey: input.idempotencyKey,
        metadata,
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
      });
    } catch (e) {
      return wrapError(e);
    }

    const persisted: Donation = {
      ...donation,
      status: 'pending',
      gatewayRef: gatewayResult.gatewayRef,
    };
    await deps.repo.save(persisted);

    const ref: DonationRef = {
      donationId: persisted.id,
      gatewayRef: gatewayResult.gatewayRef,
      kind: 'recurring',
    };
    const out: CreateRecurringDonationOutput = {
      ref,
      donation: persisted,
      requiresAction: gatewayResult.requiresAction,
      ...(gatewayResult.checkoutUrl !== undefined
        ? { checkoutUrl: gatewayResult.checkoutUrl }
        : {}),
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// ManageRecurringDonation — discriminated union: pause | cancel
// =============================================================================

export type ManageRecurringDonationInput =
  | {
      readonly action: 'pause';
      readonly gatewayRef: GatewayRef;
      readonly idempotencyKey: IdempotencyKey;
    }
  | {
      readonly action: 'cancel';
      readonly gatewayRef: GatewayRef;
      readonly idempotencyKey: IdempotencyKey;
    };

export interface ManageRecurringDonationOutput {
  readonly action: 'pause' | 'cancel';
  readonly gatewayRef: GatewayRef;
}

export interface ManageRecurringDonationDeps {
  readonly gateways: DonationRegistryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeManageRecurringDonation =
  (deps: ManageRecurringDonationDeps) =>
  async (
    input: ManageRecurringDonationInput,
  ): Promise<Result<ManageRecurringDonationOutput, DomainError>> => {
    const cached = await deps.idempotency.check<ManageRecurringDonationOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const gateway = deps.gateways.resolveDonationGateway(input.gatewayRef.gateway);

    try {
      if (input.action === 'pause') {
        await gateway.pauseRecurring(input.gatewayRef, input.idempotencyKey);
      } else {
        await gateway.cancelRecurring(input.gatewayRef, input.idempotencyKey);
      }
    } catch (e) {
      return wrapError(e);
    }

    const out: ManageRecurringDonationOutput = {
      action: input.action,
      gatewayRef: input.gatewayRef,
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateDonationAmount(amount: Money): Result<true, DomainError> {
  if (amount.isZero()) {
    return err(new InvalidMoneyError('Donation amount must be greater than zero.'));
  }
  // Negative amounts are already rejected by `Money.of`/`Money.create`; this
  // is a second line of defence in case a caller constructs a Money via an
  // untyped back door.
  if (amount.amountMinor < 0n) {
    return err(
      new InvalidMoneyError(
        `Donation amount must be non-negative; got ${amount.amountMinor}`,
      ),
    );
  }
  return ok(true);
}

function enrichDonationMetadata(
  base: Readonly<Record<string, string>> | undefined,
  campaignId: string | null,
  donorVisibility: DonorVisibility,
  recurrence?: DonationRecurrence,
): Readonly<Record<string, string>> {
  const enriched: Record<string, string> = { ...(base ?? {}) };
  enriched['donation'] = 'true';
  enriched['donor_visibility'] = donorVisibility;
  if (campaignId !== null && campaignId.length > 0) {
    enriched['campaign_id'] = campaignId;
  }
  if (recurrence !== undefined) {
    enriched['recurrence_interval'] = recurrence.interval;
    if (recurrence.interval === 'custom') {
      enriched['recurrence_days_between'] = String(recurrence.daysBetween);
    } else {
      enriched['recurrence_count'] = String(recurrence.count);
    }
  }
  return enriched;
}

function wrapError<T>(e: unknown): Result<T, DomainError> {
  if (e instanceof DomainError) return err(e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(new DomainError('APPLICATION_UNEXPECTED', msg));
}
