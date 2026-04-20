// =============================================================================
// Entry point — payments-core sidecar.
// -----------------------------------------------------------------------------
// Reads env, wires a use-case container against real outbound adapters where
// env-provided credentials allow (`stripe`, `onvopay` for payments,
// subscriptions, and webhook verification) and falls back to `UNAVAILABLE`
// stubs for every other gateway or port that lacks a real implementation
// (`EscrowPort`, `PayoutPort`, `AgenticPaymentPort`, `ReconciliationPort`,
// `FXRatePort`). Starts the gRPC server on `0.0.0.0:${GRPC_PORT}` and
// installs SIGTERM/SIGINT handlers for graceful shutdown.
//
// Missing adapter env vars are NOT fatal. The sidecar boots with a minimal
// set; requests for an unconfigured gateway surface
// `GatewayUnavailableError(gateway, 'not configured')` and translate to
// gRPC `UNAVAILABLE`. Local dev environments without real secrets keep
// working exactly as before.
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
import {
  type AdapterEnv,
  buildPaymentGatewayRegistry,
  buildSubscriptionPortRegistry,
  buildWebhookVerifierRegistry,
  makeResolver,
} from './main/gateway-registry.js';

// ---------------------------------------------------------------------------
// Env parsing — refuse to start if required values are missing or malformed.
// ---------------------------------------------------------------------------

interface Env {
  readonly grpcPort: number;
  readonly logLevel: pino.Level;
  readonly shutdownDeadlineMs: number;
  readonly adapters: AdapterEnv;
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
  // Adapter env vars are optional at the process level. Unset values mean
  // the corresponding gateway will not be registered; requests for it return
  // `UNAVAILABLE` until secrets are provided.
  const adapters: AdapterEnv = {
    ...(process.env['STRIPE_SECRET_KEY'] !== undefined
      ? { stripeSecretKey: process.env['STRIPE_SECRET_KEY'] }
      : {}),
    ...(process.env['STRIPE_WEBHOOK_SIGNING_SECRET'] !== undefined
      ? { stripeWebhookSigningSecret: process.env['STRIPE_WEBHOOK_SIGNING_SECRET'] }
      : {}),
    ...(process.env['ONVOPAY_API_KEY'] !== undefined
      ? { onvopayApiKey: process.env['ONVOPAY_API_KEY'] }
      : {}),
    ...(process.env['ONVOPAY_API_BASE_URL'] !== undefined
      ? { onvopayApiBaseUrl: process.env['ONVOPAY_API_BASE_URL'] }
      : {}),
    ...(process.env['ONVOPAY_WEBHOOK_SIGNING_SECRET'] !== undefined
      ? {
          onvopayWebhookSigningSecret:
            process.env['ONVOPAY_WEBHOOK_SIGNING_SECRET'],
        }
      : {}),
  };
  return {
    grpcPort: port,
    logLevel,
    shutdownDeadlineMs: deadline,
    adapters,
  };
}

// ---------------------------------------------------------------------------
// Stub port implementations
// -----------------------------------------------------------------------------
// Retained only for ports that do NOT have a real outbound adapter yet
// (`EscrowPort`, `PayoutPort`, `AgenticPaymentPort`, `ReconciliationPort`,
// `FXRatePort`). Each throws `GatewayUnavailableError`, which the inbound
// gRPC translator maps to `UNAVAILABLE`. Ports that DO have adapters
// (`PaymentGatewayPort`, `SubscriptionPort`, `WebhookVerifierPort`) are
// served by the registry; their per-gateway stub, used when the requested
// gateway has no env credentials, lives in `buildUseCasesInternal`.
// ---------------------------------------------------------------------------

const STUB_GATEWAY: GatewayName = 'stripe';
const STUB_REASON = 'stub port: real adapter pending';

function unavailable(): never {
  throw new GatewayUnavailableError(STUB_GATEWAY, STUB_REASON);
}

function unavailableFor(gateway: GatewayName): never {
  throw new GatewayUnavailableError(gateway, 'not configured');
}

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

// Per-gateway stubs for the three wired ports. Only constructed when a
// caller asks for a gateway that hasn't been registered; the stub carries
// the requested gateway name so the error message is accurate.
function stubPaymentGatewayFor(gateway: GatewayName): PaymentGatewayPort {
  return {
    gateway,
    initiate: () => unavailableFor(gateway),
    confirm: () => unavailableFor(gateway),
    capture: () => unavailableFor(gateway),
    refund: () => unavailableFor(gateway),
  };
}

function stubSubscriptionPortFor(gateway: GatewayName): SubscriptionPort {
  return {
    gateway,
    create: () => unavailableFor(gateway),
    switch: () => unavailableFor(gateway),
    cancel: () => unavailableFor(gateway),
    prorate: () => unavailableFor(gateway),
  };
}

function stubWebhookVerifierFor(gateway: GatewayName): WebhookVerifierPort {
  return {
    gateway,
    verify: () => unavailableFor(gateway),
  };
}

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

export function buildUseCases(
  env: AdapterEnv,
): ReturnType<typeof buildUseCasesInternal> {
  return buildUseCasesInternal(env);
}

function buildUseCasesInternal(env: AdapterEnv) {
  const idempotency = new InMemoryIdempotency();
  const intentRepo = new InMemoryPaymentIntentRepo();
  const subRepo = new InMemorySubscriptionRepo();
  const escrowRepo = new InMemoryEscrowRepo();
  const payoutRepo = new InMemoryPayoutRepo();

  // Real adapters constructed from env; unconfigured gateways fall through
  // to per-gateway stubs that return `UNAVAILABLE` on every call.
  const paymentRegistry = buildPaymentGatewayRegistry(env);
  const subscriptionRegistry = buildSubscriptionPortRegistry(env);
  const webhookVerifierRegistry = buildWebhookVerifierRegistry(env, idempotency);

  const resolvePayment = makeResolver(paymentRegistry, stubPaymentGatewayFor);
  const resolveSubscription = makeResolver(
    subscriptionRegistry,
    stubSubscriptionPortFor,
  );
  const resolveVerifier = makeResolver(
    webhookVerifierRegistry,
    stubWebhookVerifierFor,
  );

  const paymentGateways = {
    resolvePaymentGateway: resolvePayment,
  };
  const subscriptionGateways = {
    resolveSubscriptionGateway: resolveSubscription,
  };
  const escrowGateways = {
    resolveEscrowGateway: (_g: GatewayName): EscrowPort => stubEscrowGateway,
  };
  const payoutGateways = {
    resolvePayoutGateway: (_g: GatewayName): PayoutGatewayPort => stubPayoutGateway,
  };
  const verifierRegistry = {
    resolveVerifier,
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
  const useCases = buildUseCases(env.adapters);
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
