// =============================================================================
// OnvoPay PaymentGatewayPort implementation
// -----------------------------------------------------------------------------
// Implements `PaymentGatewayPort` against OnvoPay's charges API. Charge
// creation, confirmation, capture, and refund all funnel through
// `OnvoPayHttpClient` so retry/timeout policy is centralized.
//
// Endpoint assumptions (TODO: verify against
// https://docs.onvopay.com/#section/Referencia-API):
//   - POST   /v1/charges                  create charge
//   - POST   /v1/charges/:id/confirm      complete 3DS / SCA
//   - POST   /v1/charges/:id/capture      capture authorized funds
//   - POST   /v1/refunds                  create refund against a charge
//
// If OnvoPay instead uses a separate PaymentIntent object or a different
// path structure, update the four `this.http.request(...)` call sites below
// — no other file needs to change because mappers + errors are centralized.
// =============================================================================

import type {
  CapturePaymentInput,
  CapturePaymentResult,
  ConfirmPaymentInput,
  ConfirmPaymentResult,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentGatewayPort,
  RefundPaymentInput,
  RefundPaymentResult,
} from '../../../../domain/ports/index.js';

import { mapOnvoPayError } from './errors.js';
import {
  toConfirmStatus,
  toGatewayRef,
  toOnvoPayAmount,
  type OnvoPayCharge,
  type OnvoPayRefund,
} from './mappers.js';
import type { OnvoPayHttpClient } from './client.js';

const CHARGES_PATH = '/v1/charges';
const REFUNDS_PATH = '/v1/refunds';

export class OnvoPayPaymentGateway implements PaymentGatewayPort {
  readonly gateway = 'onvopay' as const;

  constructor(private readonly http: OnvoPayHttpClient) {}

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    try {
      const body = {
        amount: toOnvoPayAmount(input.amount),
        currency: input.amount.currency,
        customer: input.customerReference,
        description: input.description,
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
        metadata: { ...input.metadata, consumer: input.consumer },
      };
      const charge = await this.http.request<OnvoPayCharge>({
        method: 'POST',
        path: CHARGES_PATH,
        idempotencyKey: input.idempotencyKey,
        body,
      });

      const requiresAction = charge.status === 'requires_action';
      const redirectUrl =
        charge.checkout_url ?? charge.next_action?.redirect_url ?? undefined;

      const result: InitiatePaymentResult = {
        gatewayRef: toGatewayRef(charge.id),
        requiresAction,
        ...(requiresAction && redirectUrl
          ? {
              // The domain treats the challenge payload as opaque bytes; we
              // encode the redirect URL here so downstream consumers have
              // enough signal to present the hosted 3DS page without the
              // domain layer having to know about OnvoPay's shape.
              challenge: {
                challengeId: charge.id,
                data: new TextEncoder().encode(redirectUrl),
              },
            }
          : {}),
        ...(charge.checkout_url ? { checkoutUrl: charge.checkout_url } : {}),
      };
      return result;
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }

  async confirm(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
    try {
      // TODO: verify endpoint shape against https://docs.onvopay.com/ —
      // OnvoPay may expose `/v1/charges/:id/confirm` or a unified
      // `/v1/payment_intents/:id/confirm`.
      const charge = await this.http.request<OnvoPayCharge>({
        method: 'POST',
        path: `${CHARGES_PATH}/${encodeURIComponent(input.gatewayRef.externalId)}/confirm`,
        idempotencyKey: input.idempotencyKey,
        body: {
          three_ds_result: input.threeDsResult,
          wallet_token:
            input.walletTokenPayload === undefined
              ? undefined
              : Buffer.from(input.walletTokenPayload).toString('base64'),
        },
      });

      const status = toConfirmStatus(charge.status);
      const result: ConfirmPaymentResult = {
        gatewayRef: toGatewayRef(charge.id),
        status,
        ...(charge.failure_reason ? { failureReason: charge.failure_reason } : {}),
      };
      return result;
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }

  async capture(input: CapturePaymentInput): Promise<CapturePaymentResult> {
    try {
      const body: Record<string, unknown> = {};
      if (input.amount !== undefined) {
        body['amount'] = toOnvoPayAmount(input.amount);
      }
      const charge = await this.http.request<OnvoPayCharge>({
        method: 'POST',
        path: `${CHARGES_PATH}/${encodeURIComponent(input.gatewayRef.externalId)}/capture`,
        idempotencyKey: input.idempotencyKey,
        body,
      });
      const status = toConfirmStatus(charge.status) === 'succeeded' ? 'succeeded' : 'failed';
      return { gatewayRef: toGatewayRef(charge.id), status };
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }

  async refund(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    try {
      const body: Record<string, unknown> = {
        charge: input.gatewayRef.externalId,
      };
      if (input.amount !== undefined) {
        body['amount'] = toOnvoPayAmount(input.amount);
      }
      if (input.reason !== undefined) {
        body['reason'] = input.reason;
      }
      const refund = await this.http.request<OnvoPayRefund>({
        method: 'POST',
        path: REFUNDS_PATH,
        idempotencyKey: input.idempotencyKey,
        body,
      });
      const status = refund.status === 'succeeded' ? 'succeeded' : 'failed';
      return {
        refundGatewayRef: toGatewayRef(refund.id),
        status,
      };
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }
}
