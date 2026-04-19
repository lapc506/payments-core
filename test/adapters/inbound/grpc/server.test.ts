// =============================================================================
// gRPC server integration tests.
// -----------------------------------------------------------------------------
// Boots the server on a random local port, calls a handful of RPCs with a
// dynamic @grpc/grpc-js client, and asserts the wire contract.
//
// The stub ports from `main.ts` cannot be reused because they always throw
// UNAVAILABLE. Tests supply their own in-memory ports that succeed/fail per
// scenario.
// =============================================================================

import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Money,
  createGatewayRef,
  createPaymentIntent,
  idempotencyKey,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type PaymentGatewayPort,
  type PaymentIntent,
  type SubscriptionPort,
  type EscrowPort,
  type WebhookVerifierPort,
  type AgenticPaymentPort,
  type ReconciliationPort,
  type FXRatePort,
  type GatewayName,
} from '../../../../src/domain/index.js';
import {
  makeCancelSubscription,
  makeConfirmCheckout,
  makeCreatePayout,
  makeCreateSubscription,
  makeDisputeEscrow,
  makeGetPaymentHistory,
  makeHandleAgenticPayment,
  makeHoldEscrow,
  makeInitiateCheckout,
  makeProcessWebhook,
  makeReconcileDaily,
  makeRefundPayment,
  makeReleaseEscrow,
  makeSwitchSubscription,
  type PayoutGatewayPort,
} from '../../../../src/application/index.js';
import {
  createServer,
  type CreateServerDeps,
} from '../../../../src/adapters/inbound/grpc/server.js';
import { HealthService, ServingStatus } from '../../../../src/adapters/inbound/grpc/health.js';
import {
  GatewayPreference,
  InitiateCheckoutRequest,
  InitiateCheckoutResponse,
  PaymentStatus,
  PaymentsCoreService,
  RefundPaymentRequest,
  RefundPaymentResponse,
} from '../../../../src/generated/lapc506/payments_core/v1/payments_core.js';

// ---------------------------------------------------------------------------
// In-memory fixtures
// ---------------------------------------------------------------------------

class MemIdempotency implements IdempotencyPort {
  private readonly store = new Map<string, unknown>();
  check<T>(key: IdempotencyKey): Promise<T | null> {
    return Promise.resolve((this.store.get(key) as T | undefined) ?? null);
  }
  commit<T>(key: IdempotencyKey, result: T): Promise<void> {
    this.store.set(key, result);
    return Promise.resolve();
  }
}

function buildFakePaymentGateway(): PaymentGatewayPort {
  let counter = 0;
  return {
    gateway: 'stripe',
    initiate: (input) => {
      counter += 1;
      const gatewayRef: GatewayRef = {
        gateway: 'stripe',
        externalId: `pi_fake_${counter}`,
      };
      void input;
      return Promise.resolve({
        gatewayRef,
        requiresAction: false,
        clientSecret: 'sk_test_fake',
      });
    },
    confirm: () =>
      Promise.resolve({
        gatewayRef: { gateway: 'stripe', externalId: 'pi_fake_1' },
        status: 'succeeded',
      }),
    capture: () =>
      Promise.resolve({
        gatewayRef: { gateway: 'stripe', externalId: 'pi_fake_1' },
        status: 'succeeded',
      }),
    refund: () =>
      Promise.resolve({
        refundGatewayRef: { gateway: 'stripe', externalId: 're_fake_1' },
        status: 'succeeded',
      }),
  };
}

class MemIntentRepo {
  readonly items = new Map<string, PaymentIntent>();
  save(i: PaymentIntent): Promise<void> {
    this.items.set(i.id, i);
    return Promise.resolve();
  }
  findById(id: string): Promise<PaymentIntent | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }
}

function unused(): never {
  throw new Error('not wired for this test');
}

const unusedSub: SubscriptionPort = {
  gateway: 'stripe',
  create: () => unused(),
  switch: () => unused(),
  cancel: () => unused(),
  prorate: () => unused(),
};
const unusedEscrow: EscrowPort = {
  gateway: 'stripe',
  hold: () => unused(),
  release: () => unused(),
  dispute: () => unused(),
};
const unusedPayout: PayoutGatewayPort = {
  gateway: 'stripe',
  createPayout: () => unused(),
};
const unusedVerifier: WebhookVerifierPort = {
  gateway: 'stripe',
  verify: () => unused(),
};
const unusedAgentic: AgenticPaymentPort = {
  initiateAgenticPayment: () => unused(),
};
const unusedRecon: ReconciliationPort = {
  gateway: 'stripe',
  reconcileDaily: () => unused(),
};
const unusedFx: FXRatePort = { lookup: () => unused() };

function buildDeps(
  gateway: PaymentGatewayPort,
  intentRepo: MemIntentRepo,
): CreateServerDeps {
  const idempotency = new MemIdempotency();
  const gatewayRegistry = {
    resolvePaymentGateway: (_g: GatewayName): PaymentGatewayPort => gateway,
  };
  const subReg = {
    resolveSubscriptionGateway: (_g: GatewayName): SubscriptionPort => unusedSub,
  };
  const escReg = {
    resolveEscrowGateway: (_g: GatewayName): EscrowPort => unusedEscrow,
  };
  const payReg = {
    resolvePayoutGateway: (_g: GatewayName): PayoutGatewayPort => unusedPayout,
  };
  const verReg = {
    resolveVerifier: (_g: GatewayName): WebhookVerifierPort => unusedVerifier,
  };
  const reconReg = {
    listReconciliationPorts: (): readonly ReconciliationPort[] => [unusedRecon],
  };
  const reader = {
    list: (): Promise<{ entries: readonly []; nextCursor: string }> =>
      Promise.resolve({ entries: [] as const, nextCursor: '' }),
  };

  return {
    health: new HealthService(ServingStatus.NOT_SERVING),
    ids: {
      newIntentId: () => `pi_${randomUUID()}`,
      newSubscriptionId: () => `sub_${randomUUID()}`,
      newEscrowId: () => `esc_${randomUUID()}`,
      newPayoutId: () => `po_${randomUUID()}`,
    },
    useCases: {
      initiateCheckout: makeInitiateCheckout({
        gateways: gatewayRegistry,
        repo: intentRepo,
        idempotency,
        fx: unusedFx,
      }),
      confirmCheckout: makeConfirmCheckout({
        gateways: gatewayRegistry,
        repo: intentRepo,
        idempotency,
      }),
      refundPayment: makeRefundPayment({
        gateways: gatewayRegistry,
        repo: intentRepo,
        idempotency,
      }),
      processWebhook: makeProcessWebhook({
        verifiers: verReg,
        idempotency,
        handler: () => Promise.resolve({ handled: false }),
      }),
      createSubscription: makeCreateSubscription({
        gateways: subReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      switchSubscription: makeSwitchSubscription({
        gateways: subReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      cancelSubscription: makeCancelSubscription({
        gateways: subReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      holdEscrow: makeHoldEscrow({
        gateways: escReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      releaseEscrow: makeReleaseEscrow({
        gateways: escReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      disputeEscrow: makeDisputeEscrow({
        gateways: escReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      createPayout: makeCreatePayout({
        gateways: payReg,
        repo: { save: () => Promise.resolve(), findById: () => Promise.resolve(null) },
        idempotency,
      }),
      handleAgenticPayment: makeHandleAgenticPayment({
        agentic: unusedAgentic,
        repo: intentRepo,
        idempotency,
      }),
      getPaymentHistory: makeGetPaymentHistory({ reader }),
      reconcileDaily: makeReconcileDaily({ registry: reconReg }),
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let server: grpc.Server;
let addr: string;
let client: grpc.Client;
let intentRepo: MemIntentRepo;

beforeAll(async () => {
  intentRepo = new MemIntentRepo();
  const deps = buildDeps(buildFakePaymentGateway(), intentRepo);
  const result = createServer(deps);
  server = result.server;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err !== null) {
          reject(err);
          return;
        }
        addr = `127.0.0.1:${port}`;
        resolve();
      },
    );
  });
  client = new grpc.Client(addr, grpc.credentials.createInsecure());
});

afterAll(async () => {
  client.close();
  await new Promise<void>((resolve) => {
    server.tryShutdown((err) => {
      if (err !== undefined && err !== null) server.forceShutdown();
      resolve();
    });
  });
});

// ---------------------------------------------------------------------------
// Unary helper (sidesteps the dynamic-Service type gymnastics)
// ---------------------------------------------------------------------------

function unaryCall<Req, Res>(
  method: {
    path: string;
    requestSerialize: (v: Req) => Buffer;
    responseDeserialize: (buf: Buffer) => Res;
  },
  request: Req,
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      request,
      (err, value) => {
        if (err !== null && err !== undefined) {
          reject(err);
          return;
        }
        if (value === undefined) {
          reject(new Error('empty response'));
          return;
        }
        resolve(value);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gRPC server', () => {
  it('InitiateCheckout returns a PROCESSING intent with a fake client secret', async () => {
    const req: InitiateCheckoutRequest = {
      consumer: 'test-consumer',
      customerReference: 'cust_1',
      amount: { amountMinor: '1234', currency: 'USD' },
      description: 'test charge',
      gateway: GatewayPreference.GATEWAY_PREFERENCE_STRIPE,
      successUrl: '',
      cancelUrl: '',
      metadata: {},
      idempotencyKey: 'idem-key-ok-12345',
    };
    const res = await unaryCall<InitiateCheckoutRequest, InitiateCheckoutResponse>(
      PaymentsCoreService.initiateCheckout,
      req,
    );
    expect(res.status).toBe(PaymentStatus.PAYMENT_STATUS_PROCESSING);
    expect(res.intentId).toMatch(/^pi_/);
    expect(res.clientSecret).toBe('sk_test_fake');
    expect(res.chosenGateway).toBe(GatewayPreference.GATEWAY_PREFERENCE_STRIPE);
  });

  it('InitiateCheckout rejects a malformed idempotency key with INVALID_ARGUMENT', async () => {
    const req: InitiateCheckoutRequest = {
      consumer: 'x',
      customerReference: 'x',
      amount: { amountMinor: '100', currency: 'USD' },
      description: '',
      gateway: GatewayPreference.GATEWAY_PREFERENCE_STRIPE,
      successUrl: '',
      cancelUrl: '',
      metadata: {},
      idempotencyKey: 'bad',
    };
    await expect(
      unaryCall<InitiateCheckoutRequest, InitiateCheckoutResponse>(
        PaymentsCoreService.initiateCheckout,
        req,
      ),
    ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  it('RefundPayment rejects refunding a pending intent with FAILED_PRECONDITION', async () => {
    // Seed a pending intent (not succeeded) so the use case rejects the
    // transition to `refunded`.
    const seededKey = idempotencyKey('seed-key-abcdef01');
    const intent = createPaymentIntent({
      id: 'pi_seed',
      consumer: 'x',
      customerReference: 'x',
      amount: Money.of(5000n, 'USD'),
      idempotencyKey: seededKey,
    });
    const withRef = { ...intent, gatewayRef: (() => {
      const r = createGatewayRef('stripe', 'pi_seed_ext');
      if (!r.ok) throw r.error;
      return r.value;
    })() } as PaymentIntent;
    await intentRepo.save(withRef);

    const req: RefundPaymentRequest = {
      intentId: 'pi_seed',
      reason: 'test',
      idempotencyKey: 'idem-key-refund-ok-1',
    };
    await expect(
      unaryCall<RefundPaymentRequest, RefundPaymentResponse>(
        PaymentsCoreService.refundPayment,
        req,
      ),
    ).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });
});
