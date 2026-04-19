// =============================================================================
// gRPC server factory.
// -----------------------------------------------------------------------------
// Assembles a `grpc.Server` with:
//   - The `PaymentsCore` service bound to the 14 handlers.
//   - The `grpc.health.v1.Health` service bound to a mutable status map.
//
// This module does NOT bind a port or call `start()`. Port binding, graceful
// shutdown, and signal handling live in `main.ts`. Tests spin up the server
// on a random port without duplicating that logic by calling `createServer`
// + `server.bindAsync` directly.
// =============================================================================

import * as grpc from '@grpc/grpc-js';

import {
  type makeCancelSubscription,
  type makeConfirmCheckout,
  type makeCreatePayout,
  type makeCreateSubscription,
  type makeDisputeEscrow,
  type makeGetPaymentHistory,
  type makeHandleAgenticPayment,
  type makeHoldEscrow,
  type makeInitiateCheckout,
  type makeProcessWebhook,
  type makeReconcileDaily,
  type makeRefundPayment,
  type makeReleaseEscrow,
  type makeSwitchSubscription,
} from '../../../application/index.js';

import {
  makeConfirmCheckoutHandler,
  makeInitiateCheckoutHandler,
  makeRefundPaymentHandler,
} from './handlers/checkout.js';
import {
  makeCancelSubscriptionHandler,
  makeCreateSubscriptionHandler,
  makeSwitchSubscriptionHandler,
} from './handlers/subscription.js';
import {
  makeDisputeEscrowHandler,
  makeHoldEscrowHandler,
  makeReleaseEscrowHandler,
} from './handlers/escrow.js';
import {
  makeCreatePayoutHandler,
  makeGetPaymentHistoryHandler,
  makeInitiateAgenticPaymentHandler,
  makeProcessWebhookHandler,
  makeReconcileDailyHandler,
} from './handlers/misc.js';
import { HealthService, ServingStatus } from './health.js';
import { PaymentsCoreService } from '../../../generated/lapc506/payments_core/v1/payments_core.js';

/**
 * Use-case container handed to the server factory. Each field is the result
 * of calling the matching `make*` factory with its port dependencies.
 */
export interface UseCaseContainer {
  readonly initiateCheckout: ReturnType<typeof makeInitiateCheckout>;
  readonly confirmCheckout: ReturnType<typeof makeConfirmCheckout>;
  readonly refundPayment: ReturnType<typeof makeRefundPayment>;
  readonly processWebhook: ReturnType<typeof makeProcessWebhook>;
  readonly createSubscription: ReturnType<typeof makeCreateSubscription>;
  readonly switchSubscription: ReturnType<typeof makeSwitchSubscription>;
  readonly cancelSubscription: ReturnType<typeof makeCancelSubscription>;
  readonly holdEscrow: ReturnType<typeof makeHoldEscrow>;
  readonly releaseEscrow: ReturnType<typeof makeReleaseEscrow>;
  readonly disputeEscrow: ReturnType<typeof makeDisputeEscrow>;
  readonly createPayout: ReturnType<typeof makeCreatePayout>;
  readonly handleAgenticPayment: ReturnType<typeof makeHandleAgenticPayment>;
  readonly getPaymentHistory: ReturnType<typeof makeGetPaymentHistory>;
  readonly reconcileDaily: ReturnType<typeof makeReconcileDaily>;
}

export interface IdGenerators {
  readonly newIntentId: () => string;
  readonly newSubscriptionId: () => string;
  readonly newEscrowId: () => string;
  readonly newPayoutId: () => string;
}

export interface CreateServerDeps {
  readonly useCases: UseCaseContainer;
  readonly ids: IdGenerators;
  readonly health: HealthService;
}

export interface CreateServerResult {
  readonly server: grpc.Server;
  readonly health: HealthService;
}

/**
 * Build a fully-wired `grpc.Server`. Caller owns the lifecycle (bindAsync,
 * tryShutdown, forceShutdown).
 */
export function createServer(deps: CreateServerDeps): CreateServerResult {
  const server = new grpc.Server({
    // Webhooks can be large, especially Stripe ones with line-item arrays.
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
    // Keepalives keep long-idle sidecar connections (e.g. to a consumer
    // app in the same pod) from being reaped by a downstream L4 load
    // balancer.
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
  });

  server.addService(PaymentsCoreService, {
    initiateCheckout: makeInitiateCheckoutHandler(
      deps.useCases.initiateCheckout,
      deps.ids.newIntentId,
    ),
    confirmCheckout: makeConfirmCheckoutHandler(deps.useCases.confirmCheckout),
    refundPayment: makeRefundPaymentHandler(deps.useCases.refundPayment),
    processWebhook: makeProcessWebhookHandler(deps.useCases.processWebhook),
    createSubscription: makeCreateSubscriptionHandler(
      deps.useCases.createSubscription,
      deps.ids.newSubscriptionId,
    ),
    switchSubscription: makeSwitchSubscriptionHandler(deps.useCases.switchSubscription),
    cancelSubscription: makeCancelSubscriptionHandler(deps.useCases.cancelSubscription),
    holdEscrow: makeHoldEscrowHandler(deps.useCases.holdEscrow, deps.ids.newEscrowId),
    releaseEscrow: makeReleaseEscrowHandler(deps.useCases.releaseEscrow),
    disputeEscrow: makeDisputeEscrowHandler(deps.useCases.disputeEscrow),
    createPayout: makeCreatePayoutHandler(
      deps.useCases.createPayout,
      deps.ids.newPayoutId,
    ),
    initiateAgenticPayment: makeInitiateAgenticPaymentHandler(
      deps.useCases.handleAgenticPayment,
      deps.ids.newIntentId,
    ),
    getPaymentHistory: makeGetPaymentHistoryHandler(deps.useCases.getPaymentHistory),
    reconcileDaily: makeReconcileDailyHandler(deps.useCases.reconcileDaily),
  });

  deps.health.register(server);
  // Wiring is complete; flip the overall server status to SERVING. Callers
  // (main.ts) can flip to NOT_SERVING on SIGTERM.
  deps.health.setServingStatus(ServingStatus.SERVING);

  return { server, health: deps.health };
}
