// =============================================================================
// Escrow use-case tests — Hold / Release / Dispute.
// -----------------------------------------------------------------------------
// Covers happy path, idempotency replay, and error paths for each.
// Release tests include partial + final release behavior.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DisputeOngoingError,
  Money,
  createEscrow,
  createGatewayRef,
  idempotencyKey,
  type Escrow,
  type EscrowPort,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
} from '../../src/domain/index.js';
import {
  makeDisputeEscrow,
  makeHoldEscrow,
  makeReleaseEscrow,
  type EscrowRegistryPort,
  type EscrowRepositoryPort,
} from '../../src/application/use_cases/escrow.js';

const key = idempotencyKey('test-esc-0000001');
const crc = (n: bigint) => Money.of(n, 'CRC');
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

const makeRepo = (): EscrowRepositoryPort & {
  readonly store: Map<string, Escrow>;
} => {
  const store = new Map<string, Escrow>();
  return {
    store,
    save: async (e) => {
      store.set(e.id, e);
    },
    findById: async (id) => store.get(id) ?? null,
  };
};

const stubEscrowPort = (overrides: Partial<EscrowPort> = {}): EscrowPort => ({
  gateway: 'stripe',
  hold: vi.fn(async () => ({
    gatewayRef: gatewayRefOf('stripe', 'pi_hold'),
    status: 'held' as const,
  })),
  release: vi.fn(async () => ({
    gatewayRef: gatewayRefOf('stripe', 'pi_hold'),
    status: 'released' as const,
    releasedAmount: crc(150_000n),
  })),
  dispute: vi.fn(async () => ({
    gatewayRef: gatewayRefOf('stripe', 'pi_hold'),
    disputeId: 'dp_1',
    status: 'disputed' as const,
  })),
  ...overrides,
});

const stubRegistry = (port: EscrowPort): EscrowRegistryPort => ({
  resolveEscrowGateway: () => port,
});

// ---------------------------------------------------------------------------
// HoldEscrow
// ---------------------------------------------------------------------------

describe('makeHoldEscrow', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  it('creates an escrow with aduanext milestone metadata and persists it', async () => {
    const port = stubEscrowPort();
    const execute = makeHoldEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'esc_1',
      consumer: 'aduanext-api',
      payerReference: 'pyme-42',
      payeeReference: 'broker-7',
      amount: crc(150_000n),
      gateway: 'stripe',
      milestoneCondition: {
        milestones: ['dua_signed', 'levante_received'],
        releaseSplit: [50, 50],
      },
      platformFeeMinor: 15_000n,
      platformFeeDestination: 'aduanext-platform',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.escrow.status).toBe('held');
    expect(r.value.escrow.milestoneCondition?.milestones).toEqual([
      'dua_signed',
      'levante_received',
    ]);
    expect(r.value.escrow.platformFeeMinor).toBe(15_000n);
    expect(r.value.escrow.gatewayRef?.externalId).toBe('pi_hold');
    expect(port.hold).toHaveBeenCalledTimes(1);
  });

  it('replays idempotently', async () => {
    const port = stubEscrowPort();
    const execute = makeHoldEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const input = {
      id: 'esc_2',
      consumer: 'aduanext-api',
      payerReference: 'pyme-42',
      payeeReference: 'broker-7',
      amount: crc(100_000n),
      gateway: 'stripe' as const,
      idempotencyKey: key,
    };
    await execute(input);
    await execute(input);
    expect(port.hold).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ReleaseEscrow — partial + final, + already-released rejection
// ---------------------------------------------------------------------------

describe('makeReleaseEscrow', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  const seedHeld = () => {
    const e: Escrow = {
      ...createEscrow({
        id: 'esc_r',
        consumer: 'aduanext-api',
        payerReference: 'pyme-42',
        payeeReference: 'broker-7',
        amount: crc(150_000n),
        idempotencyKey: key,
      }),
      gatewayRef: gatewayRefOf('stripe', 'pi_held'),
    };
    repo.store.set(e.id, e);
  };

  it('releases fully on the happy path', async () => {
    seedHeld();
    const port = stubEscrowPort();
    const execute = makeReleaseEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      escrowId: 'esc_r',
      milestone: 'dua_signed',
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.escrow.status).toBe('released');
  });

  it('leaves the escrow held when the gateway reports a partial release', async () => {
    seedHeld();
    const port = stubEscrowPort({
      release: vi.fn(async () => ({
        gatewayRef: gatewayRefOf('stripe', 'pi_held'),
        status: 'held' as const,
        releasedAmount: crc(75_000n),
      })),
    });
    const execute = makeReleaseEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      escrowId: 'esc_r',
      milestone: 'dua_signed',
      amount: crc(75_000n),
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.escrow.status).toBe('held');
    expect(r.value.escrow.releasedAmount.amountMinor).toBe(75_000n);
  });

  it('returns APPLICATION_ESCROW_NOT_FOUND when missing', async () => {
    const port = stubEscrowPort();
    const execute = makeReleaseEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const r = await execute({ escrowId: 'nope', idempotencyKey: key });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_ESCROW_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// DisputeEscrow
// ---------------------------------------------------------------------------

describe('makeDisputeEscrow', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  it('transitions a held escrow to disputed and captures a disputeId', async () => {
    const e: Escrow = {
      ...createEscrow({
        id: 'esc_d',
        consumer: 'aduanext-api',
        payerReference: 'pyme-42',
        payeeReference: 'broker-7',
        amount: crc(100_000n),
        idempotencyKey: key,
      }),
      gatewayRef: gatewayRefOf('stripe', 'pi_d'),
    };
    repo.store.set(e.id, e);

    const port = stubEscrowPort();
    const execute = makeDisputeEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      escrowId: 'esc_d',
      reason: 'goods not received',
      evidence: ['receipt.pdf'],
      idempotencyKey: key,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.escrow.status).toBe('disputed');
    expect(r.value.disputeId).toBe('dp_1');
  });

  it('rejects a dispute on an already-disputed escrow', async () => {
    const e: Escrow = {
      ...createEscrow({
        id: 'esc_dd',
        consumer: 'aduanext-api',
        payerReference: 'pyme-42',
        payeeReference: 'broker-7',
        amount: crc(100_000n),
        idempotencyKey: key,
      }),
      status: 'disputed',
      gatewayRef: gatewayRefOf('stripe', 'pi_dd'),
    };
    repo.store.set(e.id, e);

    const port = stubEscrowPort();
    const execute = makeDisputeEscrow({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      escrowId: 'esc_dd',
      reason: 'still disputing',
      evidence: [],
      idempotencyKey: key,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(DisputeOngoingError);
    expect(port.dispute).not.toHaveBeenCalled();
  });
});
