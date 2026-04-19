// =============================================================================
// OnvoPay HTTP client
// -----------------------------------------------------------------------------
// The ONLY file in this adapter allowed to perform network I/O. Every other
// file in `src/adapters/outbound/gateways/onvopay/` imports from this module
// and never calls `fetch` directly. Centralizing the transport here keeps
// timeouts, retry policy, and auth handling consistent across the charges,
// subscriptions, and webhook-verification code paths.
//
// Dependencies: ONLY Node built-ins. Node 20.11+ ships `fetch`, `Headers`,
// `AbortSignal.timeout`, and `URL`, so no `axios` / `node-fetch` is needed.
//
// Retry policy:
//   - Transient network errors (ECONNRESET, ETIMEDOUT, aborted fetch) are
//     retried up to `maxRetries` with exponential backoff + jitter.
//   - Business errors (4xx and 5xx from OnvoPay) are NEVER retried inside
//     the client. They surface as `OnvoPayHttpError` and the caller (or the
//     error mapper) decides how to translate them.
//   - TanStack-style "the query layer owns retries" does not apply here —
//     this is a server adapter — but the same principle holds: do not hide
//     business failures behind transparent retries.
//
// Auth: OnvoPay uses a secret API key. The header wire format is
// `Authorization: Bearer <ONVOPAY_API_KEY>`.
// TODO: verify against https://docs.onvopay.com/#section/Referencia-API —
// if the published scheme is `x-api-key` or `Basic`, update `buildHeaders`
// and keep the `Idempotency-Key` / `Content-Type` lines unchanged.
// =============================================================================

import { DomainError } from '../../../../domain/errors.js';

// ---------------------------------------------------------------------------
// Config + errors
// ---------------------------------------------------------------------------

export interface OnvoPayClientConfig {
  /**
   * Base URL, e.g. `https://api.onvopay.com`. No trailing slash.
   * TODO: verify the exact production base URL against
   * https://docs.onvopay.com/#section/Referencia-API.
   */
  readonly apiBaseUrl: string;
  /** Secret API key issued by OnvoPay's merchant dashboard. */
  readonly apiKey: string;
  /** Per-request timeout, in milliseconds. Default 10_000 if omitted. */
  readonly timeoutMs?: number;
  /**
   * Maximum retry attempts for transient NETWORK errors (not business 4xx/5xx).
   * Default 2 if omitted. 0 disables retries entirely.
   */
  readonly maxRetries?: number;
  /**
   * Optional custom fetch. Injected by tests that spin up a local `node:http`
   * stub instead of using a real network. Production supplies undefined so
   * the global `fetch` is used.
   */
  readonly fetchImpl?: typeof fetch;
}

export class OnvoPayHttpError extends DomainError {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, message: string, body: string) {
    super('ADAPTER_ONVOPAY_HTTP', message);
    this.name = 'OnvoPayHttpError';
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OnvoPayNetworkError extends DomainError {
  constructor(message: string) {
    super('ADAPTER_ONVOPAY_NETWORK', message);
    this.name = 'OnvoPayNetworkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

export interface OnvoPayRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  /** OnvoPay's idempotency header. Required on mutating calls. */
  readonly idempotencyKey?: string;
  /** Query-string parameters; values are URL-encoded at send time. */
  readonly query?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 100;

/**
 * Factory-style constructor; kept as a plain function so the adapter files
 * depend on the interface rather than on a class constructor.
 */
export function createOnvoPayHttpClient(
  config: OnvoPayClientConfig,
): OnvoPayHttpClient {
  return new OnvoPayHttpClient(config);
}

export class OnvoPayHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OnvoPayClientConfig) {
    if (!config.apiBaseUrl || config.apiBaseUrl.endsWith('/')) {
      throw new DomainError(
        'ADAPTER_ONVOPAY_CONFIG',
        'apiBaseUrl is required and must not end with "/"',
      );
    }
    if (!config.apiKey) {
      throw new DomainError('ADAPTER_ONVOPAY_CONFIG', 'apiKey is required');
    }
    this.baseUrl = config.apiBaseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async request<T>(req: OnvoPayRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const headers = this.buildHeaders(req.idempotencyKey, req.body !== undefined);
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    }

    let lastNetworkErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // 204 No Content — OnvoPay signals success with no body on some
        // endpoints (e.g. subscription cancel). Return null-as-T; callers
        // that expect a specific shape must tolerate this.
        if (response.status === 204) {
          return null as unknown as T;
        }
        const raw = await response.text();
        if (!response.ok) {
          throw new OnvoPayHttpError(
            response.status,
            `OnvoPay ${req.method} ${req.path} failed with HTTP ${response.status}`,
            raw,
          );
        }
        if (raw.length === 0) {
          return null as unknown as T;
        }
        return JSON.parse(raw) as T;
      } catch (err) {
        if (err instanceof OnvoPayHttpError) {
          // Never retry business errors.
          throw err;
        }
        // Treat everything else (timeout, DNS, connection reset) as transient.
        lastNetworkErr = err;
        if (attempt >= this.maxRetries) {
          break;
        }
        await sleep(backoffMs(attempt));
      }
    }
    const msg = lastNetworkErr instanceof Error ? lastNetworkErr.message : 'unknown network error';
    throw new OnvoPayNetworkError(
      `OnvoPay ${req.method} ${req.path} failed after ${this.maxRetries + 1} attempt(s): ${msg}`,
    );
  }

  private buildUrl(path: string, query?: Readonly<Record<string, string>>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private buildHeaders(idempotencyKey: string | undefined, hasBody: boolean): Headers {
    const headers = new Headers();
    // TODO: verify auth scheme against https://docs.onvopay.com/#section/Referencia-API
    // — if OnvoPay uses `x-api-key: <key>` or `Basic <base64>` instead of
    // Bearer, change this line (only this file needs updating).
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    headers.set('Accept', 'application/json');
    if (hasBody) {
      headers.set('Content-Type', 'application/json');
    }
    if (idempotencyKey) {
      // TODO: verify idempotency header name against
      // https://docs.onvopay.com/#section/Referencia-API — common variants
      // are `Idempotency-Key`, `X-Idempotency-Key`, and `Onvopay-Idempotency-Key`.
      headers.set('Idempotency-Key', idempotencyKey);
    }
    return headers;
  }
}

function backoffMs(attempt: number): number {
  // Exponential backoff with full jitter: base * 2^attempt * random(0..1).
  const deterministic = BASE_BACKOFF_MS * Math.pow(2, attempt);
  return Math.floor(deterministic * Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
