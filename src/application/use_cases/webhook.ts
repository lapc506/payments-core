// =============================================================================
// Webhook use case — 1 of 14 (proto RPC: ProcessWebhook).
// -----------------------------------------------------------------------------
// Verifies a gateway-signed webhook via `WebhookVerifierPort`, checks
// idempotency on `event.eventId`, and dispatches the decoded `WebhookEvent`
// to a caller-provided handler. The handler closes the loop with whatever
// downstream action the event type implies (e.g. advancing a PaymentIntent,
// recording a refund, flagging a dispute).
//
// Gateway-specific event-type → handler mapping intentionally lives outside
// this use case — the application layer cannot know Stripe's
// `charge.succeeded` vs OnvoPay's `payment.captured` naming. The inbound
// adapter wires a dispatch table per gateway and passes it in as `handler`.
// =============================================================================

import {
  DomainError,
  err,
  ok,
  type GatewayName,
  type IdempotencyKey,
  type IdempotencyPort,
  type Result,
  type WebhookEvent,
  type WebhookVerifierPort,
} from '../../domain/index.js';

// ---------------------------------------------------------------------------
// Ports local to the application layer
// ---------------------------------------------------------------------------

export interface WebhookVerifierRegistryPort {
  resolveVerifier(gateway: GatewayName): WebhookVerifierPort;
}

/**
 * Caller-supplied dispatch function. Returns an opaque summary (e.g. which
 * inner use case fired) that we stash in the idempotency record so replays
 * return the same shape. `unknown` is acceptable because the caller defines
 * the shape and this use case never introspects it.
 */
export type WebhookHandler = (event: WebhookEvent) => Promise<WebhookHandlerResult>;

export interface WebhookHandlerResult {
  readonly handled: boolean;
  readonly dispatchedTo?: string;
}

// =============================================================================
// 11. ProcessWebhook
// =============================================================================

export interface ProcessWebhookInput {
  readonly gateway: GatewayName;
  readonly signature: string;
  readonly payload: Uint8Array;
  readonly receivedAt: Date;
  readonly idempotencyKey: IdempotencyKey;
}

export interface ProcessWebhookOutput {
  readonly eventId: string;
  readonly eventType: string;
  readonly result: WebhookHandlerResult;
}

export interface ProcessWebhookDeps {
  readonly verifiers: WebhookVerifierRegistryPort;
  readonly idempotency: IdempotencyPort;
  readonly handler: WebhookHandler;
}

/**
 * Verify + dispatch a webhook. The idempotency check runs on the
 * `eventId` returned by the verifier so duplicate deliveries (standard
 * retry pattern at every gateway) are absorbed without invoking the
 * handler a second time.
 */
export const makeProcessWebhook =
  (deps: ProcessWebhookDeps) =>
  async (
    input: ProcessWebhookInput,
  ): Promise<Result<ProcessWebhookOutput, DomainError>> => {
    const cached = await deps.idempotency.check<ProcessWebhookOutput>(
      input.idempotencyKey,
    );
    if (cached !== null) return ok(cached);

    const verifier = deps.verifiers.resolveVerifier(input.gateway);

    let event: WebhookEvent;
    try {
      event = await verifier.verify({
        signature: input.signature,
        payload: input.payload,
        receivedAt: input.receivedAt,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (e) {
      return wrapError(e);
    }

    // The `eventId` is the gateway's own event identifier — stable across
    // retries of the same delivery. Check again under the event id so two
    // different webhook endpoints don't both process the same delivery.
    const byEventId = await deps.idempotency.check<ProcessWebhookOutput>(
      event.eventId as IdempotencyKey,
    );
    if (byEventId !== null) {
      await deps.idempotency.commit(input.idempotencyKey, byEventId);
      return ok(byEventId);
    }

    let handlerResult: WebhookHandlerResult;
    try {
      handlerResult = await deps.handler(event);
    } catch (e) {
      return wrapError(e);
    }

    const out: ProcessWebhookOutput = {
      eventId: event.eventId,
      eventType: event.eventType,
      result: handlerResult,
    };
    await deps.idempotency.commit(event.eventId as IdempotencyKey, out);
    await deps.idempotency.commit(input.idempotencyKey, out);
    return ok(out);
  };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function wrapError<T>(e: unknown): Result<T, DomainError> {
  if (e instanceof DomainError) return err(e);
  const msg = e instanceof Error ? e.message : String(e);
  return err(new DomainError('APPLICATION_UNEXPECTED', msg));
}
