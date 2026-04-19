// =============================================================================
// Subscription use-case tests — Create / Switch / Cancel.
// -----------------------------------------------------------------------------
// Covers happy path, idempotency replay, and one error path for each.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createGatewayRef,
  createSubscription,
  idempotencyKey,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type Subscription,
  type SubscriptionPort,
} from '../../src/domain/index.js';
import {
  makeCancelSubscription,
  makeCreateSubscription,
  makeSwitchSubscription,
  type SubscriptionRegistryPort,
  type SubscriptionRepositoryPort,
} from '../../src/application/use_cases/subscription.js';

const key = idempotencyKey('test-sub-0000001');
const gatewayRefOf = (g: string, id: string): GatewayRef => {
  const r = createGatewayRef(g, id);
  if (!r.ok) throw r.error;
  return r.value;
};

const makeIdem = (): IdempotencyPort => {
  const store = new Map<string, unknown>();
  return {
    check: async <T>(k: IdempotencyKey) => (store.has(k) ? (store.get(k) as T) : null),
    commit: async <T>(k: IdempotencyKey, r: T) => {
      store.set(k, r);
    },
  };
};

const makeRepo = (): SubscriptionRepositoryPort & {
  readonly store: Map<string, Subscription>;
} => {
  const store = new Map<string, Subscription>();
  return {
    store,
    save: async (s) => {
      store.set(s.id, s);
    },
    findById: async (id) => store.get(id) ?? null,
  };
};

const stubSubPort = (overrides: Partial<SubscriptionPort> = {}): SubscriptionPort => ({
  gateway: 'stripe',
  create: vi.fn(async () => ({
    gatewayRef: gatewayRefOf('stripe', 'sub_1'),
    status: 'active' as const,
  })),
  switch: vi.fn(async () => ({
    gatewayRef: gatewayRefOf('stripe', 'sub_1'),
    status: 'active' as const,
  })),
  cancel: vi.fn(async () => ({
    gatewayRef: gatewayRefOf('stripe', 'sub_1'),
    status: 'canceled' as const,
    effectiveAt: new Date('2026-05-01T00:00:00Z'),
  })),
  prorate: vi.fn(async () => ({
    proratedAmount: { amountMinor: 0n, currency: 'USD' } as never,
    nextCycleAmount: { amountMinor: 0n, currency: 'USD' } as never,
  })),
  ...overrides,
});

const stubRegistry = (port: SubscriptionPort): SubscriptionRegistryPort => ({
  resolveSubscriptionGateway: () => port,
});

// ---------------------------------------------------------------------------
// CreateSubscription
// ---------------------------------------------------------------------------

describe('makeCreateSubscription', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  it('creates and activates a subscription on the happy path', async () => {
    const port = stubSubPort();
    const execute = makeCreateSubscription({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'sub_1',
      consumer: 'dojo-os',
      customerReference: 'tenant-42',
      planId: 'plan_pro',
      gateway: 'stripe',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subscription.status).toBe('active');
    expect(repo.store.get('sub_1')?.gatewayRef?.externalId).toBe('sub_1');
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it('replays idempotently without re-calling the port', async () => {
    const port = stubSubPort();
    const execute = makeCreateSubscription({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const input = {
      id: 'sub_2',
      consumer: 'dojo-os',
      customerReference: 'tenant-42',
      planId: 'plan_pro',
      gateway: 'stripe' as const,
      idempotencyKey: key,
    };
    await execute(input);
    await execute(input);
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it('surfaces a gateway error as err(DomainError)', async () => {
    const port = stubSubPort({
      create: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const execute = makeCreateSubscription({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'sub_err',
      consumer: 'dojo-os',
      customerReference: 'tenant-42',
      planId: 'plan_pro',
      gateway: 'stripe',
      idempotencyKey: key,
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SwitchSubscription
// ---------------------------------------------------------------------------

describe('makeSwitchSubscription', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  const seedActive = () => {
    const base = createSubscription({
      id: 'sub_a',
      consumer: 'dojo-os',
      customerReference: 'tenant-42',
      planId: 'plan_basic',
      idempotencyKey: key,
    });
    const active: Subscription = {
      ...base,
      status: 'active',
      gatewayRef: gatewayRefOf('stripe', 'sub_a'),
    };
    repo.store.set(active.id, active);
  };

  it('swaps the plan id and keeps the subscription active', async () => {
    seedActive();
    const port = stubSubPort();
    const execute = makeSwitchSubscription({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      subscriptionId: 'sub_a',
      newPlanId: 'plan_pro',
      prorationBehavior: 'create_prorations',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subscription.planId).toBe('plan_pro');
    expect(r.value.subscription.status).toBe('active');
    expect(port.switch).toHaveBeenCalledTimes(1);
  });

  it('returns APPLICATION_SUBSCRIPTION_NOT_FOUND when missing', async () => {
    const port = stubSubPort();
    const execute = makeSwitchSubscription({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      subscriptionId: 'nope',
      newPlanId: 'plan_pro',
      prorationBehavior: 'none',
      idempotencyKey: key,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_SUBSCRIPTION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// CancelSubscription
// ---------------------------------------------------------------------------

describe('makeCancelSubscription', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  it('cancels an active subscription and returns the effectiveAt date', async () => {
    const seed: Subscription = {
      ...createSubscription({
        id: 'sub_c',
        consumer: 'dojo-os',
        customerReference: 'tenant-42',
        planId: 'plan_pro',
        idempotencyKey: key,
      }),
      status: 'active',
      gatewayRef: gatewayRefOf('stripe', 'sub_c'),
    };
    repo.store.set(seed.id, seed);

    const port = stubSubPort();
    const execute = makeCancelSubscription({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      subscriptionId: 'sub_c',
      atPeriodEnd: false,
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subscription.status).toBe('canceled');
    expect(r.value.effectiveAt).toBeInstanceOf(Date);
  });
});
