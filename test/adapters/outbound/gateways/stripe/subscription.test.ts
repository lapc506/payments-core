// =============================================================================
// Stripe SubscriptionAdapter tests.
// -----------------------------------------------------------------------------
// Stubs the Stripe client's `subscriptions` + `invoices` resources with
// minimal typed fakes.
//
// Coverage:
//   - create: requires metadata.customer_id; maps status; threads idempotency.
//   - switch: updates the first item's price; passes proration_behavior.
//   - cancel (immediate): calls `cancel()`; returns canceled_at as effectiveAt.
//   - cancel (at period end): calls `update({cancel_at_period_end: true})`;
//     returns current_period_end as effectiveAt.
//   - prorate: reads invoices.createPreview; clamps negative amount_due to 0.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';

import {
  createGatewayRef,
  idempotencyKey,
  type GatewayRef,
} from '../../../../../src/domain/index.js';
import type {
  StripeClient,
  StripeSubscription,
} from '../../../../../src/adapters/outbound/gateways/stripe/client.js';
import {
  STRIPE_CUSTOMER_ID_METADATA_KEY,
  StripeSubscriptionAdapter,
} from '../../../../../src/adapters/outbound/gateways/stripe/subscription.js';
import { StripeGatewayError } from '../../../../../src/adapters/outbound/gateways/stripe/errors.js';

const key = idempotencyKey('sub-test-key-001');
const refOf = (id: string): GatewayRef => {
  const r = createGatewayRef('stripe', id);
  if (!r.ok) throw r.error;
  return r.value;
};

function fakeSub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  const base = {
    id: 'sub_test_1',
    object: 'subscription',
    status: 'active',
    canceled_at: null,
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: 'price_basic' },
          current_period_end: 1_760_000_000,
        },
      ],
    },
  } as unknown as StripeSubscription;
  return Object.assign({}, base, overrides) as StripeSubscription;
}

function stubClient(handlers: {
  create?: (...args: unknown[]) => Promise<StripeSubscription>;
  update?: (...args: unknown[]) => Promise<StripeSubscription>;
  cancel?: (...args: unknown[]) => Promise<StripeSubscription>;
  retrieve?: (...args: unknown[]) => Promise<StripeSubscription>;
  invoicesCreatePreview?: (...args: unknown[]) => Promise<unknown>;
}) {
  const create = vi.fn(handlers.create ?? (async () => fakeSub()));
  const update = vi.fn(handlers.update ?? (async () => fakeSub()));
  const cancel = vi.fn(handlers.cancel ?? (async () => fakeSub({ status: 'canceled' as StripeSubscription['status'], canceled_at: 1_760_000_000 } as Partial<StripeSubscription>)));
  const retrieve = vi.fn(handlers.retrieve ?? (async () => fakeSub()));
  const createPreview = vi.fn(
    handlers.invoicesCreatePreview ??
      (async () => ({
        currency: 'usd',
        amount_due: 100,
        amount_remaining: 2000,
      })),
  );
  const client = {
    subscriptions: { create, update, cancel, retrieve },
    invoices: { createPreview },
  } as unknown as StripeClient;
  return { client, create, update, cancel, retrieve, createPreview };
}

describe('StripeSubscriptionAdapter.create', () => {
  it('threads idempotencyKey and maps trialing → active', async () => {
    const { client, create } = stubClient({
      create: async () => fakeSub({ status: 'trialing' as StripeSubscription['status'] } as Partial<StripeSubscription>),
    });
    const adapter = new StripeSubscriptionAdapter({ client });
    const result = await adapter.create({
      consumer: 'habitanexus-api',
      customerReference: 'cus_xyz',
      planId: 'price_basic',
      idempotencyKey: key,
      metadata: { [STRIPE_CUSTOMER_ID_METADATA_KEY]: 'cus_stripe_1' },
    });
    expect(result.status).toBe('active');
    const [body, opts] = create.mock.calls[0] as unknown as [
      { customer: string },
      { idempotencyKey: string },
    ];
    expect(body.customer).toBe('cus_stripe_1');
    expect(opts.idempotencyKey).toBe(key);
  });

  it('requires metadata.customer_id', async () => {
    const { client } = stubClient({});
    const adapter = new StripeSubscriptionAdapter({ client });
    await expect(
      adapter.create({
        consumer: 'habitanexus-api',
        customerReference: 'cus_xyz',
        planId: 'price_basic',
        idempotencyKey: key,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_INVALID_REQUEST' });
  });

  it('maps past_due and incomplete statuses', async () => {
    const { client: pastDueClient } = stubClient({
      create: async () => fakeSub({ status: 'past_due' as StripeSubscription['status'] } as Partial<StripeSubscription>),
    });
    const pastDue = await new StripeSubscriptionAdapter({ client: pastDueClient }).create({
      consumer: 'c',
      customerReference: 'cus_r',
      planId: 'p',
      idempotencyKey: key,
      metadata: { [STRIPE_CUSTOMER_ID_METADATA_KEY]: 'cus_1' },
    });
    expect(pastDue.status).toBe('past_due');

    const { client: incompClient } = stubClient({
      create: async () => fakeSub({ status: 'incomplete' as StripeSubscription['status'] } as Partial<StripeSubscription>),
    });
    const incomp = await new StripeSubscriptionAdapter({ client: incompClient }).create({
      consumer: 'c',
      customerReference: 'cus_r',
      planId: 'p',
      idempotencyKey: key,
      metadata: { [STRIPE_CUSTOMER_ID_METADATA_KEY]: 'cus_1' },
    });
    expect(incomp.status).toBe('incomplete');
  });
});

describe('StripeSubscriptionAdapter.switch', () => {
  it('updates the first item with the new price and proration_behavior', async () => {
    const { client, update } = stubClient({});
    const adapter = new StripeSubscriptionAdapter({ client });
    await adapter.switch({
      gatewayRef: refOf('sub_test_1'),
      newPlanId: 'price_premium',
      prorationBehavior: 'always_invoice',
      idempotencyKey: key,
    });
    interface UpdateBody {
      readonly proration_behavior: string;
      readonly items: { id: string; price: string }[];
    }
    const [subId, body] = update.mock.calls[0] as unknown as [string, UpdateBody];
    expect(subId).toBe('sub_test_1');
    expect(body.proration_behavior).toBe('always_invoice');
    expect(body.items[0]?.id).toBe('si_1');
    expect(body.items[0]?.price).toBe('price_premium');
  });

  it('rejects a subscription with no items', async () => {
    const { client } = stubClient({
      retrieve: async () => fakeSub({ items: { data: [] } } as unknown as Partial<StripeSubscription>),
    });
    const adapter = new StripeSubscriptionAdapter({ client });
    await expect(
      adapter.switch({
        gatewayRef: refOf('sub_test_1'),
        newPlanId: 'price_premium',
        prorationBehavior: 'none',
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(StripeGatewayError);
  });
});

describe('StripeSubscriptionAdapter.cancel', () => {
  it('immediate cancel uses subscriptions.cancel and exposes canceled_at', async () => {
    const { client, cancel } = stubClient({});
    const adapter = new StripeSubscriptionAdapter({ client });
    const result = await adapter.cancel({
      gatewayRef: refOf('sub_test_1'),
      atPeriodEnd: false,
      reason: 'user_requested',
      idempotencyKey: key,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('canceled');
    expect(result.effectiveAt).toBeInstanceOf(Date);
  });

  it('at-period-end cancel uses subscriptions.update and reads current_period_end', async () => {
    const { client, update } = stubClient({});
    const adapter = new StripeSubscriptionAdapter({ client });
    const result = await adapter.cancel({
      gatewayRef: refOf('sub_test_1'),
      atPeriodEnd: true,
      idempotencyKey: key,
    });
    expect(update).toHaveBeenCalledTimes(1);
    const [, body] = update.mock.calls[0] as unknown as [
      string,
      { cancel_at_period_end: boolean },
    ];
    expect(body.cancel_at_period_end).toBe(true);
    // current_period_end in fakeSub → 1_760_000_000
    expect(result.effectiveAt.getTime()).toBe(1_760_000_000 * 1000);
  });
});

describe('StripeSubscriptionAdapter.prorate', () => {
  it('returns proratedAmount and nextCycleAmount with uppercase currency', async () => {
    const { client } = stubClient({});
    const adapter = new StripeSubscriptionAdapter({ client });
    const result = await adapter.prorate({
      gatewayRef: refOf('sub_test_1'),
      newPlanId: 'price_premium',
      idempotencyKey: key,
    });
    expect(result.proratedAmount.currency).toBe('USD');
    expect(result.proratedAmount.amountMinor).toBe(100n);
    expect(result.nextCycleAmount.currency).toBe('USD');
    expect(result.nextCycleAmount.amountMinor).toBe(2000n);
  });

  it('clamps negative amount_due to zero (downgrade credit)', async () => {
    const { client } = stubClient({
      invoicesCreatePreview: async () => ({
        currency: 'usd',
        amount_due: -500,
        amount_remaining: 1000,
      }),
    });
    const adapter = new StripeSubscriptionAdapter({ client });
    const result = await adapter.prorate({
      gatewayRef: refOf('sub_test_1'),
      newPlanId: 'price_cheap',
      idempotencyKey: key,
    });
    expect(result.proratedAmount.amountMinor).toBe(0n);
  });
});
