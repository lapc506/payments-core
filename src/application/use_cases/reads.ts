// =============================================================================
// Read-only use cases — 2 of 14 (proto RPCs: GetPaymentHistory,
// ReconcileDaily).
// -----------------------------------------------------------------------------
// Neither use case mutates state, so neither consults `IdempotencyPort`.
// Reads are allowed to run freely; their results are never idempotent-keyed
// because replays with different paging cursors or different dates are
// legitimately different queries.
// =============================================================================

import {
  DomainError,
  err,
  ok,
  type GatewayName,
  type Money,
  type PaymentIntentStatus,
  type ReconciliationDiff,
  type ReconciliationPort,
  type Result,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Ports local to the application layer
// ---------------------------------------------------------------------------

/**
 * Flattened read model for the proto `GetPaymentHistory` RPC. A dedicated
 * read port keeps the history query out of `PaymentIntentRepositoryPort`
 * (which is optimized for by-id lookup + save). Mitigates the N+1 risk
 * flagged in `design.md`.
 */
export interface PaymentHistoryEntry {
  readonly intentId: string;
  readonly consumer: string;
  readonly customerReference: string;
  readonly amount: Money;
  readonly status: PaymentIntentStatus;
  readonly gateway: GatewayName | null;
  readonly createdAt: Date;
}

export interface PaymentHistoryReaderPort {
  list(input: PaymentHistoryQuery): Promise<PaymentHistoryPage>;
}

export interface PaymentHistoryQuery {
  readonly consumer: string;
  readonly customerReference?: string;
  readonly limit: number;
  /** Opaque pagination cursor. Empty string = start from the top. */
  readonly cursor: string;
}

export interface PaymentHistoryPage {
  readonly entries: readonly PaymentHistoryEntry[];
  /** Empty string when there is no next page. */
  readonly nextCursor: string;
}

// =============================================================================
// 13. GetPaymentHistory
// =============================================================================

export interface GetPaymentHistoryInput {
  readonly consumer: string;
  readonly customerReference?: string;
  readonly limit: number;
  readonly cursor: string;
}

export interface GetPaymentHistoryOutput {
  readonly entries: readonly PaymentHistoryEntry[];
  readonly nextCursor: string;
}

export interface GetPaymentHistoryDeps {
  readonly reader: PaymentHistoryReaderPort;
}

export const makeGetPaymentHistory =
  (deps: GetPaymentHistoryDeps) =>
  async (
    input: GetPaymentHistoryInput,
  ): Promise<Result<GetPaymentHistoryOutput, DomainError>> => {
    if (input.limit <= 0 || input.limit > 1000) {
      return err(
        new DomainError(
          'APPLICATION_INVALID_PAGE_SIZE',
          `limit must be between 1 and 1000; got ${input.limit}`,
        ),
      );
    }

    let page: PaymentHistoryPage;
    try {
      page = await deps.reader.list({
        consumer: input.consumer,
        ...(input.customerReference !== undefined
          ? { customerReference: input.customerReference }
          : {}),
        limit: input.limit,
        cursor: input.cursor,
      });
    } catch (e) {
      return wrapError(e);
    }

    return ok({ entries: page.entries, nextCursor: page.nextCursor });
  };

// =============================================================================
// 14. ReconcileDaily
// =============================================================================

/**
 * Registry that exposes active gateways that can reconcile. The registry
 * itself is wired in the inbound adapter — the application layer accepts
 * whatever gateways it is handed.
 */
export interface ReconciliationRegistryPort {
  listReconciliationPorts(): readonly ReconciliationPort[];
}

export interface ReconcileDailyInput {
  /** UTC calendar day, formatted YYYY-MM-DD. */
  readonly date: string;
  /** Optional filter. Omit to reconcile every active gateway. */
  readonly gateways?: readonly GatewayName[];
}

export interface ReconcileDailyGatewayResult {
  readonly gateway: GatewayName;
  readonly matchedCount: number;
  readonly diffs: readonly ReconciliationDiff[];
}

export interface ReconcileDailyOutput {
  readonly date: string;
  readonly results: readonly ReconcileDailyGatewayResult[];
}

export interface ReconcileDailyDeps {
  readonly registry: ReconciliationRegistryPort;
}

export const makeReconcileDaily =
  (deps: ReconcileDailyDeps) =>
  async (
    input: ReconcileDailyInput,
  ): Promise<Result<ReconcileDailyOutput, DomainError>> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      return err(
        new DomainError(
          'APPLICATION_INVALID_DATE',
          `date must be YYYY-MM-DD; got '${input.date}'`,
        ),
      );
    }

    const ports = deps.registry.listReconciliationPorts();
    const filtered =
      input.gateways === undefined
        ? ports
        : ports.filter((p) => input.gateways?.includes(p.gateway));

    const results: ReconcileDailyGatewayResult[] = [];
    for (const port of filtered) {
      try {
        const result = await port.reconcileDaily({ date: input.date });
        results.push({
          gateway: port.gateway,
          matchedCount: result.matchedCount,
          diffs: result.diffs,
        });
      } catch (e) {
        return wrapError(e);
      }
    }

    return ok({ date: input.date, results });
  };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function wrapError<T>(e: unknown): Result<T, DomainError> {
  if (e instanceof DomainError) return err(e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(new DomainError('APPLICATION_UNEXPECTED', msg));
}
