// =============================================================================
// Subscription handlers — Create, Switch, Cancel.
// -----------------------------------------------------------------------------
// Thin orchestrators around the three subscription use cases.
//
// Proration-behavior strings are passed through unchanged; the application
// layer validates them against its own allowlist (`create_prorations`,
// `none`, `always_invoice`).
// =============================================================================

import type * as grpc from '@grpc/grpc-js';

import {
  createIdempotencyKey,
  type DomainError,
  type IdempotencyKey,
  type Result,
} from '../../../../domain/index.js';
import {
  type CancelSubscriptionInput,
  type CancelSubscriptionOutput,
  type CreateSubscriptionInput,
  type CreateSubscriptionOutput,
  type SwitchSubscriptionInput,
  type SwitchSubscriptionOutput,
  type makeCancelSubscription,
  type makeCreateSubscription,
  type makeSwitchSubscription,
} from '../../../../application/index.js';
import {
  CancelSubscriptionRequest,
  CancelSubscriptionResponse,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  SwitchSubscriptionRequest,
  SwitchSubscriptionResponse,
} from '../../../../generated/lapc506/payments_core/v1/payments_core.js';
import { invalidArgument, toGrpcError } from '../errors.js';
import {
  domainGatewayToProto,
  domainSubscriptionStatusToProto,
  resolveGatewayPreference,
} from '../mappers/entities.js';

function buildIdempotencyKey(
  raw: string,
): { ok: true; value: IdempotencyKey } | { ok: false; details: string } {
  const r = createIdempotencyKey(raw);
  return r.ok
    ? { ok: true, value: r.value }
    : { ok: false, details: r.error.message };
}

const PRORATION_BEHAVIORS = ['create_prorations', 'none', 'always_invoice'] as const;
type ProrationBehavior = (typeof PRORATION_BEHAVIORS)[number];

function parseProrationBehavior(raw: string): ProrationBehavior | null {
  return PRORATION_BEHAVIORS.includes(raw as ProrationBehavior)
    ? (raw as ProrationBehavior)
    : null;
}

// ---------------------------------------------------------------------------
// CreateSubscription
// ---------------------------------------------------------------------------

export type CreateSubscriptionExecutor = ReturnType<typeof makeCreateSubscription>;

export function makeCreateSubscriptionHandler(
  execute: CreateSubscriptionExecutor,
  subscriptionIdGenerator: () => string,
): grpc.handleUnaryCall<CreateSubscriptionRequest, CreateSubscriptionResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }

      const input: CreateSubscriptionInput = {
        id: subscriptionIdGenerator(),
        consumer: call.request.consumer,
        customerReference: call.request.customerReference,
        planId: call.request.planId,
        gateway: resolveGatewayPreference(call.request.gateway),
        idempotencyKey: key.value,
        metadata: call.request.metadata,
      };

      const result: Result<CreateSubscriptionOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const { subscription } = result.value;
      const chosenGateway =
        subscription.gatewayRef !== null
          ? domainGatewayToProto(subscription.gatewayRef.gateway)
          : domainGatewayToProto(input.gateway);

      const response: CreateSubscriptionResponse = {
        subscriptionId: subscription.id,
        status: domainSubscriptionStatusToProto(subscription.status),
        chosenGateway,
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// SwitchSubscription
// ---------------------------------------------------------------------------

export type SwitchSubscriptionExecutor = ReturnType<typeof makeSwitchSubscription>;

export function makeSwitchSubscriptionHandler(
  execute: SwitchSubscriptionExecutor,
): grpc.handleUnaryCall<SwitchSubscriptionRequest, SwitchSubscriptionResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }
      const behavior = parseProrationBehavior(call.request.prorationBehavior);
      if (behavior === null) {
        callback(
          invalidArgument(
            `proration_behavior must be one of ${PRORATION_BEHAVIORS.join(', ')}`,
          ),
          null,
        );
        return;
      }

      const input: SwitchSubscriptionInput = {
        subscriptionId: call.request.subscriptionId,
        newPlanId: call.request.newPlanId,
        prorationBehavior: behavior,
        idempotencyKey: key.value,
      };

      const result: Result<SwitchSubscriptionOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: SwitchSubscriptionResponse = {
        subscriptionId: result.value.subscription.id,
        status: domainSubscriptionStatusToProto(result.value.subscription.status),
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// CancelSubscription
// ---------------------------------------------------------------------------

export type CancelSubscriptionExecutor = ReturnType<typeof makeCancelSubscription>;

export function makeCancelSubscriptionHandler(
  execute: CancelSubscriptionExecutor,
): grpc.handleUnaryCall<CancelSubscriptionRequest, CancelSubscriptionResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }

      const input: CancelSubscriptionInput = {
        subscriptionId: call.request.subscriptionId,
        atPeriodEnd: call.request.atPeriodEnd,
        idempotencyKey: key.value,
        ...(call.request.reason ? { reason: call.request.reason } : {}),
      };

      const result: Result<CancelSubscriptionOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: CancelSubscriptionResponse = {
        subscriptionId: result.value.subscription.id,
        status: domainSubscriptionStatusToProto(result.value.subscription.status),
        effectiveAt: result.value.effectiveAt,
      };
      callback(null, response);
    })();
  };
}
