// =============================================================================
// Subscription use cases — 3 of 14 (proto RPCs: CreateSubscription,
// SwitchSubscription, CancelSubscription).
// -----------------------------------------------------------------------------
// All three orchestrate `SubscriptionPort` calls and persist the domain
// `Subscription` entity. Recurring billing cycles (the `past_due` transitions)
// land via webhooks, not via direct RPC — see `webhook.ts`.
// =============================================================================

import {
  createSubscription,
  transitionSubscription,
  DomainError,
  err,
  ok,
  type GatewayName,
  type IdempotencyKey,
  type IdempotencyPort,
  type Subscription,
  type SubscriptionPort,
  type Result,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Ports local to the application layer
// ---------------------------------------------------------------------------

export interface SubscriptionRepositoryPort {
  save(subscription: Subscription): Promise<void>;
  findById(id: string): Promise<Subscription | null>;
}

export interface SubscriptionRegistryPort {
  resolveSubscriptionGateway(gateway: GatewayName): SubscriptionPort;
}

// =============================================================================
// 4. CreateSubscription
// =============================================================================

export interface CreateSubscriptionInput {
  readonly id: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly planId: string;
  readonly gateway: GatewayName;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateSubscriptionOutput {
  readonly subscription: Subscription;
}

export interface CreateSubscriptionDeps {
  readonly gateways: SubscriptionRegistryPort;
  readonly repo: SubscriptionRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeCreateSubscription =
  (deps: CreateSubscriptionDeps) =>
  async (
    input: CreateSubscriptionInput,
  ): Promise<Result<CreateSubscriptionOutput, DomainError>> => {
    const cached = await deps.idempotency.check<CreateSubscriptionOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const subscription = createSubscription({
      id: input.id,
      consumer: input.consumer,
      customerReference: input.customerReference,
      planId: input.planId,
      idempotencyKey: input.idempotencyKey,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    const gateway = deps.gateways.resolveSubscriptionGateway(input.gateway);

    let gatewayResult;
    try {
      gatewayResult = await gateway.create({
        consumer: input.consumer,
        customerReference: input.customerReference,
        planId: input.planId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
      });
    } catch (e) {
      return wrapError(e);
    }

    let advanced: Subscription;
    try {
      advanced = transitionSubscription(subscription, {
        to: gatewayResult.status,
        gatewayRef: gatewayResult.gatewayRef,
      });
    } catch (e) {
      return wrapError(e);
    }

    await deps.repo.save(advanced);
    const out: CreateSubscriptionOutput = { subscription: advanced };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// 5. SwitchSubscription
// =============================================================================

export interface SwitchSubscriptionInput {
  readonly subscriptionId: string;
  readonly newPlanId: string;
  readonly prorationBehavior: 'create_prorations' | 'none' | 'always_invoice';
  readonly idempotencyKey: IdempotencyKey;
}

export interface SwitchSubscriptionOutput {
  readonly subscription: Subscription;
}

export interface SwitchSubscriptionDeps {
  readonly gateways: SubscriptionRegistryPort;
  readonly repo: SubscriptionRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeSwitchSubscription =
  (deps: SwitchSubscriptionDeps) =>
  async (
    input: SwitchSubscriptionInput,
  ): Promise<Result<SwitchSubscriptionOutput, DomainError>> => {
    const cached = await deps.idempotency.check<SwitchSubscriptionOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const existing = await deps.repo.findById(input.subscriptionId);
    if (existing === null || existing.gatewayRef === null) {
      return err(
        new DomainError(
          'APPLICATION_SUBSCRIPTION_NOT_FOUND',
          `Subscription '${input.subscriptionId}' not found or missing gatewayRef.`,
        ),
      );
    }

    const gateway = deps.gateways.resolveSubscriptionGateway(
      existing.gatewayRef.gateway,
    );

    let gatewayResult;
    try {
      gatewayResult = await gateway.switch({
        gatewayRef: existing.gatewayRef,
        newPlanId: input.newPlanId,
        prorationBehavior: input.prorationBehavior,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      return wrapError(e);
    }

    // Switching a plan does not change the subscription status in the
    // domain (active → active). Persist the refreshed entity with any
    // updated gateway ref metadata. Plan id is gateway-side; the domain
    // entity tracks `planId` too, so we update it.
    const updated: Subscription = {
      ...existing,
      planId: input.newPlanId,
      status: gatewayResult.status,
    };
    await deps.repo.save(updated);
    const out: SwitchSubscriptionOutput = { subscription: updated };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// 6. CancelSubscription
// =============================================================================

export interface CancelSubscriptionInput {
  readonly subscriptionId: string;
  readonly atPeriodEnd: boolean;
  readonly reason?: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface CancelSubscriptionOutput {
  readonly subscription: Subscription;
  readonly effectiveAt: Date;
}

export interface CancelSubscriptionDeps {
  readonly gateways: SubscriptionRegistryPort;
  readonly repo: SubscriptionRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeCancelSubscription =
  (deps: CancelSubscriptionDeps) =>
  async (
    input: CancelSubscriptionInput,
  ): Promise<Result<CancelSubscriptionOutput, DomainError>> => {
    const cached = await deps.idempotency.check<CancelSubscriptionOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const existing = await deps.repo.findById(input.subscriptionId);
    if (existing === null || existing.gatewayRef === null) {
      return err(
        new DomainError(
          'APPLICATION_SUBSCRIPTION_NOT_FOUND',
          `Subscription '${input.subscriptionId}' not found or missing gatewayRef.`,
        ),
      );
    }

    const gateway = deps.gateways.resolveSubscriptionGateway(
      existing.gatewayRef.gateway,
    );

    let gatewayResult;
    try {
      gatewayResult = await gateway.cancel({
        gatewayRef: existing.gatewayRef,
        atPeriodEnd: input.atPeriodEnd,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      return wrapError(e);
    }

    // The domain cancellation transition fires even when the gateway marked
    // the sub as `canceled` at period end — `gatewayResult.status` carries
    // the current gateway status, which we trust.
    let advanced: Subscription;
    try {
      advanced =
        gatewayResult.status === 'canceled'
          ? transitionSubscription(existing, { to: 'canceled' })
          : { ...existing, status: gatewayResult.status };
    } catch (e) {
      return wrapError(e);
    }

    await deps.repo.save(advanced);
    const out: CancelSubscriptionOutput = {
      subscription: advanced,
      effectiveAt: gatewayResult.effectiveAt,
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function wrapError<T>(e: unknown): Result<T, DomainError> {
  if (e instanceof DomainError) return err(e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(new DomainError('APPLICATION_UNEXPECTED', msg));
}
