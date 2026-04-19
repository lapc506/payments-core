// =============================================================================
// OnvoPayWebhookVerifier unit tests
// -----------------------------------------------------------------------------
// Cover the three contract points the port promises:
//
//   1. A correctly-signed webhook produces a WebhookEvent with the gateway
//      metadata populated.
//   2. Any signature mismatch (bad secret, bad hex, truncated digest,
//      missing header) throws WebhookSignatureError BEFORE any JSON parse.
//   3. Duplicate event ids (replayed webhooks, gateway retries after a
//      processing error ACK) are rejected on the second delivery.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

import { idempotencyKey } from '../../../../../src/domain/value_objects/idempotency-key.js';

import {
  OnvoPayWebhookVerifier,
  InMemoryOnvoPayDedupeStore,
  WebhookDuplicateEventError,
  WebhookSignatureError,
} from '../../../../../src/adapters/outbound/gateways/onvopay/index.js';

const SECRET = 'whsec_test_0123456789';

function sign(payload: Uint8Array): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe('OnvoPayWebhookVerifier', () => {
  let verifier: OnvoPayWebhookVerifier;
  let dedupe: InMemoryOnvoPayDedupeStore;

  beforeEach(() => {
    dedupe = new InMemoryOnvoPayDedupeStore();
    verifier = new OnvoPayWebhookVerifier({ signingSecret: SECRET, dedupe });
  });

  it('accepts a valid HMAC-SHA256 signature (bare hex form)', async () => {
    const payload = encode({
      id: 'evt_1',
      type: 'charge.succeeded',
      created_at: '2026-04-18T00:00:00Z',
    });
    const event = await verifier.verify({
      signature: sign(payload),
      payload,
      receivedAt: new Date('2026-04-18T00:00:01Z'),
      idempotencyKey: idempotencyKey('test-wh-00000001'),
    });
    expect(event.gateway).toBe('onvopay');
    expect(event.eventId).toBe('evt_1');
    expect(event.eventType).toBe('charge.succeeded');
    expect(event.payload).toBe(payload);
    expect(event.occurredAt.toISOString()).toBe('2026-04-18T00:00:00.000Z');
  });

  it('accepts the composite `t=<unix>,v1=<hex>` header form', async () => {
    const payload = encode({ id: 'evt_2', type: 'charge.refunded' });
    const sig = sign(payload);
    const composite = `t=1713396000,v1=${sig}`;
    const event = await verifier.verify({
      signature: composite,
      payload,
      receivedAt: new Date(),
      idempotencyKey: idempotencyKey('test-wh-00000002'),
    });
    expect(event.eventId).toBe('evt_2');
  });

  it('rejects a tampered payload with WebhookSignatureError', async () => {
    const original = encode({ id: 'evt_3', type: 'charge.succeeded' });
    const sig = sign(original);
    const tampered = encode({ id: 'evt_3', type: 'charge.refunded' });
    await expect(
      verifier.verify({
        signature: sig,
        payload: tampered,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('test-wh-00000003'),
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a missing signature header', async () => {
    const payload = encode({ id: 'evt_4', type: 'charge.succeeded' });
    await expect(
      verifier.verify({
        signature: '',
        payload,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('test-wh-00000004'),
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a malformed hex signature (odd length) without attempting comparison', async () => {
    const payload = encode({ id: 'evt_5', type: 'charge.succeeded' });
    await expect(
      verifier.verify({
        signature: 'abc',
        payload,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('test-wh-00000005'),
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a wrong-secret signature of the right length', async () => {
    const payload = encode({ id: 'evt_6', type: 'charge.succeeded' });
    const wrongSig = createHmac('sha256', 'whsec_wrong').update(payload).digest('hex');
    await expect(
      verifier.verify({
        signature: wrongSig,
        payload,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('test-wh-00000006'),
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects duplicate event ids on a second delivery', async () => {
    const payload = encode({ id: 'evt_dup', type: 'charge.succeeded' });
    const sig = sign(payload);

    // First delivery passes.
    await verifier.verify({
      signature: sig,
      payload,
      receivedAt: new Date(),
      idempotencyKey: idempotencyKey('test-wh-00000007'),
    });

    // Second delivery (gateway retry / replay) rejected.
    await expect(
      verifier.verify({
        signature: sig,
        payload,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('test-wh-00000008'),
      }),
    ).rejects.toBeInstanceOf(WebhookDuplicateEventError);
  });

  it('rejects a payload whose signature is valid but missing required fields', async () => {
    const payload = encode({ id: '', type: '' });
    const sig = sign(payload);
    await expect(
      verifier.verify({
        signature: sig,
        payload,
        receivedAt: new Date(),
        idempotencyKey: idempotencyKey('test-wh-00000009'),
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('falls back to receivedAt when OnvoPay does not provide created_at', async () => {
    const payload = encode({ id: 'evt_no_ts', type: 'charge.succeeded' });
    const sig = sign(payload);
    const receivedAt = new Date('2026-05-01T12:00:00Z');
    const event = await verifier.verify({
      signature: sig,
      payload,
      receivedAt,
      idempotencyKey: idempotencyKey('test-wh-0000000a'),
    });
    expect(event.occurredAt.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });
});
