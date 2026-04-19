// =============================================================================
// Payout use case — 1 of 14 (proto RPC: CreatePayout).
// -----------------------------------------------------------------------------
// Standalone file because payouts are the only use case in their sub-domain.
// Kept separate (rather than folded into `checkout.ts`) because payouts
// consume a different port (`PayoutGatewayPort`) and their lifecycle is
// disjoint from the PaymentIntent state machine.
//
// The domain layer ships a `Payout` entity but does not yet declare a
// `PayoutPort` — the outbound interface is declared here in the application
// layer where it belongs (cf. `design.md` note: no port proliferation in
// `src/domain/ports/` beyond the initial nine). Outbound adapters implement
// this port alongside the `PaymentGatewayPort` they already implement.
// =============================================================================

import {
  createPayout,
  transitionPayout,
  DomainError,
  err,
  ok,
  type GatewayName,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type Money,
  type Payout,
  type PayoutStatus,
  type Result,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Ports local to the application layer
// ---------------------------------------------------------------------------

/**
 * Outbound port for creating payouts at the gateway. Implementations: Stripe
 * Transfers, OnvoPay payouts, Ripple-XRPL cross-border payout. Declared in
 * the application layer rather than the domain layer because payouts are
 * the only entity whose lifecycle does not require a matching domain port.
 */
export interface PayoutGatewayPort {
  readonly gateway: GatewayName;

  createPayout(input: CreatePayoutPortInput): Promise<CreatePayoutPortResult>;
}

export interface CreatePayoutPortInput {
  readonly amount: Money;
  readonly beneficiaryReference: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: Readonly<Record<string, string>>;
  readonly description?: string;
}

export interface CreatePayoutPortResult {
  readonly gatewayRef: GatewayRef;
  readonly status: PayoutStatus;
}

export interface PayoutRepositoryPort {
  save(payout: Payout): Promise<void>;
  findById(id: string): Promise<Payout | null>;
}

export interface PayoutRegistryPort {
  resolvePayoutGateway(gateway: GatewayName): PayoutGatewayPort;
}

// =============================================================================
// 10. CreatePayout
// =============================================================================

export interface CreatePayoutInput {
  readonly id: string;
  readonly consumer: string;
  readonly beneficiaryReference: string;
  readonly amount: Money;
  readonly gateway: GatewayName;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly description?: string;
}

export interface CreatePayoutOutput {
  readonly payout: Payout;
}

export interface CreatePayoutDeps {
  readonly gateways: PayoutRegistryPort;
  readonly repo: PayoutRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeCreatePayout =
  (deps: CreatePayoutDeps) =>
  async (
    input: CreatePayoutInput,
  ): Promise<Result<CreatePayoutOutput, DomainError>> => {
    const cached = await deps.idempotency.check<CreatePayoutOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const payout = createPayout({
      id: input.id,
      consumer: input.consumer,
      beneficiaryReference: input.beneficiaryReference,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    const gateway = deps.gateways.resolvePayoutGateway(input.gateway);

    let gatewayResult: CreatePayoutPortResult;
    try {
      gatewayResult = await gateway.createPayout({
        amount: input.amount,
        beneficiaryReference: input.beneficiaryReference,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (e) {
      return wrapError(e);
    }

    // Payouts start `pending` at the gateway and may already be `paid` or
    // `failed` synchronously (rare). Advance if the gateway moved faster.
    let advanced: Payout = { ...payout, gatewayRef: gatewayResult.gatewayRef };
    if (gatewayResult.status !== 'pending') {
      try {
        advanced = transitionPayout(advanced, gatewayResult.status, gatewayResult.gatewayRef);
      } catch (e) {
        return wrapError(e);
      }
    }

    await deps.repo.save(advanced);
    const out: CreatePayoutOutput = { payout: advanced };
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
