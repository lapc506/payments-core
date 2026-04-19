// =============================================================================
// Miscellaneous handlers — Payout, Webhook, Agentic, Reads (5 RPCs).
// -----------------------------------------------------------------------------
// Grouped here rather than in a dedicated file per RPC to honor the 15-file
// cap at the adapter boundary. Each section is ≤ 50 lines of plumbing; a
// dedicated file would be pure ceremony.
//
// Reads (GetPaymentHistory, ReconcileDaily) do not need an idempotency key
// because the application layer skips the idempotency port for read paths.
// =============================================================================

import type * as grpc from '@grpc/grpc-js';

import {
  createIdempotencyKey,
  type DomainError,
  type GatewayName,
  type IdempotencyKey,
  type Result,
} from '../../../../domain/index.js';
import {
  type CreatePayoutInput,
  type CreatePayoutOutput,
  type GetPaymentHistoryInput,
  type GetPaymentHistoryOutput,
  type HandleAgenticPaymentInput,
  type HandleAgenticPaymentOutput,
  type ProcessWebhookInput,
  type ProcessWebhookOutput,
  type ReconcileDailyInput,
  type ReconcileDailyOutput,
  type makeCreatePayout,
  type makeGetPaymentHistory,
  type makeHandleAgenticPayment,
  type makeProcessWebhook,
  type makeReconcileDaily,
} from '../../../../application/index.js';
import {
  CreatePayoutRequest,
  CreatePayoutResponse,
  GetPaymentHistoryRequest,
  GetPaymentHistoryResponse,
  InitiateAgenticPaymentRequest,
  InitiateAgenticPaymentResponse,
  ProcessWebhookRequest,
  ProcessWebhookResponse,
  ReconcileDailyRequest,
  ReconcileDailyResponse,
} from '../../../../generated/lapc506/payments_core/v1/payments_core.js';
import { invalidArgument, toGrpcError } from '../errors.js';
import { domainMoneyToProto, protoMoneyToDomainRequired } from '../mappers/money.js';
import {
  domainGatewayToProto,
  domainPaymentStatusToProto,
  domainPayoutStatusToProto,
  protoDateToDomain,
  protoGatewayToDomain,
  resolveGatewayPreference,
} from '../mappers/entities.js';

function buildIdempotencyKey(
  raw: string,
): { ok: true; value: IdempotencyKey } | { ok: false; details: string } {
  const r = createIdempotencyKey(raw);
  return r.ok
    ? { ok: true, value: r.value }
    : { ok: false, details: r.error.message };
}

// ---------------------------------------------------------------------------
// CreatePayout
// ---------------------------------------------------------------------------

export type CreatePayoutExecutor = ReturnType<typeof makeCreatePayout>;

export function makeCreatePayoutHandler(
  execute: CreatePayoutExecutor,
  payoutIdGenerator: () => string,
): grpc.handleUnaryCall<CreatePayoutRequest, CreatePayoutResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }
      const money = protoMoneyToDomainRequired(call.request.amount, 'amount');
      if (!money.ok) {
        callback(invalidArgument(money.error.message), null);
        return;
      }

      const input: CreatePayoutInput = {
        id: payoutIdGenerator(),
        consumer: call.request.consumer,
        beneficiaryReference: call.request.beneficiaryReference,
        amount: money.value,
        gateway: resolveGatewayPreference(call.request.gateway),
        idempotencyKey: key.value,
        metadata: call.request.metadata,
        ...(call.request.description ? { description: call.request.description } : {}),
      };

      const result: Result<CreatePayoutOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const { payout } = result.value;
      const chosenGateway =
        payout.gatewayRef !== null
          ? domainGatewayToProto(payout.gatewayRef.gateway)
          : domainGatewayToProto(input.gateway);

      const response: CreatePayoutResponse = {
        payoutId: payout.id,
        status: domainPayoutStatusToProto(payout.status),
        chosenGateway,
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// ProcessWebhook
// ---------------------------------------------------------------------------

export type ProcessWebhookExecutor = ReturnType<typeof makeProcessWebhook>;

export function makeProcessWebhookHandler(
  execute: ProcessWebhookExecutor,
): grpc.handleUnaryCall<ProcessWebhookRequest, ProcessWebhookResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }
      const gateway = protoGatewayToDomain(call.request.gateway);
      if (gateway === null) {
        callback(invalidArgument('gateway is required'), null);
        return;
      }

      const input: ProcessWebhookInput = {
        gateway,
        signature: call.request.signature,
        payload: call.request.payload,
        receivedAt: protoDateToDomain(call.request.receivedAt),
        idempotencyKey: key.value,
      };

      const result: Result<ProcessWebhookOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: ProcessWebhookResponse = {
        eventId: result.value.eventId,
        accepted: result.value.result.handled,
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// InitiateAgenticPayment
// ---------------------------------------------------------------------------

export type HandleAgenticPaymentExecutor = ReturnType<typeof makeHandleAgenticPayment>;

export function makeInitiateAgenticPaymentHandler(
  execute: HandleAgenticPaymentExecutor,
  intentIdGenerator: () => string,
): grpc.handleUnaryCall<InitiateAgenticPaymentRequest, InitiateAgenticPaymentResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }
      const money = protoMoneyToDomainRequired(call.request.amount, 'amount');
      if (!money.ok) {
        callback(invalidArgument(money.error.message), null);
        return;
      }

      const input: HandleAgenticPaymentInput = {
        id: intentIdGenerator(),
        consumer: call.request.consumer,
        agentId: call.request.agentId,
        toolCallId: call.request.toolCallId,
        auditJwt: call.request.auditJwt,
        customerReference: call.request.customerReference,
        amount: money.value,
        idempotencyKey: key.value,
        metadata: call.request.metadata,
        ...(call.request.description ? { description: call.request.description } : {}),
      };

      const result: Result<HandleAgenticPaymentOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const { intent } = result.value;
      const chosenGateway =
        intent.gatewayRef !== null
          ? domainGatewayToProto(intent.gatewayRef.gateway)
          : domainGatewayToProto(resolveGatewayPreference(call.request.gateway));

      const response: InitiateAgenticPaymentResponse = {
        intentId: intent.id,
        status: domainPaymentStatusToProto(intent.status),
        chosenGateway,
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// GetPaymentHistory
// ---------------------------------------------------------------------------

export type GetPaymentHistoryExecutor = ReturnType<typeof makeGetPaymentHistory>;

export function makeGetPaymentHistoryHandler(
  execute: GetPaymentHistoryExecutor,
): grpc.handleUnaryCall<GetPaymentHistoryRequest, GetPaymentHistoryResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const pageSize =
        call.request.pageSize > 0 ? Math.min(call.request.pageSize, 500) : 50;

      const input: GetPaymentHistoryInput = {
        consumer: call.request.consumer,
        limit: pageSize,
        cursor: call.request.pageToken,
        ...(call.request.customerReference
          ? { customerReference: call.request.customerReference }
          : {}),
      };

      const result: Result<GetPaymentHistoryOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: GetPaymentHistoryResponse = {
        items: result.value.entries.map((e) => ({
          intentId: e.intentId,
          status: domainPaymentStatusToProto(e.status),
          amount: domainMoneyToProto(e.amount),
          gateway:
            e.gateway !== null
              ? domainGatewayToProto(e.gateway)
              : domainGatewayToProto('stripe'),
          createdAt: e.createdAt,
          metadata: {},
        })),
        nextPageToken: result.value.nextCursor,
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// ReconcileDaily
// ---------------------------------------------------------------------------

export type ReconcileDailyExecutor = ReturnType<typeof makeReconcileDaily>;

export function makeReconcileDailyHandler(
  execute: ReconcileDailyExecutor,
): grpc.handleUnaryCall<ReconcileDailyRequest, ReconcileDailyResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const gatewayName = protoGatewayToDomain(call.request.gateway);
      const gateways: readonly GatewayName[] | undefined =
        gatewayName === null ? undefined : [gatewayName];

      const input: ReconcileDailyInput = {
        date: call.request.date,
        ...(gateways !== undefined ? { gateways } : {}),
      };

      const result: Result<ReconcileDailyOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      // The proto response is flat (one matched_count, one diffs list). We
      // aggregate across per-gateway results — the proto v1 shape does not
      // carry gateway-scoped buckets yet.
      const matchedCount = result.value.results.reduce(
        (sum, g) => sum + g.matchedCount,
        0,
      );
      const diffs = result.value.results.flatMap((g) =>
        g.diffs.map((d) => ({
          intentId: d.intentId ?? '',
          kind: d.kind,
          description: d.description,
          ...(d.expected !== null ? { expected: domainMoneyToProto(d.expected) } : {}),
          ...(d.actual !== null ? { actual: domainMoneyToProto(d.actual) } : {}),
        })),
      );

      const response: ReconcileDailyResponse = {
        date: result.value.date,
        matchedCount,
        diffs,
      };
      callback(null, response);
    })();
  };
}
