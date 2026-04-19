// =============================================================================
// OnvoPay WebhookVerifierPort implementation
// -----------------------------------------------------------------------------
// Verifies OnvoPay-signed webhooks using HMAC-SHA256 over the raw request
// body. Verification MUST run before any JSON parsing — the signature is
// computed over the exact bytes the gateway signed, so even whitespace
// differences break the hash.
//
// Signature scheme assumption (TODO: verify against
// https://docs.onvopay.com/ webhook section):
//   - Algorithm: HMAC-SHA256
//   - Signing secret: `ONVOPAY_WEBHOOK_SIGNING_SECRET`
//   - Header: a single hex digest (may include a `timestamp=` pair; the
//     common industry shape is `t=<unix>,v1=<hex>`, matching Stripe's
//     convention)
//
// If OnvoPay uses a JWT-based scheme instead (rare for webhooks), rewrite
// this file to verify the JWT against the JWKS endpoint and extract the
// event payload from the token body. Keep the port contract unchanged.
//
// Duplicate events (replay attacks or gateway retries after partial
// acknowledgement) are rejected via the `seenEventIds` set supplied by the
// caller. In production the set is a Redis/Postgres-backed dedupe store;
// this module does not own the store.
// =============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

import { DomainError } from '../../../../domain/errors.js';
import type {
  VerifyWebhookInput,
  WebhookEvent,
  WebhookVerifierPort,
} from '../../../../domain/ports/index.js';

import type { OnvoPayWebhookEvent } from './mappers.js';

export class WebhookSignatureError extends DomainError {
  constructor(message: string) {
    super('ADAPTER_ONVOPAY_WEBHOOK_SIGNATURE', message);
    this.name = 'WebhookSignatureError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WebhookDuplicateEventError extends DomainError {
  public readonly eventId: string;

  constructor(eventId: string) {
    super(
      'ADAPTER_ONVOPAY_WEBHOOK_DUPLICATE',
      `OnvoPay webhook event '${eventId}' already processed.`,
    );
    this.name = 'WebhookDuplicateEventError';
    this.eventId = eventId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Pluggable dedupe store. A production implementation persists seen event
 * ids for the gateway-documented retention window (OnvoPay's is not
 * published at time of writing — TODO: verify — use 24h as a baseline).
 *
 * The verifier marks an event as seen IMMEDIATELY after a successful
 * signature check. That is intentionally aggressive — it prevents attackers
 * from replaying a captured webhook to force side effects during the window
 * where the application layer is still processing the first delivery. The
 * application-layer `ProcessWebhook` use case also has its own idempotency
 * check (on `eventId` AND on the request's `idempotencyKey`), so a
 * legitimate gateway retry after a transient processing failure is absorbed
 * at that layer rather than here.
 */
export interface OnvoPayWebhookDedupeStore {
  /** Returns true if `eventId` has been marked seen previously. */
  has(eventId: string): Promise<boolean>;
  /** Marks `eventId` as seen. Idempotent. */
  mark(eventId: string): Promise<void>;
}

export interface OnvoPayWebhookVerifierConfig {
  /** Shared secret provisioned by OnvoPay's merchant dashboard. */
  readonly signingSecret: string;
  /** Dedupe store for eventId-based replay protection. */
  readonly dedupe: OnvoPayWebhookDedupeStore;
}

/**
 * In-memory dedupe store suitable for tests. Not safe for multi-process
 * deployments — use a shared Redis/Postgres store in production.
 */
export class InMemoryOnvoPayDedupeStore implements OnvoPayWebhookDedupeStore {
  private readonly seen = new Set<string>();

  async has(eventId: string): Promise<boolean> {
    return this.seen.has(eventId);
  }

  async mark(eventId: string): Promise<void> {
    this.seen.add(eventId);
  }
}

export class OnvoPayWebhookVerifier implements WebhookVerifierPort {
  readonly gateway = 'onvopay' as const;

  constructor(private readonly config: OnvoPayWebhookVerifierConfig) {}

  async verify(input: VerifyWebhookInput): Promise<WebhookEvent> {
    this.assertSignatureValid(input.signature, input.payload);

    // Signature OK — now safe to parse.
    let parsed: OnvoPayWebhookEvent;
    try {
      const text = new TextDecoder().decode(input.payload);
      parsed = JSON.parse(text) as OnvoPayWebhookEvent;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WebhookSignatureError(
        `OnvoPay webhook payload is not valid JSON after signature passed: ${message}`,
      );
    }
    if (!parsed.id || !parsed.type) {
      throw new WebhookSignatureError(
        'OnvoPay webhook payload missing required `id` or `type` fields.',
      );
    }
    if (await this.config.dedupe.has(parsed.id)) {
      throw new WebhookDuplicateEventError(parsed.id);
    }
    await this.config.dedupe.mark(parsed.id);

    return {
      gateway: 'onvopay',
      eventId: parsed.id,
      eventType: parsed.type,
      payload: input.payload,
      occurredAt: parsed.created_at ? new Date(parsed.created_at) : input.receivedAt,
    };
  }

  private assertSignatureValid(signatureHeader: string, payload: Uint8Array): void {
    if (!signatureHeader) {
      throw new WebhookSignatureError('OnvoPay signature header is missing.');
    }
    const provided = extractHexSignature(signatureHeader);
    const expectedHex = createHmac('sha256', this.config.signingSecret)
      .update(payload)
      .digest('hex');

    const providedBuf = safeFromHex(provided);
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (providedBuf === null || providedBuf.length !== expectedBuf.length) {
      throw new WebhookSignatureError('OnvoPay signature has wrong length or encoding.');
    }
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      throw new WebhookSignatureError('OnvoPay signature does not match.');
    }
  }
}

/**
 * Extract the hex signature from the raw header. Accepts both the bare-hex
 * form (`abc123...`) and the `t=<unix>,v1=<hex>` composite form, mirroring
 * the most common webhook-signature conventions.
 *
 * TODO: verify header shape against https://docs.onvopay.com/ webhook
 * section. If OnvoPay uses `v0` or a dedicated `onvopay-signature` /
 * `x-onvopay-signature` scheme with a fixed layout, simplify the parser.
 */
function extractHexSignature(header: string): string {
  const segments = header.split(',').map((s) => s.trim());
  for (const seg of segments) {
    if (seg.startsWith('v1=')) {
      return seg.slice(3);
    }
  }
  // No `v1=` segment — assume the whole header is the hex digest.
  return header.trim();
}

function safeFromHex(hex: string): Buffer | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    return null;
  }
  return Buffer.from(hex, 'hex');
}
