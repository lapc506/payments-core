// =============================================================================
// ProcessWebhook tests — verifier dispatch, idempotency replay on eventId,
// unknown signature failures.
// -----------------------------------------------------------------------------
// The verifier is a plain stub; production adapters supply gateway-specific
// signing. We mainly assert the application layer's orchestration:
//   - Bad signatures surface as err(DomainError).
//   - Two deliveries with the same eventId but different idempotencyKey
//     both short-circuit on the second attempt (the use case checks BOTH
//     the request idempotency key AND the verified eventId).
//   - Happy path dispatches to the caller-supplied handler exactly once.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  idempotencyKey,
  type IdempotencyKey,
  type IdempotencyPort,
  type WebhookEvent,
  type WebhookVerifierPort,
} from '../../src/domain/index.js';
import {
  makeProcessWebhook,
  type WebhookHandler,
  type WebhookVerifierRegistryPort,
} from '../../src/application/use_cases/webhook.js';

const requestKey = idempotencyKey('test-hook-0000001');
const secondRequestKey = idempotencyKey('test-hook-0000002');

const makeIdem = (): IdempotencyPort => {
  const store = new Map<string, unknown>();
  return {
    check: async <T>(k: IdempotencyKey) => (store.has(k) ? (store.get(k) as T) : null),
    commit: async <T>(k: IdempotencyKey, r: T) => {
      store.set(k, r);
    },
  };
};

const sampleEvent: WebhookEvent = {
  gateway: 'stripe',
  eventId: 'evt_abc',
  eventType: 'payment_intent.succeeded',
  payload: new TextEncoder().encode('{}'),
  occurredAt: new Date('2026-04-18T00:00:00Z'),
};

const stubVerifier = (overrides: Partial<WebhookVerifierPort> = {}): WebhookVerifierPort => ({
  gateway: 'stripe',
  verify: vi.fn(async () => sampleEvent),
  ...overrides,
});

const stubRegistry = (port: WebhookVerifierPort): WebhookVerifierRegistryPort => ({
  resolveVerifier: () => port,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeProcessWebhook', () => {
  let idem: IdempotencyPort;

  beforeEach(() => {
    idem = makeIdem();
  });

  it('verifies, dispatches to the handler, and returns the event metadata', async () => {
    const verifier = stubVerifier();
    const handler: WebhookHandler = vi.fn(async () => ({
      handled: true,
      dispatchedTo: 'ConfirmCheckout',
    }));

    const execute = makeProcessWebhook({
      verifiers: stubRegistry(verifier),
      idempotency: idem,
      handler,
    });

    const r = await execute({
      gateway: 'stripe',
      signature: 't=123,v1=abc',
      payload: new TextEncoder().encode('{}'),
      receivedAt: new Date(),
      idempotencyKey: requestKey,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.eventId).toBe('evt_abc');
    expect(r.value.eventType).toBe('payment_intent.succeeded');
    expect(r.value.result.dispatchedTo).toBe('ConfirmCheckout');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('absorbs duplicate deliveries by eventId even when the request key differs', async () => {
    const verifier = stubVerifier();
    const handler: WebhookHandler = vi.fn(async () => ({ handled: true }));

    const execute = makeProcessWebhook({
      verifiers: stubRegistry(verifier),
      idempotency: idem,
      handler,
    });

    await execute({
      gateway: 'stripe',
      signature: 't=1',
      payload: new TextEncoder().encode('{}'),
      receivedAt: new Date(),
      idempotencyKey: requestKey,
    });
    await execute({
      gateway: 'stripe',
      signature: 't=1',
      payload: new TextEncoder().encode('{}'),
      receivedAt: new Date(),
      idempotencyKey: secondRequestKey,
    });

    // Handler ran once; the second delivery short-circuits on the
    // eventId idempotency check.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns err when signature verification fails', async () => {
    const verifier = stubVerifier({
      verify: vi.fn(async () => {
        throw new Error('bad signature');
      }),
    });
    const handler: WebhookHandler = vi.fn(async () => ({ handled: true }));

    const execute = makeProcessWebhook({
      verifiers: stubRegistry(verifier),
      idempotency: idem,
      handler,
    });

    const r = await execute({
      gateway: 'stripe',
      signature: 'invalid',
      payload: new TextEncoder().encode('{}'),
      receivedAt: new Date(),
      idempotencyKey: requestKey,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('APPLICATION_UNEXPECTED');
    expect(handler).not.toHaveBeenCalled();
  });
});
