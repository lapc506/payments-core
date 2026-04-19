// =============================================================================
// Entry point — payments-core sidecar.
// -----------------------------------------------------------------------------
// Reads env, wires a use-case container against STUB ports (real adapters
// land in issues #20/#21), starts the gRPC server on `0.0.0.0:${GRPC_PORT}`,
// and installs SIGTERM/SIGINT handlers for graceful shutdown.
//
// The stub ports return `GatewayUnavailableError` on every mutating call so
// the sidecar is honest about what v1 can do. The server is still useful:
// callers can probe it, run health checks, and observe the full proto
// contract via reflection-compatible tooling (grpcurl with a descriptor set).
// =============================================================================

import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import pino from 'pino';

import {
  GatewayUnavailableError,
  createGatewayRef,
  type AgenticPaymentPort,
  type Escrow,
  type EscrowPort,
  type FXRatePort,
  type GatewayName,
  type IdempotencyKey,
  type IdempotencyPort,
  type PaymentGatewayPort,
  type PaymentIntent,
  type Payout,
  type ReconciliationPort,
  type Subscription,
  type SubscriptionPort,
  type WebhookEvent,
  type WebhookVerifierPort,
} from './domain/index.js';
import {
  makeCancelSubscription,
  makeConfirmCheckout,
  makeCreatePayout,
  makeCreateSubscription,
  makeDisputeEscrow,
  makeGetPaymentHistory,
  makeHandleAgenticPayment,
  makeHoldEscrow,
  makeInitiateCheckout,
  makeProcessWebhook,
  makeReconcileDaily,
  makeRefundPayment,
  makeReleaseEscrow,
  makeSwitchSubscription,
  type PayoutGatewayPort,
} from './application/index.js';
import { createServer } from './adapters/inbound/grpc/server.js';
import { HealthService, ServingStatus } from './adapters/inbound/grpc/health.js';

// ---------------------------------------------------------------------------
// Env parsing — refuse to start if required values are missing or malformed.
// ---------------------------------------------------------------------------

interface Env {
  readonly grpcPort: number;
  readonly logLevel: pino.Level;
  readonly shutdownDeadlineMs: number;
}

function loadEnv(): Env {
  const portRaw = process.env['GRPC_PORT'] ?? '50051';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`GRPC_PORT must be a 1..65535 integer; got '${portRaw}'`);
  }
  const logLevel = (process.env['LOG_LEVEL'] ?? 'info') as pino.Level;
  const validLevels: readonly pino.Level[] = [
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
  ];
  if (!validLevels.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${validLevels.join(',')}; got '${logLevel}'`);
  }
  const deadlineRaw = process.env['SHUTDOWN_DEADLINE_MS'] ?? '30000';
  const deadline = Number.parseInt(deadlineRaw, 10);
  if (!Number.isFinite(deadline) || deadline <= 0) {
    throw new Error(`SHUTDOWN_DEADLINE_MS must be > 0; got '${deadlineRaw}'`);
  }
  return { grpcPort: port, logLevel, shutdownDeadlineMs: deadline };
}

// ---------------------------------------------------------------------------
// Stub port implementations
// -----------------------------------------------------------------------------
// Every stub throws `GatewayUnavailableError`; the server maps that to gRPC
// `UNAVAILABLE`, which is the correct signal to callers ("capability not
// live yet"). Stubs are identity-tagged `'stripe'` so failure messages carry
// a concrete gateway name.
// ---------------------------------------------------------------------------

const STUB_GATEWAY: GatewayName = 'stripe';
const STUB_REASON = 'stub port: real adapter pending (see issues #20/#21)';

function unavailable(): never {
  throw new GatewayUnavailableError(STUB_GATEWAY, STUB_REASON);
}

const stubPaymentGateway: PaymentGatewayPort = {
  gateway: STUB_GATEWAY,
  initiate: () => unavailable(),
  confirm: () => unavailable(),
  capture: () => unavailable(),
  refund: () => unavailable(),
};

const stubSubscriptionGateway: SubscriptionPort = {
  gateway: STUB_GATEWAY,
  create: () => unavailable(),
  switch: () => unavailable(),
  cancel: () => unavailable(),
  prorate: () => unavailable(),
};

const stubEscrowGateway: EscrowPort = {
  gateway: STUB_GATEWAY,
  hold: () => unavailable(),
  release: () => unavailable(),
  dispute: () => unavailable(),
};

const stubPayoutGateway: PayoutGatewayPort = {
  gateway: STUB_GATEWAY,
  createPayout: () => unavailable(),
};

const stubWebhookVerifier: WebhookVerifierPort = {
  gateway: STUB_GATEWAY,
  verify: () => unavailable(),
};

const stubAgentic: AgenticPaymentPort = {
  initiateAgenticPayment: () => unavailable(),
};

const stubReconciliation: ReconciliationPort = {
  gateway: STUB_GATEWAY,
  reconcileDaily: () => unavailable(),
};

const stubFx: FXRatePort = {
  lookup: () => unavailable(),
};

// ---------------------------------------------------------------------------
// In-memory stores (swap for real infra in a later change)
// ---------------------------------------------------------------------------

class InMemoryIdempotency implements IdempotencyPort {
  private readonly store = new Map<string, unknown>();
  check<T>(key: IdempotencyKey): Promise<T | null> {
    return Promise.resolve((this.store.get(key) as T | undefined) ?? null);
  }
  commit<T>(key: IdempotencyKey, result: T): Promise<void> {
    this.store.set(key, result);
    return Promise.resolve();
  }
}

class InMemoryPaymentIntentRepo {
  private readonly items = new Map<string, PaymentIntent>();
  save(intent: PaymentIntent): Promise<void> {
    this.items.set(intent.id, intent);
    return Promise.resolve();
  }
  findById(id: string): Promise<PaymentIntent | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }
}

class InMemorySubscriptionRepo {
  private readonly items = new Map<string, Subscription>();
  save(s: Subscription): Promise<void> {
    this.items.set(s.id, s);
    return Promise.resolve();
  }
  findById(id: string): Promise<Subscription | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }
}

class InMemoryEscrowRepo {
  private readonly items = new Map<string, Escrow>();
  save(e: Escrow): Promise<void> {
    this.items.set(e.id, e);
    return Promise.resolve();
  }
  findById(id: string): Promise<Escrow | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }
}

class InMemoryPayoutRepo {
  private readonly items = new Map<string, Payout>();
  save(p: Payout): Promise<void> {
    this.items.set(p.id, p);
    return Promise.resolve();
  }
  findById(id: string): Promise<Payout | null> {
    return Promise.resolve(this.items.get(id) ?? null);
  }
}

// ---------------------------------------------------------------------------
// Wire + start
// ---------------------------------------------------------------------------

function buildUseCases(): ReturnType<typeof buildUseCasesInternal> {
  return buildUseCasesInternal();
}

function buildUseCasesInternal() {
  const idempotency = new InMemoryIdempotency();
  const intentRepo = new InMemoryPaymentIntentRepo();
  const subRepo = new InMemorySubscriptionRepo();
  const escrowRepo = new InMemoryEscrowRepo();
  const payoutRepo = new InMemoryPayoutRepo();

  const paymentGateways = {
    resolvePaymentGateway: (_g: GatewayName): PaymentGatewayPort => stubPaymentGateway,
  };
  const subscriptionGateways = {
    resolveSubscriptionGateway: (_g: GatewayName): SubscriptionPort =>
      stubSubscriptionGateway,
  };
  const escrowGateways = {
    resolveEscrowGateway: (_g: GatewayName): EscrowPort => stubEscrowGateway,
  };
  const payoutGateways = {
    resolvePayoutGateway: (_g: GatewayName): PayoutGatewayPort => stubPayoutGateway,
  };
  const verifierRegistry = {
    resolveVerifier: (_g: GatewayName): WebhookVerifierPort => stubWebhookVerifier,
  };
  const reconciliationRegistry = {
    listReconciliationPorts: (): readonly ReconciliationPort[] => [stubReconciliation],
  };
  const emptyHistoryReader = {
    list: (): Promise<{ entries: readonly []; nextCursor: string }> =>
      Promise.resolve({ entries: [] as const, nextCursor: '' }),
  };
  const webhookHandler = (_e: WebhookEvent): Promise<{ handled: boolean }> =>
    Promise.resolve({ handled: false });

  return {
    initiateCheckout: makeInitiateCheckout({
      gateways: paymentGateways,
      repo: intentRepo,
      idempotency,
      fx: stubFx,
    }),
    confirmCheckout: makeConfirmCheckout({
      gateways: paymentGateways,
      repo: intentRepo,
      idempotency,
    }),
    refundPayment: makeRefundPayment({
      gateways: paymentGateways,
      repo: intentRepo,
      idempotency,
    }),
    processWebhook: makeProcessWebhook({
      verifiers: verifierRegistry,
      idempotency,
      handler: webhookHandler,
    }),
    createSubscription: makeCreateSubscription({
      gateways: subscriptionGateways,
      repo: subRepo,
      idempotency,
    }),
    switchSubscription: makeSwitchSubscription({
      gateways: subscriptionGateways,
      repo: subRepo,
      idempotency,
    }),
    cancelSubscription: makeCancelSubscription({
      gateways: subscriptionGateways,
      repo: subRepo,
      idempotency,
    }),
    holdEscrow: makeHoldEscrow({
      gateways: escrowGateways,
      repo: escrowRepo,
      idempotency,
    }),
    releaseEscrow: makeReleaseEscrow({
      gateways: escrowGateways,
      repo: escrowRepo,
      idempotency,
    }),
    disputeEscrow: makeDisputeEscrow({
      gateways: escrowGateways,
      repo: escrowRepo,
      idempotency,
    }),
    createPayout: makeCreatePayout({
      gateways: payoutGateways,
      repo: payoutRepo,
      idempotency,
    }),
    handleAgenticPayment: makeHandleAgenticPayment({
      agentic: stubAgentic,
      repo: intentRepo,
      idempotency,
    }),
    getPaymentHistory: makeGetPaymentHistory({ reader: emptyHistoryReader }),
    reconcileDaily: makeReconcileDaily({ registry: reconciliationRegistry }),
  };
}

// Tag the stub gateway for a sample `createGatewayRef` usage so the unused
// import warning stays quiet and future maintainers see the shape.
void createGatewayRef;

export async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: env.logLevel });
  const useCases = buildUseCases();
  const health = new HealthService(ServingStatus.NOT_SERVING);

  const { server } = createServer({
    useCases,
    health,
    ids: {
      newIntentId: () => `pi_${randomUUID()}`,
      newSubscriptionId: () => `sub_${randomUUID()}`,
      newEscrowId: () => `esc_${randomUUID()}`,
      newPayoutId: () => `po_${randomUUID()}`,
    },
  });

  const bindAddr = `0.0.0.0:${env.grpcPort}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      bindAddr,
      grpc.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err !== null) {
          reject(err);
          return;
        }
        logger.info({ port }, 'payments-core gRPC server listening');
        resolve();
      },
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'received shutdown signal, draining');
    health.setServingStatus(ServingStatus.NOT_SERVING);
    const force = setTimeout(() => {
      logger.warn({ signal }, 'shutdown deadline elapsed, forcing');
      server.forceShutdown();
      process.exit(1);
    }, env.shutdownDeadlineMs);
    force.unref();
    server.tryShutdown((err) => {
      if (err !== undefined && err !== null) {
        logger.error({ err: err.message }, 'tryShutdown reported error');
      }
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only call `main()` when invoked as a script, not when imported by tests.
// `process.argv[1]` ends with `main.js` when the built artifact is run
// directly; tests import this module without triggering the call.
const entry = process.argv[1] ?? '';
if (entry.endsWith('main.js') || entry.endsWith('main.ts')) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`fatal: ${message}`);
    process.exit(1);
  });
}
