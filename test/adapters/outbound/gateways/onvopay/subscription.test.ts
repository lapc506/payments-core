// =============================================================================
// OnvoPaySubscriptionGateway unit tests
// -----------------------------------------------------------------------------
// Same HTTP-stub pattern as the payment-gateway tests, focused on the
// SubscriptionPort surface (create, switch, cancel, prorate).
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { idempotencyKey } from '../../../../../src/domain/value_objects/idempotency-key.js';

import {
  OnvoPaySubscriptionGateway,
  createOnvoPayHttpClient,
} from '../../../../../src/adapters/outbound/gateways/onvopay/index.js';

interface Recorded {
  method: string;
  path: string;
  body: string;
  idempotencyKey: string | undefined;
}

async function startStub(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  recorded: Recorded[];
}> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const idem = req.headers['idempotency-key'];
      recorded.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body,
        idempotencyKey: typeof idem === 'string' ? idem : undefined,
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
  return { baseUrl, close, recorded };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

describe('OnvoPaySubscriptionGateway', () => {
  const stubs: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (stubs.length) {
      const s = stubs.pop();
      if (s) {
        await s.close();
      }
    }
  });

  it('create: POSTs /v1/subscriptions and maps status', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { id: 'sub_123', status: 'active', plan_id: 'plan_monthly' }),
    );
    stubs.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test',
      maxRetries: 0,
    });
    const gateway = new OnvoPaySubscriptionGateway(http);

    const r = await gateway.create({
      consumer: 'habitanexus-api',
      customerReference: 'cust_1',
      planId: 'plan_monthly',
      idempotencyKey: idempotencyKey('test-sub-00000001'),
      metadata: { hoa_id: 'HOA-42' },
    });

    expect(r.gatewayRef.externalId).toBe('sub_123');
    expect(r.status).toBe('active');
    expect(stubs[0]).toBeDefined();
    expect(stub.recorded[0]?.method).toBe('POST');
    expect(stub.recorded[0]?.path).toBe('/v1/subscriptions');
    expect(stub.recorded[0]?.idempotencyKey).toBe('test-sub-00000001');
    const body = JSON.parse(stub.recorded[0]?.body ?? '{}');
    expect(body.plan).toBe('plan_monthly');
    expect(body.metadata.consumer).toBe('habitanexus-api');
  });

  it('switch: PATCHes /v1/subscriptions/:id with the new plan + proration behavior', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { id: 'sub_123', status: 'active' }),
    );
    stubs.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test',
      maxRetries: 0,
    });
    const gateway = new OnvoPaySubscriptionGateway(http);

    await gateway.switch({
      gatewayRef: { gateway: 'onvopay', externalId: 'sub_123' },
      newPlanId: 'plan_yearly',
      prorationBehavior: 'create_prorations',
      idempotencyKey: idempotencyKey('test-sub-00000002'),
    });

    expect(stub.recorded[0]?.method).toBe('PATCH');
    expect(stub.recorded[0]?.path).toBe('/v1/subscriptions/sub_123');
    const body = JSON.parse(stub.recorded[0]?.body ?? '{}');
    expect(body.plan).toBe('plan_yearly');
    expect(body.proration_behavior).toBe('create_prorations');
  });

  it('cancel (immediate): DELETEs /v1/subscriptions/:id', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { id: 'sub_123', status: 'canceled' }),
    );
    stubs.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test',
      maxRetries: 0,
    });
    const gateway = new OnvoPaySubscriptionGateway(http);

    const r = await gateway.cancel({
      gatewayRef: { gateway: 'onvopay', externalId: 'sub_123' },
      atPeriodEnd: false,
      idempotencyKey: idempotencyKey('test-sub-00000003'),
    });

    expect(r.status).toBe('canceled');
    expect(stub.recorded[0]?.method).toBe('DELETE');
    expect(stub.recorded[0]?.path).toBe('/v1/subscriptions/sub_123');
  });

  it('cancel (at period end): POSTs /v1/subscriptions/:id/cancel with the flag', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 200, { id: 'sub_123', status: 'active' }),
    );
    stubs.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test',
      maxRetries: 0,
    });
    const gateway = new OnvoPaySubscriptionGateway(http);

    await gateway.cancel({
      gatewayRef: { gateway: 'onvopay', externalId: 'sub_123' },
      atPeriodEnd: true,
      reason: 'user_requested',
      idempotencyKey: idempotencyKey('test-sub-00000004'),
    });

    expect(stub.recorded[0]?.method).toBe('POST');
    expect(stub.recorded[0]?.path).toBe('/v1/subscriptions/sub_123/cancel');
    const body = JSON.parse(stub.recorded[0]?.body ?? '{}');
    expect(body.at_period_end).toBe(true);
    expect(body.reason).toBe('user_requested');
  });

  it('prorate: throws ADAPTER_ONVOPAY_NOT_IMPLEMENTED until the preview endpoint is verified', async () => {
    const stub = await startStub((_req, res) => json(res, 500, {}));
    stubs.push(stub);

    const http = createOnvoPayHttpClient({
      apiBaseUrl: stub.baseUrl,
      apiKey: 'sk_test',
      maxRetries: 0,
    });
    const gateway = new OnvoPaySubscriptionGateway(http);

    await expect(
      gateway.prorate({
        gatewayRef: { gateway: 'onvopay', externalId: 'sub_123' },
        newPlanId: 'plan_yearly',
        idempotencyKey: idempotencyKey('test-sub-00000005'),
      }),
    ).rejects.toMatchObject({ code: 'ADAPTER_ONVOPAY_NOT_IMPLEMENTED' });
  });
});
