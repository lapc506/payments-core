// =============================================================================
// Stripe WebhookVerifierPort implementation.
// -----------------------------------------------------------------------------
// Verifies Stripe-signed webhook payloads and translates them into the
// domain's `WebhookEvent` shape.
//
// Two orthogonal safety layers:
//
//   1. Signature check — delegated to the Stripe SDK's
//      `webhooks.constructEvent` which hashes the raw body against the
//      signing secret and rejects mismatches with
//      `StripeSignatureVerificationError`. We never JSON-parse the body
//      before that call; `payload` is the raw bytes carried verbatim from
//      the inbound gRPC adapter's `ProcessWebhookRequest.raw_body`.
//
//   2. Idempotency — Stripe events carry a stable `evt_*` id that is stable
//      across retries. We re-use the application-layer `IdempotencyPort` as
//      a `WebhookEventRepositoryPort` shortcut: before returning a verified
//      event, we check whether `evt_*` has been seen (`check(evt_id)`) and
//      throw `StripeGatewayError('GATEWAY_WEBHOOK_DUPLICATE', ...)` if so.
//      The application layer's `ProcessWebhook` use case ALSO checks the
//      event id as its second idempotency gate — this adapter-level check
//      is the belt to the application layer's suspenders so a deployment
//      that somehow skips the use case still rejects duplicates. Follow-up
//      work will introduce a dedicated `WebhookEventRepositoryPort`; see
//      the adapter doc for the migration note.
// =============================================================================

import type {
  GatewayName,
  IdempotencyKey,
  IdempotencyPort,
  VerifyWebhookInput,
  WebhookEvent,
  WebhookVerifierPort,
} from '../../../../domain/index.js';
import type { StripeClient, StripeEvent } from './client.js';
import { StripeGatewayError, WebhookSignatureError, mapStripeError } from './errors.js';

export interface StripeWebhookVerifierDeps {
  readonly client: StripeClient;
  /** `whsec_*` endpoint secret from the Stripe dashboard. */
  readonly signingSecret: string;
  /**
   * Shortcut storage for duplicate-event detection. The application layer
   * already has an IdempotencyPort in scope; we reuse it. A follow-up change
   * introduces `WebhookEventRepositoryPort` and migrates this dependency.
   */
  readonly idempotency: IdempotencyPort;
  /**
   * Allowed skew between the Stripe-signed timestamp and `receivedAt`, in
   * seconds. Passed through to `constructEvent`'s tolerance argument.
   * Defaults to 300 (5 minutes) — Stripe's SDK default.
   */
  readonly tolerance?: number;
}

interface StoredEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
}

export class StripeWebhookVerifier implements WebhookVerifierPort {
  readonly gateway: GatewayName = 'stripe';

  constructor(private readonly deps: StripeWebhookVerifierDeps) {}

  async verify(input: VerifyWebhookInput): Promise<WebhookEvent> {
    const rawBody = Buffer.from(
      input.payload.buffer,
      input.payload.byteOffset,
      input.payload.byteLength,
    );

    let event: StripeEvent;
    try {
      event = this.deps.client.webhooks.constructEvent(
        rawBody,
        input.signature,
        this.deps.signingSecret,
        this.deps.tolerance,
      );
    } catch (err) {
      // `StripeSignatureVerificationError` comes through `mapStripeError`
      // as `WebhookSignatureError` already; re-raise any other surface for
      // the error mapper to handle.
      const mapped = mapStripeError(err);
      if (mapped instanceof WebhookSignatureError) throw mapped;
      throw mapped;
    }

    // Duplicate-event idempotency. We key on `evt_*` which Stripe guarantees
    // is stable across redeliveries of the same event.
    const eventKey = event.id as IdempotencyKey;
    const previous = await this.deps.idempotency.check<StoredEvent>(eventKey);
    if (previous !== null) {
      throw new StripeGatewayError(
        'GATEWAY_INVALID_REQUEST',
        `Stripe webhook event ${event.id} has already been processed.`,
      );
    }
    const stored: StoredEvent = {
      eventId: event.id,
      eventType: event.type,
      occurredAt: new Date(event.created * 1000).toISOString(),
    };
    await this.deps.idempotency.commit(eventKey, stored);

    return {
      gateway: this.gateway,
      eventId: event.id,
      eventType: event.type,
      payload: input.payload,
      occurredAt: new Date(event.created * 1000),
    };
  }
}
