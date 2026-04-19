// =============================================================================
// Checkout use-case tests — InitiateCheckout, ConfirmCheckout, RefundPayment.
// -----------------------------------------------------------------------------
// Each use case is exercised with:
//   - Happy path (port stubs all succeed).
//   - Idempotency replay (second call returns the cached result; the gateway
//     port is called exactly once).
//   - At least one error path (gateway throws OR state transition rejected).
//
// Port stubs are plain objects — no mocking framework. Keeps the test
// surface narrow and forces the implementation to depend on interfaces only.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Money,
  createGatewayRef,
  createPaymentIntent,
  idempotencyKey,
  transitionPaymentIntent,
  type ConfirmPaymentResult,
  type FXRatePort,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type InitiatePaymentResult,
  type PaymentGatewayPort,
  type PaymentIntent,
  type RefundPaymentResult,
} from '../../src/domain/index.js';
import {
  makeConfirmCheckout,
  makeInitiateCheckout,
  makeRefundPayment,
  type PaymentIntentRepositoryPort,
  type GatewayRegistryPort,
} from '../../src/application/use_cases/checkout.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const key = idempotencyKey('test-key-00000001');
const usd = (n: bigint) => Money.of(n, 'USD');
const gatewayRefOf = (g: string, id: string): GatewayRef => {
  const r = createGatewayRef(g, id);
  if (!r.ok) throw r.error;
  return r.value;
};

const makeInMemoryIdempotency = (): IdempotencyPort => {
  const store = new Map<string, unknown>();
  return {
    check: async <T>(k: IdempotencyKey) => (store.has(k) ? (store.get(k) as T) : null),
    commit: async <T>(k: IdempotencyKey, result: T) => {
      store.set(k, result);
    },
  };
};

const makeInMemoryIntentRepo = (): PaymentIntentRepositoryPort & {
  readonly store: Map<string, PaymentIntent>;
} => {
  const store = new Map<string, PaymentIntent>();
  return {
    store,
    save: async (intent) => {
      store.set(intent.id, intent);
    },
    findById: async (id) => store.get(id) ?? null,
  };
};

const stubGateway = (overrides: Partial<PaymentGatewayPort> = {}): PaymentGatewayPort => ({
  gateway: 'stripe',
  initiate: vi.fn(
    async (): Promise<InitiatePaymentResult> => ({
      gatewayRef: gatewayRefOf('stripe', 'pi_123'),
      requiresAction: false,
    }),
  ),
  confirm: vi.fn(
    async (): Promise<ConfirmPaymentResult> => ({
      gatewayRef: gatewayRefOf('stripe', 'pi_123'),
      status: 'succeeded',
    }),
  ),
  capture: vi.fn(async () => ({ gatewayRef: gatewayRefOf('stripe', 'pi_123'), status: 'succeeded' })),
  refund: vi.fn(
    async (): Promise<RefundPaymentResult> => ({
      refundGatewayRef: gatewayRefOf('stripe', 're_1'),
      status: 'succeeded',
    }),
  ),
  ...overrides,
});

const stubRegistry = (gateway: PaymentGatewayPort): GatewayRegistryPort => ({
  resolvePaymentGateway: () => gateway,
});

const stubFx = (): FXRatePort => ({
  lookup: vi.fn(async () => ({
    baseCurrency: 'USD',
    quoteCurrency: 'CRC',
    rate: '525.10',
    asOf: new Date('2026-04-18T00:00:00Z'),
    source: 'test',
  })),
});

// ---------------------------------------------------------------------------
// InitiateCheckout
// ---------------------------------------------------------------------------

describe('makeInitiateCheckout', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeInMemoryIntentRepo>;
  let fx: FXRatePort;

  beforeEach(() => {
    idem = makeInMemoryIdempotency();
    repo = makeInMemoryIntentRepo();
    fx = stubFx();
  });

  it('creates a PaymentIntent and advances it to pending on the happy path', async () => {
    const gw = stubGateway();
    const execute = makeInitiateCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
      fx,
    });

    const r = await execute({
      id: 'pi_1',
      consumer: 'altrupets',
      customerReference: 'user-42',
      amount: usd(1000n),
      gateway: 'stripe',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent.status).toBe('pending');
    expect(r.value.intent.gatewayRef?.externalId).toBe('pi_123');
    expect(r.value.requiresAction).toBe(false);
    expect(repo.store.get('pi_1')?.status).toBe('pending');
    expect(gw.initiate).toHaveBeenCalledTimes(1);
  });

  it('returns the cached result on idempotency replay without re-hitting the gateway', async () => {
    const gw = stubGateway();
    const execute = makeInitiateCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
      fx,
    });

    const input = {
      id: 'pi_2',
      consumer: 'altrupets',
      customerReference: 'user-42',
      amount: usd(1000n),
      gateway: 'stripe' as const,
      idempotencyKey: key,
    };
    const first = await execute(input);
    const second = await execute(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(gw.initiate).toHaveBeenCalledTimes(1);
  });

  it('looks up an FX quote when quoteCurrency is provided', async () => {
    const gw = stubGateway();
    const execute = makeInitiateCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
      fx,
    });

    const r = await execute({
      id: 'pi_3',
      consumer: 'aduanext-api',
      customerReference: 'pyme-42',
      amount: usd(10_000n),
      gateway: 'stripe',
      idempotencyKey: key,
      quoteCurrency: 'CRC',
    });

    expect(r.ok).toBe(true);
    expect(fx.lookup).toHaveBeenCalledTimes(1);
    if (!r.ok) return;
    expect(r.value.intent.metadata['fx_quote_rate']).toBe('525.10');
  });

  it('returns err(DomainError) when the gateway throws', async () => {
    const gw = stubGateway({
      initiate: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const execute = makeInitiateCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
      fx,
    });

    const r = await execute({
      id: 'pi_err',
      consumer: 'altrupets',
      customerReference: 'user-42',
      amount: usd(1000n),
      gateway: 'stripe',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_UNEXPECTED');
  });
});

// ---------------------------------------------------------------------------
// ConfirmCheckout
// ---------------------------------------------------------------------------

describe('makeConfirmCheckout', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeInMemoryIntentRepo>;

  beforeEach(() => {
    idem = makeInMemoryIdempotency();
    repo = makeInMemoryIntentRepo();
  });

  const seedPending = () => {
    const intent = transitionPaymentIntent(
      createPaymentIntent({
        id: 'pi_conf_1',
        consumer: 'altrupets',
        customerReference: 'user-42',
        amount: usd(1000n),
        idempotencyKey: key,
      }),
      { to: 'pending', gatewayRef: gatewayRefOf('stripe', 'pi_123') },
    );
    repo.store.set(intent.id, intent);
    return intent;
  };

  it('advances pending → succeeded on a successful gateway confirm', async () => {
    seedPending();
    const gw = stubGateway();
    const execute = makeConfirmCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
    });

    const r = await execute({ intentId: 'pi_conf_1', idempotencyKey: key });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.finalStatus).toBe('succeeded');
    expect(gw.confirm).toHaveBeenCalledTimes(1);
  });

  it('advances pending → failed and records failureReason when the gateway fails', async () => {
    seedPending();
    const gw = stubGateway({
      confirm: vi.fn(async () => ({
        gatewayRef: gatewayRefOf('stripe', 'pi_123'),
        status: 'failed' as const,
        failureReason: 'card_declined',
      })),
    });
    const execute = makeConfirmCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
    });

    const r = await execute({ intentId: 'pi_conf_1', idempotencyKey: key });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.finalStatus).toBe('failed');
    expect(r.value.failureReason).toBe('card_declined');
  });

  it('returns err when the intent is not found', async () => {
    const gw = stubGateway();
    const execute = makeConfirmCheckout({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
    });

    const r = await execute({ intentId: 'nope', idempotencyKey: key });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_INTENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// RefundPayment
// ---------------------------------------------------------------------------

describe('makeRefundPayment', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeInMemoryIntentRepo>;

  beforeEach(() => {
    idem = makeInMemoryIdempotency();
    repo = makeInMemoryIntentRepo();
  });

  const seedSucceeded = () => {
    let intent = createPaymentIntent({
      id: 'pi_ref_1',
      consumer: 'altrupets',
      customerReference: 'user-42',
      amount: usd(1000n),
      idempotencyKey: key,
    });
    intent = transitionPaymentIntent(intent, {
      to: 'pending',
      gatewayRef: gatewayRefOf('stripe', 'pi_123'),
    });
    intent = transitionPaymentIntent(intent, { to: 'succeeded' });
    repo.store.set(intent.id, intent);
    return intent;
  };

  it('advances a succeeded intent to refunded on a successful refund', async () => {
    seedSucceeded();
    const gw = stubGateway();
    const execute = makeRefundPayment({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      intentId: 'pi_ref_1',
      idempotencyKey: key,
      reason: 'customer request',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent.status).toBe('refunded');
    expect(r.value.refundStatus).toBe('succeeded');
  });

  it('rejects refunds on an intent that is not refundable', async () => {
    // Intent is in `pending` — refunded is not a legal successor.
    const intent = transitionPaymentIntent(
      createPaymentIntent({
        id: 'pi_ref_2',
        consumer: 'altrupets',
        customerReference: 'user-42',
        amount: usd(1000n),
        idempotencyKey: key,
      }),
      { to: 'pending', gatewayRef: gatewayRefOf('stripe', 'pi_123') },
    );
    repo.store.set(intent.id, intent);

    const gw = stubGateway();
    const execute = makeRefundPayment({
      gateways: stubRegistry(gw),
      repo,
      idempotency: idem,
    });

    const r = await execute({ intentId: 'pi_ref_2', idempotencyKey: key });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('DOMAIN_INVALID_STATE_TRANSITION');
    expect(gw.refund).not.toHaveBeenCalled();
  });
});
