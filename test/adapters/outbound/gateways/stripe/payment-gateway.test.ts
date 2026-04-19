// =============================================================================
// Stripe PaymentGateway adapter tests.
// -----------------------------------------------------------------------------
// Stubs the Stripe client's `paymentIntents` and `refunds` resources with
// minimal typed fakes so the adapter logic is exercised without hitting the
// real Stripe API. `stripe-mock` remains an option for full-fidelity
// integration testing, but that runs outside CI.
//
// Coverage:
//   - initiate: happy path passes idempotencyKey to Stripe + translates amount.
//   - initiate: requires_action returns a ThreeDSChallenge.
//   - confirm: succeeded / requires_action / failed mappings.
//   - capture: passes amount_to_capture when provided.
//   - refund: passes payment_intent + amount + reason metadata.
//   - error mapping: StripeCardError → GATEWAY_CARD_DECLINED.
//   - amount guard: > MAX_SAFE_INTEGER throws RangeError.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';

import {
  Money,
  createGatewayRef,
  idempotencyKey,
  type GatewayRef,
} from '../../../../../src/domain/index.js';
import type { StripeClient, StripePaymentIntent, StripeRefund } from '../../../../../src/adapters/outbound/gateways/stripe/client.js';
import { StripeErrors } from '../../../../../src/adapters/outbound/gateways/stripe/client.js';
import { StripePaymentGateway } from '../../../../../src/adapters/outbound/gateways/stripe/payment-gateway.js';
import { StripeGatewayError } from '../../../../../src/adapters/outbound/gateways/stripe/errors.js';

const key = idempotencyKey('pc-test-key-00001');
const usd = (n: bigint) => Money.of(n, 'USD');
const refOf = (id: string): GatewayRef => {
  const r = createGatewayRef('stripe', id);
  if (!r.ok) throw r.error;
  return r.value;
};

interface IntentsCreateBody {
  readonly amount: number;
  readonly currency: string;
  readonly metadata: Record<string, string>;
}
interface IntentsCreateOptions {
  readonly idempotencyKey: string;
}
interface IntentsCaptureBody {
  readonly amount_to_capture?: number;
}
interface RefundsCreateBody {
  readonly payment_intent: string;
  readonly amount?: number;
  readonly metadata?: Record<string, string>;
}
interface RefundsCreateOptions {
  readonly idempotencyKey: string;
}

function fakeIntent(overrides: Partial<StripePaymentIntent> = {}): StripePaymentIntent {
  const base = {
    id: 'pi_test_1',
    object: 'payment_intent',
    amount: 1000,
    currency: 'usd',
    status: 'succeeded',
    client_secret: 'pi_test_1_secret_abc',
    last_payment_error: null,
    metadata: {},
  };
  return { ...base, ...overrides } as unknown as StripePaymentIntent;
}

function fakeRefund(overrides: Partial<StripeRefund> = {}): StripeRefund {
  return {
    id: 're_test_1',
    object: 'refund',
    status: 'succeeded',
    payment_intent: 'pi_test_1',
    ...overrides,
  } as unknown as StripeRefund;
}

function stubClient(handlers: {
  intentsCreate?: (...args: unknown[]) => Promise<StripePaymentIntent>;
  intentsConfirm?: (...args: unknown[]) => Promise<StripePaymentIntent>;
  intentsCapture?: (...args: unknown[]) => Promise<StripePaymentIntent>;
  refundsCreate?: (...args: unknown[]) => Promise<StripeRefund>;
}) {
  const create = vi.fn(handlers.intentsCreate ?? (async () => fakeIntent()));
  const confirm = vi.fn(handlers.intentsConfirm ?? (async () => fakeIntent()));
  const capture = vi.fn(handlers.intentsCapture ?? (async () => fakeIntent()));
  const refundsCreate = vi.fn(handlers.refundsCreate ?? (async () => fakeRefund()));
  const client = {
    paymentIntents: { create, confirm, capture },
    refunds: { create: refundsCreate },
  } as unknown as StripeClient;
  return { client, create, confirm, capture, refundsCreate };
}

describe('StripePaymentGateway.initiate', () => {
  it('passes idempotencyKey through to the Stripe SDK', async () => {
    const { client, create } = stubClient({});
    const adapter = new StripePaymentGateway({ client });
    await adapter.initiate({
      amount: usd(1234n),
      consumer: 'dojo-os',
      customerReference: 'cus_abc',
      idempotencyKey: key,
      metadata: { order_id: 'ord_1' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0];
    expect(callArgs).toBeDefined();
    const [body, options] = callArgs as [IntentsCreateBody, IntentsCreateOptions];
    expect(body.amount).toBe(1234);
    expect(body.currency).toBe('usd');
    expect(options.idempotencyKey).toBe(key);
    expect(body.metadata['consumer']).toBe('dojo-os');
    expect(body.metadata['customer_reference']).toBe('cus_abc');
  });

  it('returns a ThreeDSChallenge when the intent requires action', async () => {
    const { client } = stubClient({
      intentsCreate: async () =>
        fakeIntent({ status: 'requires_action', client_secret: 'pi_needs_3ds_secret' }),
    });
    const adapter = new StripePaymentGateway({ client });
    const result = await adapter.initiate({
      amount: usd(500n),
      consumer: 'altrupets-api',
      customerReference: 'cus_def',
      idempotencyKey: key,
      metadata: {},
    });
    expect(result.requiresAction).toBe(true);
    expect(result.challenge).toBeDefined();
    expect(result.challenge!.challengeId).toBe('pi_test_1');
    expect(result.clientSecret).toBe('pi_needs_3ds_secret');
  });

  it('maps StripeCardError to GATEWAY_CARD_DECLINED', async () => {
    const { client } = stubClient({
      intentsCreate: async () => {
        throw new StripeErrors.StripeCardError({
          type: 'card_error',
          message: 'Your card was declined.',
          decline_code: 'generic_decline',
        });
      },
    });
    const adapter = new StripePaymentGateway({ client });
    await expect(
      adapter.initiate({
        amount: usd(100n),
        consumer: 'dojo-os',
        customerReference: 'cus_x',
        idempotencyKey: key,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_CARD_DECLINED' });
  });

  it('refuses amounts over MAX_SAFE_INTEGER', async () => {
    const { client } = stubClient({});
    const adapter = new StripePaymentGateway({ client });
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(
      adapter.initiate({
        amount: usd(huge),
        consumer: 'dojo-os',
        customerReference: 'cus_x',
        idempotencyKey: key,
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('StripePaymentGateway.confirm', () => {
  it('maps succeeded status', async () => {
    const { client } = stubClient({
      intentsConfirm: async () => fakeIntent({ status: 'succeeded' }),
    });
    const adapter = new StripePaymentGateway({ client });
    const result = await adapter.confirm({
      gatewayRef: refOf('pi_test_1'),
      idempotencyKey: key,
    });
    expect(result.status).toBe('succeeded');
  });

  it('maps requires_action status', async () => {
    const { client } = stubClient({
      intentsConfirm: async () => fakeIntent({ status: 'requires_action' }),
    });
    const adapter = new StripePaymentGateway({ client });
    const result = await adapter.confirm({
      gatewayRef: refOf('pi_test_1'),
      idempotencyKey: key,
    });
    expect(result.status).toBe('requires_action');
    expect(result.challenge).toBeDefined();
  });

  it('maps canceled status to failed', async () => {
    const { client } = stubClient({
      intentsConfirm: async () => fakeIntent({ status: 'canceled' }),
    });
    const adapter = new StripePaymentGateway({ client });
    const result = await adapter.confirm({
      gatewayRef: refOf('pi_test_1'),
      idempotencyKey: key,
    });
    expect(result.status).toBe('failed');
  });
});

describe('StripePaymentGateway.capture', () => {
  it('passes amount_to_capture when amount provided', async () => {
    const { client, capture } = stubClient({
      intentsCapture: async () => fakeIntent({ status: 'succeeded' }),
    });
    const adapter = new StripePaymentGateway({ client });
    await adapter.capture({
      gatewayRef: refOf('pi_test_1'),
      amount: usd(750n),
      idempotencyKey: key,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const [, body] = capture.mock.calls[0] as unknown as [string, IntentsCaptureBody];
    expect(body.amount_to_capture).toBe(750);
  });
});

describe('StripePaymentGateway.refund', () => {
  it('includes reason metadata and amount when provided', async () => {
    const { client, refundsCreate } = stubClient({});
    const adapter = new StripePaymentGateway({ client });
    await adapter.refund({
      gatewayRef: refOf('pi_test_1'),
      amount: usd(500n),
      reason: 'requested_by_customer',
      idempotencyKey: key,
    });
    const [body, opts] = refundsCreate.mock.calls[0] as unknown as [
      RefundsCreateBody,
      RefundsCreateOptions,
    ];
    expect(body.payment_intent).toBe('pi_test_1');
    expect(body.amount).toBe(500);
    expect(body.metadata?.['reason']).toBe('requested_by_customer');
    expect(opts.idempotencyKey).toBe(key);
  });

  it('maps pending refund status to succeeded', async () => {
    const { client } = stubClient({
      refundsCreate: async () => fakeRefund({ status: 'pending' }),
    });
    const adapter = new StripePaymentGateway({ client });
    const result = await adapter.refund({
      gatewayRef: refOf('pi_test_1'),
      idempotencyKey: key,
    });
    expect(result.status).toBe('succeeded');
  });

  it('maps failed refund status to failed', async () => {
    const { client } = stubClient({
      refundsCreate: async () => fakeRefund({ status: 'failed' }),
    });
    const adapter = new StripePaymentGateway({ client });
    const result = await adapter.refund({
      gatewayRef: refOf('pi_test_1'),
      idempotencyKey: key,
    });
    expect(result.status).toBe('failed');
  });
});

describe('StripePaymentGateway error mapping', () => {
  it('wraps non-Error throwables into StripeGatewayError', async () => {
    const { client } = stubClient({
      intentsCreate: async () => {
        throw 'unexpected string throw';
      },
    });
    const adapter = new StripePaymentGateway({ client });
    await expect(
      adapter.initiate({
        amount: usd(100n),
        consumer: 'dojo-os',
        customerReference: 'cus_x',
        idempotencyKey: key,
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(StripeGatewayError);
  });
});
