// =============================================================================
// OnvoPayPaymentGateway unit tests
// -----------------------------------------------------------------------------
// Exercises the PaymentGatewayPort implementation against a hand-rolled
// `node:http` stub. No external mocking library — msw@2 would work but adding
// it is not worth the dependency budget for three test files.
//
// Each test spins up an ephemeral port, asserts the outgoing request looks
// correct, and returns a canned OnvoPay-shaped response.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { Money } from '../../../../../src/domain/value_objects/money.js';
import { idempotencyKey } from '../../../../../src/domain/value_objects/idempotency-key.js';
import { InvalidMoneyError } from '../../../../../src/domain/errors.js';

import {
  OnvoPayPaymentGateway,
  OnvoPayCardDeclinedError,
  OnvoPayAuthError,
  OnvoPayInvalidRequestError,
  createOnvoPayHttpClient,
} from '../../../../../src/adapters/outbound/gateways/onvopay/index.js';

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startStub(handler: Handler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  recorded: Recorded[];
  server: Server;
}> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      recorded.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return { baseUrl, close, recorded, server };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnvoPayPaymentGateway', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      if (s) {
        await s.close();
      }
    }
  });

  it('initiate: sends a POST /v1/charges with bearer auth + idempotency key and maps the response', async () => {
    const stub = await startStub((req, res, _body) => {
      json(res, 200, {
        id: 'chr_123',
        amount: 1500,
        currency: 'CRC',
        status: 'succeeded',
      });
    });
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    const result = await gateway.initiate({
      amount: Money.of(1500n, 'CRC'),
      consumer: 'habitanexus-api',
      customerReference: 'cust_1',
      idempotencyKey: idempotencyKey('test-ch-00000001'),
      metadata: { invoice: 'INV-9' },
    });

    expect(result.gatewayRef).toEqual({ gateway: 'onvopay', externalId: 'chr_123' });
    expect(result.requiresAction).toBe(false);

    const rec = stub.recorded[0];
    expect(rec).toBeDefined();
    expect(rec?.method).toBe('POST');
    expect(rec?.path).toBe('/v1/charges');
    expect(rec?.headers['authorization']).toBe('Bearer sk_test_abc');
    expect(rec?.headers['idempotency-key']).toBe('test-ch-00000001');
    const parsed = JSON.parse(rec?.body ?? '{}');
    expect(parsed.amount).toBe(1500);
    expect(parsed.currency).toBe('CRC');
    expect(parsed.metadata.consumer).toBe('habitanexus-api');
  });

  it('initiate: surfaces `requires_action` + redirect URL from next_action', async () => {
    const stub = await startStub((req, res) => {
      json(res, 200, {
        id: 'chr_456',
        amount: 500,
        currency: 'CRC',
        status: 'requires_action',
        next_action: { redirect_url: 'https://3ds.onvopay.com/xyz' },
      });
    });
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    const result = await gateway.initiate({
      amount: Money.of(500n, 'CRC'),
      consumer: 'habitanexus-api',
      customerReference: 'cust_1',
      idempotencyKey: idempotencyKey('test-ch-00000002'),
      metadata: {},
    });
    expect(result.requiresAction).toBe(true);
    expect(result.challenge).toBeDefined();
    expect(new TextDecoder().decode(result.challenge?.data)).toBe(
      'https://3ds.onvopay.com/xyz',
    );
  });

  it('initiate: rejects non-CRC currencies with InvalidMoneyError (CRC-only policy)', async () => {
    const stub = await startStub((_req, res) => json(res, 200, {}));
    servers.push(stub);
    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    await expect(
      gateway.initiate({
        amount: Money.of(1000n, 'USD'),
        consumer: 'habitanexus-api',
        customerReference: 'cust_1',
        idempotencyKey: idempotencyKey('test-ch-00000003'),
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(InvalidMoneyError);
    // No outgoing request should have been made.
    expect(stub.recorded).toHaveLength(0);
  });

  it('initiate: maps HTTP 402 to OnvoPayCardDeclinedError', async () => {
    const stub = await startStub((_req, res) => {
      json(res, 402, { error: 'card_declined' });
    });
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    await expect(
      gateway.initiate({
        amount: Money.of(1000n, 'CRC'),
        consumer: 'habitanexus-api',
        customerReference: 'cust_1',
        idempotencyKey: idempotencyKey('test-ch-00000004'),
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(OnvoPayCardDeclinedError);
  });

  it('initiate: maps HTTP 401 to OnvoPayAuthError and never retries', async () => {
    let hits = 0;
    const stub = await startStub((_req, res) => {
      hits++;
      json(res, 401, { error: 'unauthorized' });
    });
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 3, // If business errors were retried, we'd see >1 hit.
    });
    const gateway = new OnvoPayPaymentGateway(http);

    await expect(
      gateway.initiate({
        amount: Money.of(1n, 'CRC'),
        consumer: 'habitanexus-api',
        customerReference: 'cust_1',
        idempotencyKey: idempotencyKey('test-ch-00000005'),
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(OnvoPayAuthError);
    expect(hits).toBe(1);
  });

  it('initiate: maps HTTP 422 to OnvoPayInvalidRequestError', async () => {
    const stub = await startStub((_req, res) => json(res, 422, { error: 'bad' }));
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    await expect(
      gateway.initiate({
        amount: Money.of(1n, 'CRC'),
        consumer: 'habitanexus-api',
        customerReference: 'cust_1',
        idempotencyKey: idempotencyKey('test-ch-00000006'),
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(OnvoPayInvalidRequestError);
  });

  it('refund: POSTs to /v1/refunds with the charge id', async () => {
    const stub = await startStub((_req, res) => {
      json(res, 200, { id: 'ref_1', status: 'succeeded' });
    });
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    const result = await gateway.refund({
      gatewayRef: { gateway: 'onvopay', externalId: 'chr_123' },
      idempotencyKey: idempotencyKey('test-rf-00000001'),
      amount: Money.of(500n, 'CRC'),
      reason: 'customer_request',
    });
    expect(result.refundGatewayRef.externalId).toBe('ref_1');
    expect(result.status).toBe('succeeded');

    const rec = stub.recorded[0];
    expect(rec?.path).toBe('/v1/refunds');
    const body = JSON.parse(rec?.body ?? '{}');
    expect(body.charge).toBe('chr_123');
    expect(body.amount).toBe(500);
    expect(body.reason).toBe('customer_request');
  });

  it('capture: POSTs to /v1/charges/:id/capture', async () => {
    const stub = await startStub((_req, res) => {
      json(res, 200, { id: 'chr_xyz', status: 'succeeded', amount: 1000, currency: 'CRC' });
    });
    servers.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test_abc',
      maxRetries: 0,
    });
    const gateway = new OnvoPayPaymentGateway(http);

    const result = await gateway.capture({
      gatewayRef: { gateway: 'onvopay', externalId: 'chr_xyz' },
      idempotencyKey: idempotencyKey('test-cp-00000001'),
    });
    expect(result.status).toBe('succeeded');
    expect(stub.recorded[0]?.path).toBe('/v1/charges/chr_xyz/capture');
  });
});
