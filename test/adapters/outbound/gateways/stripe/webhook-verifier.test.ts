// =============================================================================
// Stripe WebhookVerifier tests.
// -----------------------------------------------------------------------------
// Covers:
//   - Happy path: constructEvent is called with the raw Buffer + signature +
//     signingSecret; the returned WebhookEvent carries gateway='stripe',
//     eventId, eventType, payload bytes, and occurredAt.
//   - Signature rejection: StripeSignatureVerificationError propagates as
//     `WebhookSignatureError`.
//   - Idempotency: duplicate event.id rejected with GATEWAY_INVALID_REQUEST.
//
// We never call the real Stripe SDK's signing primitives — `constructEvent`
// is stubbed.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';

import {
  idempotencyKey,
  type IdempotencyKey,
  type IdempotencyPort,
} from '../../../../../src/domain/index.js';
import type {
  StripeClient,
  StripeEvent,
} from '../../../../../src/adapters/outbound/gateways/stripe/client.js';
import { StripeErrors } from '../../../../../src/adapters/outbound/gateways/stripe/client.js';
import {
  StripeGatewayError,
  WebhookSignatureError,
} from '../../../../../src/adapters/outbound/gateways/stripe/errors.js';
import { StripeWebhookVerifier } from '../../../../../src/adapters/outbound/gateways/stripe/webhook-verifier.js';

const key = idempotencyKey('wh-test-key-001');

function makeInMemoryIdempotency(): IdempotencyPort {
  const store = new Map<string, unknown>();
  return {
    check: async <T>(k: IdempotencyKey) =>
      store.has(k) ? (store.get(k) as T) : null,
    commit: async <T>(k: IdempotencyKey, result: T) => {
      store.set(k, result);
    },
  };
}

function fakeEvent(overrides: Partial<StripeEvent> = {}): StripeEvent {
  return {
    id: 'evt_test_1',
    object: 'event',
    type: 'payment_intent.succeeded',
    created: 1_760_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: { object: {} },
    ...overrides,
  } as unknown as StripeEvent;
}

function stubClient(handler: (...args: unknown[]) => StripeEvent) {
  const constructEvent = vi.fn(handler);
  const client = {
    webhooks: { constructEvent },
  } as unknown as StripeClient;
  return { client, constructEvent };
}

describe('StripeWebhookVerifier', () => {
  it('verifies signature and returns a domain WebhookEvent', async () => {
    const { client, constructEvent } = stubClient(() => fakeEvent());
    const idemp = makeInMemoryIdempotency();
    const verifier = new StripeWebhookVerifier({
      client,
      signingSecret: 'whsec_test',
      idempotency: idemp,
    });
    const payload = new TextEncoder().encode('{"id":"evt_test_1"}');
    const result = await verifier.verify({
      signature: 't=1,v1=abcd',
      payload,
      receivedAt: new Date(),
      idempotencyKey: key,
    });
    expect(constructEvent).toHaveBeenCalledTimes(1);
    const [rawBody, sig, secret] = constructEvent.mock.calls[0] as [Buffer, string, string];
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(rawBody.toString('utf8')).toBe('{"id":"evt_test_1"}');
    expect(sig).toBe('t=1,v1=abcd');
    expect(secret).toBe('whsec_test');
    expect(result.gateway).toBe('stripe');
    expect(result.eventId).toBe('evt_test_1');
    expect(result.eventType).toBe('payment_intent.succeeded');
    expect(result.payload).toBe(payload);
    expect(result.occurredAt.getTime()).toBe(1_760_000_000 * 1000);
  });

  it('propagates signature errors as WebhookSignatureError', async () => {
    const { client } = stubClient(() => {
      throw new StripeErrors.StripeSignatureVerificationError({
        type: 'api_error',
        message: 'No signatures found matching the expected signature for payload.',
      });
    });
    const verifier = new StripeWebhookVerifier({
      client,
      signingSecret: 'whsec_test',
      idempotency: makeInMemoryIdempotency(),
    });
    await expect(
      verifier.verify({
        signature: 'bogus',
        payload: new Uint8Array([1, 2, 3]),
        receivedAt: new Date(),
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects duplicate event ids', async () => {
    const { client } = stubClient(() => fakeEvent());
    const idemp = makeInMemoryIdempotency();
    const verifier = new StripeWebhookVerifier({
      client,
      signingSecret: 'whsec_test',
      idempotency: idemp,
    });
    const payload = new TextEncoder().encode('{}');
    await verifier.verify({
      signature: 't=1,v1=abcd',
      payload,
      receivedAt: new Date(),
      idempotencyKey: key,
    });
    await expect(
      verifier.verify({
        signature: 't=1,v1=abcd',
        payload,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('wh-test-key-002'),
      }),
    ).rejects.toBeInstanceOf(StripeGatewayError);
  });
});
