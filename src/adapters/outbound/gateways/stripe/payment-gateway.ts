// =============================================================================
// Stripe PaymentGatewayPort implementation.
// -----------------------------------------------------------------------------
// Implements the four mutating methods (`initiate`, `confirm`, `capture`,
// `refund`) against Stripe PaymentIntents and Refunds. Each call:
//
//   1. Threads the domain `IdempotencyKey` through Stripe's native
//      `Idempotency-Key` header (SDK option `idempotencyKey`). Stripe treats
//      this as a strict idempotency primitive: replays return the original
//      response; parameter changes on replay fire `StripeIdempotencyError`.
//
//   2. Maps the `Money` bigint to Stripe's `number` minor units through
//      `moneyToStripeAmount` (guards against MAX_SAFE_INTEGER loss).
//
//   3. Catches any thrown Stripe SDK error and re-raises via `mapStripeError`
//      so the application layer only sees `DomainError` subclasses.
//
// No Stripe-specific type leaks into the returned `*Result` objects; every
// field is translated through `./mappers.js`.
// =============================================================================

import type {
  CapturePaymentInput,
  CapturePaymentResult,
  ConfirmPaymentInput,
  ConfirmPaymentResult,
  GatewayName,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentGatewayPort,
  RefundPaymentInput,
  RefundPaymentResult,
} from '../../../../domain/index.js';
import type { StripeClient, StripeRequestOptions } from './client.js';
import { mapStripeError } from './errors.js';
import {
  currencyToStripe,
  mapPaymentIntentStatus,
  mapRefundStatus,
  moneyToStripeAmount,
  stripeRef,
  threeDsChallengeFromIntent,
  toStripeMetadata,
} from './mappers.js';

export interface StripePaymentGatewayDeps {
  readonly client: StripeClient;
}

export class StripePaymentGateway implements PaymentGatewayPort {
  readonly gateway: GatewayName = 'stripe';

  constructor(private readonly deps: StripePaymentGatewayDeps) {}

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    // Pre-condition check — runs OUTSIDE the try/catch so the caller sees
    // the raw `RangeError` rather than a wrapped `StripeGatewayError`.
    // The guard is also cheaper to surface before the network call.
    const amount = moneyToStripeAmount(input.amount);
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const intent = await this.deps.client.paymentIntents.create(
        {
          amount,
          currency: currencyToStripe(input.amount.currency),
          metadata: toStripeMetadata(input.metadata, {
            consumer: input.consumer,
            customer_reference: input.customerReference,
          }),
          capture_method: 'automatic',
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.returnUrl !== undefined ? { return_url: input.returnUrl } : {}),
        },
        requestOptions,
      );

      const requiresAction = intent.status === 'requires_action';
      const challengeResult = requiresAction
        ? threeDsChallengeFromIntent(intent)
        : undefined;
      const challenge = challengeResult !== undefined && challengeResult.ok
        ? challengeResult.value
        : undefined;

      return {
        gatewayRef: stripeRef(intent.id),
        requiresAction,
        ...(challenge !== undefined ? { challenge } : {}),
        ...(intent.client_secret !== null && intent.client_secret !== undefined
          ? { clientSecret: intent.client_secret }
          : {}),
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async confirm(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const intent = await this.deps.client.paymentIntents.confirm(
        input.gatewayRef.externalId,
        {
          // `return_url` is required by Stripe when confirming a PaymentIntent
          // that may require 3DS. The application layer does not carry this
          // on confirm — consumers pre-seed the PaymentIntent with a return_url
          // at initiate time. If absent, Stripe raises an invalid_request
          // error which the error mapper converts to GATEWAY_INVALID_REQUEST.
        },
        requestOptions,
      );

      const status = mapPaymentIntentStatus(intent.status);
      const challengeResult =
        status === 'requires_action' ? threeDsChallengeFromIntent(intent) : undefined;
      const challenge = challengeResult !== undefined && challengeResult.ok
        ? challengeResult.value
        : undefined;

      return {
        gatewayRef: stripeRef(intent.id),
        status,
        ...(intent.last_payment_error?.message !== undefined
          ? { failureReason: intent.last_payment_error.message }
          : {}),
        ...(challenge !== undefined ? { challenge } : {}),
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async capture(input: CapturePaymentInput): Promise<CapturePaymentResult> {
    // Pre-validate amount (if present) outside the try so `RangeError`
    // surfaces to the caller rather than being wrapped.
    const amountToCapture =
      input.amount !== undefined ? moneyToStripeAmount(input.amount) : undefined;
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const intent = await this.deps.client.paymentIntents.capture(
        input.gatewayRef.externalId,
        {
          ...(amountToCapture !== undefined
            ? { amount_to_capture: amountToCapture }
            : {}),
        },
        requestOptions,
      );

      const status = intent.status === 'succeeded' ? 'succeeded' : 'failed';
      return {
        gatewayRef: stripeRef(intent.id),
        status,
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async refund(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    // Pre-validate amount (if present) outside the try so `RangeError`
    // surfaces to the caller rather than being wrapped.
    const refundAmount =
      input.amount !== undefined ? moneyToStripeAmount(input.amount) : undefined;
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const refund = await this.deps.client.refunds.create(
        {
          payment_intent: input.gatewayRef.externalId,
          ...(refundAmount !== undefined ? { amount: refundAmount } : {}),
          ...(input.reason !== undefined ? { metadata: { reason: input.reason } } : {}),
        },
        requestOptions,
      );

      return {
        refundGatewayRef: stripeRef(refund.id),
        status: mapRefundStatus(refund.status),
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }
}
