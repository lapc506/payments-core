// =============================================================================
// Checkout use cases — 3 of 14 (proto RPCs: InitiateCheckout, ConfirmCheckout,
// RefundPayment).
// -----------------------------------------------------------------------------
// Grouped in one file because they share the `PaymentIntent` state machine
// and the same three dependencies (gateway, intent repository, idempotency).
//
// Factory-function DI: each exported `make<UseCase>` closes over its deps
// and returns an `execute(input)` async function. See `../index.ts` header
// for the rationale.
// =============================================================================

import {
  canTransitionPaymentIntent,
  createPaymentIntent,
  transitionPaymentIntent,
  InvalidStateTransitionError,
  DomainError,
  err,
  ok,
  type ConfirmPaymentInput,
  type ConfirmPaymentResult,
  type FXRatePort,
  type GatewayName,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type InitiatePaymentResult,
  type Money,
  type PaymentGatewayPort,
  type PaymentIntent,
  type PaymentIntentStatus,
  type RefundPaymentResult,
  type Result,
  type ThreeDSChallenge,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Shared repository port — declared here, not in the domain, because
// persistence is an application-layer concern. Adapters implement this port
// (Postgres in a follow-up infra change; in-memory stub for tests).
// ---------------------------------------------------------------------------

export interface PaymentIntentRepositoryPort {
  save(intent: PaymentIntent): Promise<void>;
  findById(id: string): Promise<PaymentIntent | null>;
}

// ---------------------------------------------------------------------------
// Gateway registry — the application layer does not hardcode gateway names.
// The registry resolves a `GatewayName` to a `PaymentGatewayPort` instance.
// Wiring lives in the inbound adapter.
// ---------------------------------------------------------------------------

export interface GatewayRegistryPort {
  resolvePaymentGateway(gateway: GatewayName): PaymentGatewayPort;
}

// =============================================================================
// 1. InitiateCheckout
// =============================================================================

export interface InitiateCheckoutInput {
  readonly id: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly amount: Money;
  /** Gateway preference. `null` lets the registry auto-select (not v1). */
  readonly gateway: GatewayName;
  /** Optional FX quote target currency. When provided, the FX port is hit
   *  and the quote is stored in metadata under `fx_quote`. The gateway still
   *  transacts in `amount.currency` — FX conversion happens gateway-side. */
  readonly quoteCurrency?: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  readonly description?: string;
}

export interface InitiateCheckoutOutput {
  readonly intent: PaymentIntent;
  readonly requiresAction: boolean;
  readonly challenge?: ThreeDSChallenge;
  readonly checkoutUrl?: string;
  readonly clientSecret?: string;
}

export interface InitiateCheckoutDeps {
  readonly gateways: GatewayRegistryPort;
  readonly repo: PaymentIntentRepositoryPort;
  readonly idempotency: IdempotencyPort;
  readonly fx: FXRatePort;
}

/**
 * Create a fresh `PaymentIntent`, call the selected `PaymentGatewayPort`,
 * persist the resulting (possibly advanced) intent, and return it. Safe to
 * retry — the idempotency port short-circuits replays.
 */
export const makeInitiateCheckout =
  (deps: InitiateCheckoutDeps) =>
  async (
    input: InitiateCheckoutInput,
  ): Promise<Result<InitiateCheckoutOutput, DomainError>> => {
    const cached = await deps.idempotency.check<InitiateCheckoutOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) {
      return ok(cached);
    }

    const metadata = { ...(input.metadata ?? {}) };
    if (input.quoteCurrency !== undefined) {
      const quote = await deps.fx.lookup({
        baseCurrency: input.amount.currency,
        quoteCurrency: input.quoteCurrency,
      });
      metadata['fx_quote_base'] = quote.baseCurrency;
      metadata['fx_quote_target'] = quote.quoteCurrency;
      metadata['fx_quote_rate'] = quote.rate;
      metadata['fx_quote_source'] = quote.source;
    }

    const intent = createPaymentIntent({
      id: input.id,
      consumer: input.consumer,
      customerReference: input.customerReference,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      metadata,
    });

    const gateway = deps.gateways.resolvePaymentGateway(input.gateway);

    let gatewayResult: InitiatePaymentResult;
    try {
      gatewayResult = await gateway.initiate({
        amount: input.amount,
        consumer: input.consumer,
        customerReference: input.customerReference,
        idempotencyKey: input.idempotencyKey,
        metadata,
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (e) {
      return wrapError(e);
    }

    // On a fresh intent the only legal next status is `pending` (the gateway
    // accepted the request) or `failed` (the gateway rejected it at call
    // time). `requires_action` still advances to `pending` — the intent is
    // awaiting a 3DS step-up that the caller will finish via ConfirmCheckout.
    let advanced: PaymentIntent;
    try {
      advanced = transitionPaymentIntent(intent, {
        to: 'pending',
        gatewayRef: gatewayResult.gatewayRef,
      });
    } catch (e) {
      return wrapError(e);
    }

    await deps.repo.save(advanced);

    const out: InitiateCheckoutOutput = {
      intent: advanced,
      requiresAction: gatewayResult.requiresAction,
      ...(gatewayResult.challenge !== undefined
        ? { challenge: gatewayResult.challenge }
        : {}),
      ...(gatewayResult.checkoutUrl !== undefined
        ? { checkoutUrl: gatewayResult.checkoutUrl }
        : {}),
      ...(gatewayResult.clientSecret !== undefined
        ? { clientSecret: gatewayResult.clientSecret }
        : {}),
    };

    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// 2. ConfirmCheckout
// =============================================================================

export interface ConfirmCheckoutInput {
  readonly intentId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** Result of the 3DS / SCA step-up challenge. Opaque to the domain. */
  readonly threeDsResult?: string;
  /** Wallet token (Apple Pay / Google Pay) decrypted by the caller. */
  readonly walletTokenPayload?: Uint8Array;
}

export interface ConfirmCheckoutOutput {
  readonly intent: PaymentIntent;
  readonly finalStatus: PaymentIntentStatus;
  readonly failureReason?: string;
}

export interface ConfirmCheckoutDeps {
  readonly gateways: GatewayRegistryPort;
  readonly repo: PaymentIntentRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

/**
 * Complete a pending `PaymentIntent`. Accepts either the 3DS result string
 * or a decrypted wallet token payload — the ConfirmPaymentInput union is
 * enforced by the outbound adapter. Advances the intent to `succeeded` or
 * `failed` based on the gateway response.
 */
export const makeConfirmCheckout =
  (deps: ConfirmCheckoutDeps) =>
  async (
    input: ConfirmCheckoutInput,
  ): Promise<Result<ConfirmCheckoutOutput, DomainError>> => {
    const cached = await deps.idempotency.check<ConfirmCheckoutOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) {
      return ok(cached);
    }

    const existing = await deps.repo.findById(input.intentId);
    if (existing === null) {
      return err(
        new DomainError(
          'APPLICATION_INTENT_NOT_FOUND',
          `Intent '${input.intentId}' not found.`,
        ),
      );
    }
    if (existing.gatewayRef === null) {
      return err(
        new DomainError(
          'APPLICATION_INTENT_MISSING_GATEWAY_REF',
          `Intent '${input.intentId}' has no gatewayRef; cannot confirm.`,
        ),
      );
    }

    const gateway = deps.gateways.resolvePaymentGateway(existing.gatewayRef.gateway);
    const confirmInput: ConfirmPaymentInput = {
      gatewayRef: existing.gatewayRef,
      idempotencyKey: input.idempotencyKey,
      ...(input.threeDsResult !== undefined
        ? { threeDsResult: input.threeDsResult }
        : {}),
      ...(input.walletTokenPayload !== undefined
        ? { walletTokenPayload: input.walletTokenPayload }
        : {}),
    };

    let gatewayResult: ConfirmPaymentResult;
    try {
      gatewayResult = await gateway.confirm(confirmInput);
    } catch (e) {
      return wrapError(e);
    }

    // Map gateway status onto the domain status. `requires_action` keeps
    // the intent in `pending`; it is a retry signal, not a transition.
    let advanced = existing;
    if (gatewayResult.status === 'succeeded') {
      advanced = safeTransition(existing, { to: 'succeeded' });
    } else if (gatewayResult.status === 'failed') {
      advanced = safeTransition(existing, { to: 'failed' });
    }
    await deps.repo.save(advanced);

    const out: ConfirmCheckoutOutput = {
      intent: advanced,
      finalStatus: advanced.status,
      ...(gatewayResult.failureReason !== undefined
        ? { failureReason: gatewayResult.failureReason }
        : {}),
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// =============================================================================
// 3. RefundPayment
// =============================================================================

export interface RefundPaymentInput {
  readonly intentId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** Omit for full refund. Provide a partial `Money` value for partial. */
  readonly amount?: Money;
  readonly reason?: string;
}

export interface RefundPaymentOutput {
  readonly intent: PaymentIntent;
  readonly refundGatewayRef: GatewayRef;
  readonly refundStatus: 'succeeded' | 'failed';
}

export interface RefundPaymentDeps {
  readonly gateways: GatewayRegistryPort;
  readonly repo: PaymentIntentRepositoryPort;
  readonly idempotency: IdempotencyPort;
}

/**
 * Issue a full or partial refund against an existing succeeded intent. The
 * intent transitions to `refunded` only when the gateway confirms success.
 */
export const makeRefundPayment =
  (deps: RefundPaymentDeps) =>
  async (
    input: RefundPaymentInput,
  ): Promise<Result<RefundPaymentOutput, DomainError>> => {
    const cached = await deps.idempotency.check<RefundPaymentOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) {
      return ok(cached);
    }

    const existing = await deps.repo.findById(input.intentId);
    if (existing === null) {
      return err(
        new DomainError(
          'APPLICATION_INTENT_NOT_FOUND',
          `Intent '${input.intentId}' not found.`,
        ),
      );
    }
    if (existing.gatewayRef === null) {
      return err(
        new DomainError(
          'APPLICATION_INTENT_MISSING_GATEWAY_REF',
          `Intent '${input.intentId}' has no gatewayRef; cannot refund.`,
        ),
      );
    }
    if (!canTransitionPaymentIntent(existing.status, 'refunded')) {
      return err(
        new InvalidStateTransitionError(existing.status, ['succeeded']),
      );
    }

    const gateway = deps.gateways.resolvePaymentGateway(existing.gatewayRef.gateway);

    let gatewayResult: RefundPaymentResult;
    try {
      gatewayResult = await gateway.refund({
        gatewayRef: existing.gatewayRef,
        idempotencyKey: input.idempotencyKey,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    } catch (e) {
      return wrapError(e);
    }

    const advanced =
      gatewayResult.status === 'succeeded'
        ? safeTransition(existing, { to: 'refunded' })
        : existing;
    await deps.repo.save(advanced);

    const out: RefundPaymentOutput = {
      intent: advanced,
      refundGatewayRef: gatewayResult.refundGatewayRef,
      refundStatus: gatewayResult.status,
    };
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapError<T>(e: unknown): Result<T, DomainError> {
  if (e instanceof DomainError) return err(e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(new DomainError('APPLICATION_UNEXPECTED', msg));
}

/**
 * Wraps `transitionPaymentIntent` to keep the call-site compact. Errors are
 * promoted to the caller via the thrown `InvalidStateTransitionError`.
 */
function safeTransition(
  intent: PaymentIntent,
  args: { to: PaymentIntentStatus; gatewayRef?: GatewayRef },
): PaymentIntent {
  return transitionPaymentIntent(intent, args);
}
