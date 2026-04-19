// =============================================================================
// Checkout handlers — InitiateCheckout, ConfirmCheckout, RefundPayment.
// -----------------------------------------------------------------------------
// Thin orchestrators: decode proto → call use case → encode proto response,
// or translate `Result.error` to a gRPC `ServiceError`.
//
// Zero business logic. Every branch here is either field plumbing, mapping,
// or error translation.
// =============================================================================

import type * as grpc from '@grpc/grpc-js';

import {
  createIdempotencyKey,
  type DomainError,
  type IdempotencyKey,
  type Money,
  type Result,
} from '../../../../domain/index.js';
import {
  type ConfirmCheckoutInput,
  type ConfirmCheckoutOutput,
  type InitiateCheckoutInput,
  type InitiateCheckoutOutput,
  type RefundPaymentInput,
  type RefundPaymentOutput,
  type makeConfirmCheckout,
  type makeInitiateCheckout,
  type makeRefundPayment,
} from '../../../../application/index.js';
import {
  ConfirmCheckoutRequest,
  ConfirmCheckoutResponse,
  InitiateCheckoutRequest,
  InitiateCheckoutResponse,
  RefundPaymentRequest,
  RefundPaymentResponse,
} from '../../../../generated/lapc506/payments_core/v1/payments_core.js';
import { invalidArgument, toGrpcError } from '../errors.js';
import { protoMoneyToDomainRequired } from '../mappers/money.js';
import {
  domainGatewayToProto,
  domainPaymentStatusToProto,
  resolveGatewayPreference,
} from '../mappers/entities.js';

// ---------------------------------------------------------------------------
// Shared: accept ts-proto idempotency-key string, produce branded IdempotencyKey
// ---------------------------------------------------------------------------

function buildIdempotencyKey(
  raw: string,
): { ok: true; value: IdempotencyKey } | { ok: false; details: string } {
  const r = createIdempotencyKey(raw);
  if (r.ok) return { ok: true, value: r.value };
  return { ok: false, details: r.error.message };
}

// ---------------------------------------------------------------------------
// InitiateCheckout
// ---------------------------------------------------------------------------

export type InitiateCheckoutExecutor = ReturnType<typeof makeInitiateCheckout>;

export function makeInitiateCheckoutHandler(
  execute: InitiateCheckoutExecutor,
  intentIdGenerator: () => string,
): grpc.handleUnaryCall<InitiateCheckoutRequest, InitiateCheckoutResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }
      const money = protoMoneyToDomainRequired(call.request.amount, 'amount');
      if (!money.ok) {
        callback(invalidArgument(money.error.message), null);
        return;
      }

      const input: InitiateCheckoutInput = {
        id: intentIdGenerator(),
        consumer: call.request.consumer,
        customerReference: call.request.customerReference,
        amount: money.value,
        gateway: resolveGatewayPreference(call.request.gateway),
        idempotencyKey: key.value,
        metadata: call.request.metadata,
        ...(call.request.successUrl ? { returnUrl: call.request.successUrl } : {}),
        ...(call.request.cancelUrl ? { cancelUrl: call.request.cancelUrl } : {}),
        ...(call.request.description ? { description: call.request.description } : {}),
      };

      const result: Result<InitiateCheckoutOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const { intent } = result.value;
      const chosenGateway =
        intent.gatewayRef !== null
          ? domainGatewayToProto(intent.gatewayRef.gateway)
          : domainGatewayToProto(input.gateway);

      const response: InitiateCheckoutResponse = {
        intentId: intent.id,
        status: domainPaymentStatusToProto(intent.status),
        chosenGateway,
        clientSecret: result.value.clientSecret ?? '',
        redirectUrl: result.value.checkoutUrl ?? '',
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// ConfirmCheckout
// ---------------------------------------------------------------------------

export type ConfirmCheckoutExecutor = ReturnType<typeof makeConfirmCheckout>;

export function makeConfirmCheckoutHandler(
  execute: ConfirmCheckoutExecutor,
): grpc.handleUnaryCall<ConfirmCheckoutRequest, ConfirmCheckoutResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }

      const input: ConfirmCheckoutInput = {
        intentId: call.request.intentId,
        idempotencyKey: key.value,
        ...(call.request.threeDsResult !== undefined
          ? { threeDsResult: call.request.threeDsResult }
          : {}),
        ...(call.request.walletToken?.payload !== undefined
          ? { walletTokenPayload: call.request.walletToken.payload }
          : {}),
      };

      const result: Result<ConfirmCheckoutOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: ConfirmCheckoutResponse = {
        intentId: result.value.intent.id,
        status: domainPaymentStatusToProto(result.value.finalStatus),
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// RefundPayment
// ---------------------------------------------------------------------------

export type RefundPaymentExecutor = ReturnType<typeof makeRefundPayment>;

export function makeRefundPaymentHandler(
  execute: RefundPaymentExecutor,
): grpc.handleUnaryCall<RefundPaymentRequest, RefundPaymentResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }

      let amount: Money | undefined;
      if (call.request.amount !== undefined) {
        const money = protoMoneyToDomainRequired(call.request.amount, 'amount');
        if (!money.ok) {
          callback(invalidArgument(money.error.message), null);
          return;
        }
        amount = money.value;
      }

      const input: RefundPaymentInput = {
        intentId: call.request.intentId,
        idempotencyKey: key.value,
        ...(amount !== undefined ? { amount } : {}),
        ...(call.request.reason ? { reason: call.request.reason } : {}),
      };

      const result: Result<RefundPaymentOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      // A refund response carries the gateway-side refund id (not the intent
      // id) as its primary key. The domain reports the refund's gateway ref.
      const response: RefundPaymentResponse = {
        refundId: result.value.refundGatewayRef.externalId,
        status: domainPaymentStatusToProto(result.value.intent.status),
      };
      callback(null, response);
    })();
  };
}
