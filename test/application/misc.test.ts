// =============================================================================
// Combined tests — CreatePayout + HandleAgenticPayment + GetPaymentHistory +
// ReconcileDaily.
// -----------------------------------------------------------------------------
// Collapsed into one file to stay at/under the 15-file budget. Each use
// case has independent port stubs inside its own `describe` block.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';

import {
  Money,
  createGatewayRef,
  idempotencyKey,
  type AgenticPaymentPort,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type ReconciliationPort,
} from '../../src/domain/index.js';
import {
  makeCreatePayout,
  type PayoutGatewayPort,
  type PayoutRegistryPort,
  type PayoutRepositoryPort,
} from '../../src/application/use_cases/payout.js';
import { makeHandleAgenticPayment } from '../../src/application/use_cases/agentic.js';
import {
  makeGetPaymentHistory,
  makeReconcileDaily,
  type PaymentHistoryEntry,
  type PaymentHistoryReaderPort,
  type ReconciliationRegistryPort,
} from '../../src/application/use_cases/reads.js';
import type {
  PaymentIntentRepositoryPort,
} from '../../src/application/use_cases/checkout.js';
import type { Payout, PaymentIntent } from '../../src/domain/index.js';

const key = idempotencyKey('test-misc-000001');
const usd = (n: bigint) => Money.of(n, 'USD');
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

// ---------------------------------------------------------------------------
// CreatePayout
// ---------------------------------------------------------------------------

describe('makeCreatePayout', () => {
  const makeRepo = (): PayoutRepositoryPort & { readonly store: Map<string, Payout> } => {
    const store = new Map<string, Payout>();
    return {
      store,
      save: async (p) => {
        store.set(p.id, p);
      },
      findById: async (id) => store.get(id) ?? null,
    };
  };

  const stubPort = (
    status: 'pending' | 'paid' | 'failed' = 'pending',
  ): PayoutGatewayPort => ({
    gateway: 'stripe',
    createPayout: vi.fn(async () => ({
      gatewayRef: gatewayRefOf('stripe', 'po_1'),
      status,
    })),
  });

  const stubRegistry = (port: PayoutGatewayPort): PayoutRegistryPort => ({
    resolvePayoutGateway: () => port,
  });

  it('creates a pending payout and persists it', async () => {
    const repo = makeRepo();
    const port = stubPort('pending');
    const execute = makeCreatePayout({
      gateways: stubRegistry(port),
      repo,
      idempotency: makeIdem(),
    });

    const r = await execute({
      id: 'po_1',
      consumer: 'aduanext-api',
      beneficiaryReference: 'broker-7',
      amount: usd(5000n),
      gateway: 'stripe',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.payout.status).toBe('pending');
    expect(r.value.payout.gatewayRef?.externalId).toBe('po_1');
  });

  it('advances to paid synchronously when the gateway already returned paid', async () => {
    const repo = makeRepo();
    const port = stubPort('paid');
    const execute = makeCreatePayout({
      gateways: stubRegistry(port),
      repo,
      idempotency: makeIdem(),
    });

    const r = await execute({
      id: 'po_2',
      consumer: 'aduanext-api',
      beneficiaryReference: 'broker-7',
      amount: usd(1000n),
      gateway: 'stripe',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.payout.status).toBe('paid');
  });

  it('returns err when the gateway throws', async () => {
    const repo = makeRepo();
    const port: PayoutGatewayPort = {
      gateway: 'stripe',
      createPayout: vi.fn(async () => {
        throw new Error('blocked');
      }),
    };
    const execute = makeCreatePayout({
      gateways: stubRegistry(port),
      repo,
      idempotency: makeIdem(),
    });

    const r = await execute({
      id: 'po_err',
      consumer: 'aduanext-api',
      beneficiaryReference: 'broker-7',
      amount: usd(5000n),
      gateway: 'stripe',
      idempotencyKey: key,
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HandleAgenticPayment
// ---------------------------------------------------------------------------

describe('makeHandleAgenticPayment', () => {
  const makeRepo = (): PaymentIntentRepositoryPort & {
    readonly store: Map<string, PaymentIntent>;
  } => {
    const store = new Map<string, PaymentIntent>();
    return {
      store,
      save: async (i) => {
        store.set(i.id, i);
      },
      findById: async (id) => store.get(id) ?? null,
    };
  };

  const stubAgentic = (): AgenticPaymentPort => ({
    initiateAgenticPayment: vi.fn(async () => ({
      intentId: 'pi_agent',
      gatewayRef: gatewayRefOf('stripe', 'pi_agent'),
      status: 'pending' as const,
    })),
  });

  it('stamps agent metadata and creates a pending intent', async () => {
    const repo = makeRepo();
    const agentic = stubAgentic();
    const execute = makeHandleAgenticPayment({
      agentic,
      repo,
      idempotency: makeIdem(),
    });

    const r = await execute({
      id: 'pi_agent',
      consumer: 'doji',
      agentId: 'agent_1',
      toolCallId: 'tool_1',
      auditJwt: 'eyJ...',
      customerReference: 'user-42',
      amount: usd(2000n),
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.intent.status).toBe('pending');
    expect(r.value.intent.metadata['agent_initiated']).toBe('true');
    expect(r.value.intent.metadata['agent_id']).toBe('agent_1');
    expect(r.value.intent.metadata['tool_call_id']).toBe('tool_1');
    expect(agentic.initiateAgenticPayment).toHaveBeenCalledTimes(1);
  });

  it('replays idempotently', async () => {
    const repo = makeRepo();
    const agentic = stubAgentic();
    const execute = makeHandleAgenticPayment({
      agentic,
      repo,
      idempotency: makeIdem(),
    });
    const input = {
      id: 'pi_agent2',
      consumer: 'doji',
      agentId: 'agent_1',
      toolCallId: 'tool_1',
      auditJwt: 'eyJ...',
      customerReference: 'user-42',
      amount: usd(2000n),
      idempotencyKey: key,
    };
    await execute(input);
    await execute(input);
    expect(agentic.initiateAgenticPayment).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GetPaymentHistory
// ---------------------------------------------------------------------------

describe('makeGetPaymentHistory', () => {
  const stubReader = (entries: readonly PaymentHistoryEntry[]): PaymentHistoryReaderPort => ({
    list: vi.fn(async () => ({ entries, nextCursor: '' })),
  });

  it('returns the entries the reader port produces', async () => {
    const entry: PaymentHistoryEntry = {
      intentId: 'pi_1',
      consumer: 'altrupets',
      customerReference: 'user-42',
      amount: usd(1000n),
      status: 'succeeded',
      gateway: 'stripe',
      createdAt: new Date('2026-04-18T00:00:00Z'),
    };
    const execute = makeGetPaymentHistory({ reader: stubReader([entry]) });
    const r = await execute({
      consumer: 'altrupets',
      limit: 50,
      cursor: '',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(1);
    expect(r.value.entries[0]?.intentId).toBe('pi_1');
  });

  it('rejects out-of-range limits', async () => {
    const execute = makeGetPaymentHistory({ reader: stubReader([]) });
    const r = await execute({ consumer: 'altrupets', limit: 0, cursor: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_INVALID_PAGE_SIZE');
  });
});

// ---------------------------------------------------------------------------
// ReconcileDaily
// ---------------------------------------------------------------------------

describe('makeReconcileDaily', () => {
  const stubPort = (gateway: 'stripe' | 'onvopay'): ReconciliationPort => ({
    gateway,
    reconcileDaily: vi.fn(async () => ({
      date: '2026-04-17',
      matchedCount: 10,
      diffs: [],
    })),
  });

  const stubRegistry = (ports: readonly ReconciliationPort[]): ReconciliationRegistryPort => ({
    listReconciliationPorts: () => ports,
  });

  it('iterates every registered gateway and returns a per-gateway result', async () => {
    const ports = [stubPort('stripe'), stubPort('onvopay')];
    const execute = makeReconcileDaily({ registry: stubRegistry(ports) });
    const r = await execute({ date: '2026-04-17' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results).toHaveLength(2);
    expect(r.value.results.map((x) => x.gateway)).toEqual(['stripe', 'onvopay']);
  });

  it('filters by the `gateways` param when provided', async () => {
    const ports = [stubPort('stripe'), stubPort('onvopay')];
    const execute = makeReconcileDaily({ registry: stubRegistry(ports) });
    const r = await execute({ date: '2026-04-17', gateways: ['onvopay'] });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results).toHaveLength(1);
    expect(r.value.results[0]?.gateway).toBe('onvopay');
  });

  it('rejects malformed date strings', async () => {
    const execute = makeReconcileDaily({ registry: stubRegistry([]) });
    const r = await execute({ date: '04/17/2026' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_INVALID_DATE');
  });
});
