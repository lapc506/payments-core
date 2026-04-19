// =============================================================================
// Escrow handlers — Hold, Release, Dispute.
// -----------------------------------------------------------------------------
// Thin orchestrators around the three escrow use cases.
//
// Milestone-condition, platform fee, and platform-fee destination come in on
// metadata-channel keys in v1 of the proto (the RPC contract does not have
// dedicated fields yet; see `aduanext-integration-needs` for the v2 shape).
// =============================================================================

import type * as grpc from '@grpc/grpc-js';

import {
  createIdempotencyKey,
  type DomainError,
  type IdempotencyKey,
  type MilestoneCondition,
  type Money,
  type Result,
} from '../../../../domain/index.js';
import {
  type DisputeEscrowInput,
  type DisputeEscrowOutput,
  type HoldEscrowInput,
  type HoldEscrowOutput,
  type ReleaseEscrowInput,
  type ReleaseEscrowOutput,
  type makeDisputeEscrow,
  type makeHoldEscrow,
  type makeReleaseEscrow,
} from '../../../../application/index.js';
import {
  DisputeEscrowRequest,
  DisputeEscrowResponse,
  HoldEscrowRequest,
  HoldEscrowResponse,
  ReleaseEscrowRequest,
  ReleaseEscrowResponse,
} from '../../../../generated/lapc506/payments_core/v1/payments_core.js';
import { invalidArgument, toGrpcError } from '../errors.js';
import { protoMoneyToDomainRequired } from '../mappers/money.js';
import {
  domainEscrowStatusToProto,
  domainGatewayToProto,
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

/**
 * v1 of the proto does not carry dedicated fields for milestone condition,
 * platform fee, or fee destination. Callers encode them in the metadata map
 * under the AduaNext-mandated keys. A v2 proto change will promote these to
 * dedicated fields; until then, this is the contract.
 */
function extractAduaNextFields(metadata: { [key: string]: string }): {
  milestoneCondition?: MilestoneCondition;
  platformFeeMinor?: bigint;
  platformFeeDestination?: string;
} {
  const out: {
    milestoneCondition?: MilestoneCondition;
    platformFeeMinor?: bigint;
    platformFeeDestination?: string;
  } = {};

  const milestones = metadata['escrow_milestones'];
  const split = metadata['escrow_release_split'];
  if (milestones !== undefined && split !== undefined) {
    const milestoneArr = milestones.split(',').filter((s) => s.length > 0);
    const splitArr = split
      .split(',')
      .map((s) => Number.parseFloat(s.trim()))
      .filter((n) => !Number.isNaN(n));
    if (milestoneArr.length > 0 && milestoneArr.length === splitArr.length) {
      out.milestoneCondition = { milestones: milestoneArr, releaseSplit: splitArr };
    }
  }
  const feeRaw = metadata['platform_fee_minor'];
  if (feeRaw !== undefined) {
    try {
      out.platformFeeMinor = BigInt(feeRaw);
    } catch {
      // fall through; handler's money validation catches other issues
    }
  }
  const feeDest = metadata['platform_fee_destination'];
  if (feeDest !== undefined && feeDest.length > 0) {
    out.platformFeeDestination = feeDest;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HoldEscrow
// ---------------------------------------------------------------------------

export type HoldEscrowExecutor = ReturnType<typeof makeHoldEscrow>;

export function makeHoldEscrowHandler(
  execute: HoldEscrowExecutor,
  escrowIdGenerator: () => string,
): grpc.handleUnaryCall<HoldEscrowRequest, HoldEscrowResponse> {
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

      const aduanext = extractAduaNextFields(call.request.metadata);
      const input: HoldEscrowInput = {
        id: escrowIdGenerator(),
        consumer: call.request.consumer,
        payerReference: call.request.payerReference,
        payeeReference: call.request.payeeReference,
        amount: money.value,
        gateway: resolveGatewayPreference(call.request.gateway),
        idempotencyKey: key.value,
        metadata: call.request.metadata,
        ...(aduanext.milestoneCondition !== undefined
          ? { milestoneCondition: aduanext.milestoneCondition }
          : {}),
        ...(aduanext.platformFeeMinor !== undefined
          ? { platformFeeMinor: aduanext.platformFeeMinor }
          : {}),
        ...(aduanext.platformFeeDestination !== undefined
          ? { platformFeeDestination: aduanext.platformFeeDestination }
          : {}),
        ...(call.request.releaseAfter !== undefined
          ? { releaseAfter: call.request.releaseAfter }
          : {}),
      };

      const result: Result<HoldEscrowOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const { escrow } = result.value;
      const chosenGateway =
        escrow.gatewayRef !== null
          ? domainGatewayToProto(escrow.gatewayRef.gateway)
          : domainGatewayToProto(input.gateway);

      const response: HoldEscrowResponse = {
        escrowId: escrow.id,
        status: domainEscrowStatusToProto(escrow.status),
        chosenGateway,
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// ReleaseEscrow
// ---------------------------------------------------------------------------

export type ReleaseEscrowExecutor = ReturnType<typeof makeReleaseEscrow>;

export function makeReleaseEscrowHandler(
  execute: ReleaseEscrowExecutor,
): grpc.handleUnaryCall<ReleaseEscrowRequest, ReleaseEscrowResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }

      let amount: Money | undefined;
      if (call.request.amount !== undefined) {
        const money = protoMoneyToDomainRequired(call.request.amount, 'amount');
        if (!money.ok) {
          callback(invalidArgument(money.error.message), null);
          return;
        }
        amount = money.value;
      }

      const input: ReleaseEscrowInput = {
        escrowId: call.request.escrowId,
        idempotencyKey: key.value,
        ...(amount !== undefined ? { amount } : {}),
      };

      const result: Result<ReleaseEscrowOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: ReleaseEscrowResponse = {
        escrowId: result.value.escrow.id,
        status: domainEscrowStatusToProto(result.value.escrow.status),
      };
      callback(null, response);
    })();
  };
}

// ---------------------------------------------------------------------------
// DisputeEscrow
// ---------------------------------------------------------------------------

export type DisputeEscrowExecutor = ReturnType<typeof makeDisputeEscrow>;

export function makeDisputeEscrowHandler(
  execute: DisputeEscrowExecutor,
): grpc.handleUnaryCall<DisputeEscrowRequest, DisputeEscrowResponse> {
  return (call, callback) => {
    void (async (): Promise<void> => {
      const key = buildIdempotencyKey(call.request.idempotencyKey);
      if (!key.ok) {
        callback(invalidArgument(key.details), null);
        return;
      }

      const input: DisputeEscrowInput = {
        escrowId: call.request.escrowId,
        reason: call.request.reason,
        evidence: call.request.evidence,
        idempotencyKey: key.value,
      };

      const result: Result<DisputeEscrowOutput, DomainError> = await execute(input);
      if (!result.ok) {
        callback(toGrpcError(result.error), null);
        return;
      }

      const response: DisputeEscrowResponse = {
        escrowId: result.value.escrow.id,
        disputeId: result.value.disputeId,
        status: domainEscrowStatusToProto(result.value.escrow.status),
      };
      callback(null, response);
    })();
  };
}
