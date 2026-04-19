// =============================================================================
// Agentic use case — 1 of 14 (proto RPC: InitiateAgenticPayment).
// -----------------------------------------------------------------------------
// Entry point for `agentic-core`. Wraps `AgenticPaymentPort.initiateAgenticPayment`
// and persists the resulting `PaymentIntent` tagged with
// `agent_initiated=true` in its metadata.
//
// Scoped-JWT verification is out of scope here — the actual verification
// logic lives in `openspec/changes/agentic-core-extension/` and
// `openspec/changes/stripe-agentic-commerce-p1/`. This use case accepts the
// `auditJwt` string and forwards it to the port; downstream verification
// failure surfaces as a gateway error.
// =============================================================================

import {
  createPaymentIntent,
  transitionPaymentIntent,
  DomainError,
  err,
  ok,
  type AgenticPaymentPort,
  type IdempotencyKey,
  type IdempotencyPort,
  type InitiateAgenticPaymentResult,
  type Money,
  type PaymentIntent,
  type Result,
} from '../../domain/index.js';
import type { PaymentIntentRepositoryPort } from './checkout.js';

// =============================================================================
// 12. HandleAgenticPayment
// =============================================================================

export interface HandleAgenticPaymentInput {
  readonly id: string;
  readonly consumer: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly auditJwt: string;
  readonly customerReference: string;
  readonly amount: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface HandleAgenticPaymentOutput {
  readonly intent: PaymentIntent;
  readonly gatewayResult: InitiateAgenticPaymentResult;
}

export interface HandleAgenticPaymentDeps {
  readonly agentic: AgenticPaymentPort;
  readonly repo: PaymentIntentRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

export const makeHandleAgenticPayment =
  (deps: HandleAgenticPaymentDeps) =>
  async (
    input: HandleAgenticPaymentInput,
  ): Promise<Result<HandleAgenticPaymentOutput, DomainError>> => {
    const cached = await deps.idempotency.check<HandleAgenticPaymentOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    // Stamp agentic-specific metadata onto the intent so downstream queries
    // and audit trails can filter on `agent_initiated=true`.
    const metadata: Record<string, string> = {
      ...(input.metadata ?? {}),
      agent_initiated: 'true',
      agent_id: input.agentId,
      tool_call_id: input.toolCallId,
    };

    const intent = createPaymentIntent({
      id: input.id,
      consumer: input.consumer,
      customerReference: input.customerReference,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      metadata,
    });

    let gatewayResult: InitiateAgenticPaymentResult;
    try {
      gatewayResult = await deps.agentic.initiateAgenticPayment({
        consumer: input.consumer,
        agentId: input.agentId,
        toolCallId: input.toolCallId,
        auditJwt: input.auditJwt,
        customerReference: input.customerReference,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        metadata,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (e) {
      return wrapError(e);
    }

    // Agentic payments typically return `pending` immediately; adapters are
    // responsible for advancing to `succeeded`/`failed` via webhook.
    let advanced: PaymentIntent;
    try {
      advanced = transitionPaymentIntent(intent, {
        to: gatewayResult.status,
        gatewayRef: gatewayResult.gatewayRef,
      });
    } catch (e) {
      return wrapError(e);
    }

    await deps.repo.save(advanced);
    const out: HandleAgenticPaymentOutput = { intent: advanced, gatewayResult };
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
