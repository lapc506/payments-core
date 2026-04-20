// =============================================================================
// Donation use-case tests — CreateOneTime / CreateRecurring / ManageRecurring.
// -----------------------------------------------------------------------------
// Covers every branch each use case can take:
//   - Happy path one-time + recurring (with checkoutUrl surfaced).
//   - Pause + cancel via ManageRecurringDonation.
//   - Idempotency replay returns the cached result without a second port call.
//   - Money validation: zero amount and negative amount both yield
//     InvalidMoneyError.
//   - campaignId: both `null` ("no campaign") and a populated string are
//     accepted; the port receives the raw value and the Donation entity
//     stores it (coerced to empty string when null).
//   - Port error surfaced as err(DomainError).
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Money,
  createGatewayRef,
  idempotencyKey,
  type Donation,
  type DonationPort,
  type GatewayRef,
  type IdempotencyKey,
  type IdempotencyPort,
  type InitiateDonationResult,
} from '../../src/domain/index.js';
import {
  makeCreateOneTimeDonation,
  makeCreateRecurringDonation,
  makeManageRecurringDonation,
  type DonationRegistryPort,
  type DonationRepositoryPort,
} from '../../src/application/use_cases/donations.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const key = (suffix: string): IdempotencyKey => idempotencyKey(`test-don-${suffix}`);
const usd = (n: bigint): Money => Money.of(n, 'USD');
const gatewayRefOf = (id: string): GatewayRef => {
  const r = createGatewayRef('stripe', id);
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

const makeRepo = (): DonationRepositoryPort & {
  readonly store: Map<string, Donation>;
} => {
  const store = new Map<string, Donation>();
  return {
    store,
    save: async (d) => {
      store.set(d.id, d);
    },
    findById: async (id) => store.get(id) ?? null,
  };
};

const stubPort = (overrides: Partial<DonationPort> = {}): DonationPort => ({
  gateway: 'stripe',
  initiateOneTime: vi.fn(
    async (): Promise<InitiateDonationResult> => ({
      donationId: 'don_1',
      gatewayRef: gatewayRefOf('ch_ot_1'),
      requiresAction: false,
      checkoutUrl: 'https://checkout.stripe.com/pay/ot_1',
    }),
  ),
  initiateRecurring: vi.fn(
    async (): Promise<InitiateDonationResult> => ({
      donationId: 'don_2',
      gatewayRef: gatewayRefOf('sub_rec_1'),
      requiresAction: false,
    }),
  ),
  pauseRecurring: vi.fn(async () => undefined),
  cancelRecurring: vi.fn(async () => undefined),
  ...overrides,
});

const stubRegistry = (port: DonationPort): DonationRegistryPort => ({
  resolveDonationGateway: () => port,
});

// ---------------------------------------------------------------------------
// CreateOneTimeDonation
// ---------------------------------------------------------------------------

describe('makeCreateOneTimeDonation', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  it('persists a one-time donation and surfaces checkoutUrl', async () => {
    const port = stubPort();
    const execute = makeCreateOneTimeDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'don_a',
      consumer: 'altrupets-api',
      donorReference: 'donor-42',
      amount: usd(5000n),
      gateway: 'stripe',
      campaignId: 'altrupets-2026-adoption',
      donorVisibility: 'public',
      idempotencyKey: key('ot-happy'),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ref.donationId).toBe('don_a');
    expect(r.value.ref.kind).toBe('one_time');
    expect(r.value.checkoutUrl).toBe('https://checkout.stripe.com/pay/ot_1');
    expect(r.value.donation.status).toBe('pending');
    expect(r.value.donation.campaignId).toBe('altrupets-2026-adoption');
    expect(r.value.donation.metadata['donation']).toBe('true');
    expect(r.value.donation.metadata['campaign_id']).toBe('altrupets-2026-adoption');
    expect(r.value.donation.metadata['donor_visibility']).toBe('public');
    expect(repo.store.get('don_a')?.gatewayRef?.externalId).toBe('ch_ot_1');
    expect(port.initiateOneTime).toHaveBeenCalledTimes(1);
  });

  it('accepts a null campaignId and coerces to empty string on the entity', async () => {
    const port = stubPort();
    const execute = makeCreateOneTimeDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'don_nocamp',
      consumer: 'altrupets-api',
      donorReference: 'donor-99',
      amount: usd(1200n),
      gateway: 'stripe',
      campaignId: null,
      donorVisibility: 'anonymous',
      idempotencyKey: key('ot-nocamp'),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.donation.campaignId).toBe('');
    // `campaign_id` metadata is omitted entirely when no campaign is attached.
    expect(r.value.donation.metadata['campaign_id']).toBeUndefined();
    expect(r.value.donation.metadata['donor_visibility']).toBe('anonymous');
  });

  it('replays idempotently without re-calling the port', async () => {
    const port = stubPort();
    const execute = makeCreateOneTimeDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const input = {
      id: 'don_idem',
      consumer: 'altrupets-api',
      donorReference: 'donor-1',
      amount: usd(2500n),
      gateway: 'stripe' as const,
      campaignId: null,
      donorVisibility: 'pseudonymous' as const,
      idempotencyKey: key('ot-idem'),
    };
    const first = await execute(input);
    const second = await execute(input);
    expect(first.ok && second.ok).toBe(true);
    expect(port.initiateOneTime).toHaveBeenCalledTimes(1);
  });

  it('rejects zero-amount donations with InvalidMoneyError', async () => {
    const port = stubPort();
    const execute = makeCreateOneTimeDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const r = await execute({
      id: 'don_zero',
      consumer: 'altrupets-api',
      donorReference: 'donor-0',
      amount: usd(0n),
      gateway: 'stripe',
      campaignId: null,
      donorVisibility: 'public',
      idempotencyKey: key('ot-zero'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('DOMAIN_INVALID_MONEY');
    expect(port.initiateOneTime).not.toHaveBeenCalled();
  });

  it('rejects negative-amount donations (defence in depth)', async () => {
    // `Money.of` already rejects negatives, so we fake a Money-shaped object
    // to exercise the second-line-of-defence branch inside the validator.
    const negative = Object.create(Money.prototype) as Money;
    Object.assign(negative, { amountMinor: -100n, currency: 'USD' });
    const port = stubPort();
    const execute = makeCreateOneTimeDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const r = await execute({
      id: 'don_neg',
      consumer: 'altrupets-api',
      donorReference: 'donor-n',
      amount: negative,
      gateway: 'stripe',
      campaignId: null,
      donorVisibility: 'public',
      idempotencyKey: key('ot-neg'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('DOMAIN_INVALID_MONEY');
    expect(port.initiateOneTime).not.toHaveBeenCalled();
  });

  it('surfaces a gateway error as err(DomainError)', async () => {
    const port = stubPort({
      initiateOneTime: vi.fn(async () => {
        throw new Error('network blip');
      }),
    });
    const execute = makeCreateOneTimeDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const r = await execute({
      id: 'don_fail',
      consumer: 'altrupets-api',
      donorReference: 'donor-x',
      amount: usd(100n),
      gateway: 'stripe',
      campaignId: 'c-1',
      donorVisibility: 'public',
      idempotencyKey: key('ot-fail'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_UNEXPECTED');
  });
});

// ---------------------------------------------------------------------------
// CreateRecurringDonation
// ---------------------------------------------------------------------------

describe('makeCreateRecurringDonation', () => {
  let idem: IdempotencyPort;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    idem = makeIdem();
    repo = makeRepo();
  });

  it('persists a recurring donation and records the recurrence interval metadata', async () => {
    const port = stubPort();
    const execute = makeCreateRecurringDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'don_rec_m',
      consumer: 'altrupets-api',
      donorReference: 'donor-rec',
      amount: usd(2500n),
      gateway: 'stripe',
      campaignId: 'altrupets-2026-adoption',
      donorVisibility: 'pseudonymous',
      recurrence: { interval: 'month', count: 1 },
      idempotencyKey: key('rec-happy'),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ref.kind).toBe('recurring');
    expect(r.value.donation.kind).toBe('recurring');
    expect(r.value.donation.status).toBe('pending');
    expect(r.value.donation.metadata['recurrence_interval']).toBe('month');
    expect(r.value.donation.metadata['recurrence_count']).toBe('1');
    expect(port.initiateRecurring).toHaveBeenCalledTimes(1);
  });

  it('encodes custom recurrence via daysBetween', async () => {
    const port = stubPort();
    const execute = makeCreateRecurringDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });

    const r = await execute({
      id: 'don_rec_c',
      consumer: 'altrupets-api',
      donorReference: 'donor-c',
      amount: usd(1000n),
      gateway: 'stripe',
      campaignId: null,
      donorVisibility: 'public',
      recurrence: { interval: 'custom', daysBetween: 14 },
      idempotencyKey: key('rec-custom'),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.donation.metadata['recurrence_interval']).toBe('custom');
    expect(r.value.donation.metadata['recurrence_days_between']).toBe('14');
    expect(r.value.donation.metadata['recurrence_count']).toBeUndefined();
  });

  it('replays idempotently without re-calling the port', async () => {
    const port = stubPort();
    const execute = makeCreateRecurringDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const input = {
      id: 'don_rec_idem',
      consumer: 'altrupets-api',
      donorReference: 'donor-i',
      amount: usd(500n),
      gateway: 'stripe' as const,
      campaignId: null,
      donorVisibility: 'public' as const,
      recurrence: { interval: 'year' as const, count: 1 as const },
      idempotencyKey: key('rec-idem'),
    };
    await execute(input);
    await execute(input);
    expect(port.initiateRecurring).toHaveBeenCalledTimes(1);
  });

  it('rejects zero-amount recurring donations', async () => {
    const port = stubPort();
    const execute = makeCreateRecurringDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const r = await execute({
      id: 'don_rec_zero',
      consumer: 'altrupets-api',
      donorReference: 'donor-0',
      amount: usd(0n),
      gateway: 'stripe',
      campaignId: null,
      donorVisibility: 'public',
      recurrence: { interval: 'month', count: 1 },
      idempotencyKey: key('rec-zero'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('DOMAIN_INVALID_MONEY');
    expect(port.initiateRecurring).not.toHaveBeenCalled();
  });

  it('surfaces a gateway error as err(DomainError)', async () => {
    const port = stubPort({
      initiateRecurring: vi.fn(async () => {
        throw new Error('gateway refused');
      }),
    });
    const execute = makeCreateRecurringDonation({
      gateways: stubRegistry(port),
      repo,
      idempotency: idem,
    });
    const r = await execute({
      id: 'don_rec_err',
      consumer: 'altrupets-api',
      donorReference: 'donor-e',
      amount: usd(100n),
      gateway: 'stripe',
      campaignId: null,
      donorVisibility: 'public',
      recurrence: { interval: 'month', count: 1 },
      idempotencyKey: key('rec-err'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_UNEXPECTED');
  });
});

// ---------------------------------------------------------------------------
// ManageRecurringDonation
// ---------------------------------------------------------------------------

describe('makeManageRecurringDonation', () => {
  let idem: IdempotencyPort;

  beforeEach(() => {
    idem = makeIdem();
  });

  it('pauses a recurring donation by gatewayRef', async () => {
    const port = stubPort();
    const execute = makeManageRecurringDonation({
      gateways: stubRegistry(port),
      idempotency: idem,
    });

    const r = await execute({
      action: 'pause',
      gatewayRef: gatewayRefOf('sub_rec_p'),
      idempotencyKey: key('pause'),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.action).toBe('pause');
    expect(port.pauseRecurring).toHaveBeenCalledTimes(1);
    expect(port.cancelRecurring).not.toHaveBeenCalled();
  });

  it('cancels a recurring donation by gatewayRef', async () => {
    const port = stubPort();
    const execute = makeManageRecurringDonation({
      gateways: stubRegistry(port),
      idempotency: idem,
    });

    const r = await execute({
      action: 'cancel',
      gatewayRef: gatewayRefOf('sub_rec_c'),
      idempotencyKey: key('cancel'),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.action).toBe('cancel');
    expect(port.cancelRecurring).toHaveBeenCalledTimes(1);
    expect(port.pauseRecurring).not.toHaveBeenCalled();
  });

  it('replays pause/cancel idempotently', async () => {
    const port = stubPort();
    const execute = makeManageRecurringDonation({
      gateways: stubRegistry(port),
      idempotency: idem,
    });

    const input = {
      action: 'cancel' as const,
      gatewayRef: gatewayRefOf('sub_rec_idem'),
      idempotencyKey: key('manage-idem'),
    };
    await execute(input);
    await execute(input);
    expect(port.cancelRecurring).toHaveBeenCalledTimes(1);
  });

  it('surfaces a gateway error from pause as err(DomainError)', async () => {
    const port = stubPort({
      pauseRecurring: vi.fn(async () => {
        throw new Error('subscription missing');
      }),
    });
    const execute = makeManageRecurringDonation({
      gateways: stubRegistry(port),
      idempotency: idem,
    });
    const r = await execute({
      action: 'pause',
      gatewayRef: gatewayRefOf('sub_missing'),
      idempotencyKey: key('pause-err'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_UNEXPECTED');
  });
});
