# Design — Proto contract v1

## Package and namespacing

```
proto/
  payments_core.proto           root file, one service + all messages
  buf.yaml                      buf lint config
  buf.gen.yaml                  codegen config (ts + openapi)
```

`package` lines:
- Service + request/response messages: `package lapc506.payments_core.v1;`
- Events: `package lapc506.payments_core.events.v1;`

Versioning through the package name (not the filename) matches `agentic-core/proto/agentic_core.proto` and is standard buf style. v2 would live at `lapc506.payments_core.v2` with a separate file.

## Service skeleton

```proto
service PaymentsCore {
  // Checkout
  rpc InitiateCheckout(InitiateCheckoutRequest) returns (InitiateCheckoutResponse);
  rpc ConfirmCheckout(ConfirmCheckoutRequest) returns (ConfirmCheckoutResponse);
  rpc RefundPayment(RefundPaymentRequest) returns (RefundPaymentResponse);

  // Webhook ingestion (from gateway-facing HTTP receiver)
  rpc ProcessWebhook(ProcessWebhookRequest) returns (ProcessWebhookResponse);

  // Subscriptions
  rpc CreateSubscription(CreateSubscriptionRequest) returns (CreateSubscriptionResponse);
  rpc SwitchSubscription(SwitchSubscriptionRequest) returns (SwitchSubscriptionResponse);
  rpc CancelSubscription(CancelSubscriptionRequest) returns (CancelSubscriptionResponse);

  // Escrow
  rpc HoldEscrow(HoldEscrowRequest) returns (HoldEscrowResponse);
  rpc ReleaseEscrow(ReleaseEscrowRequest) returns (ReleaseEscrowResponse);
  rpc DisputeEscrow(DisputeEscrowRequest) returns (DisputeEscrowResponse);

  // Payouts
  rpc CreatePayout(CreatePayoutRequest) returns (CreatePayoutResponse);

  // Agentic commerce (entry from agentic-core)
  rpc InitiateAgenticPayment(InitiateAgenticPaymentRequest) returns (InitiateAgenticPaymentResponse);

  // Reads
  rpc GetPaymentHistory(GetPaymentHistoryRequest) returns (GetPaymentHistoryResponse);
  rpc ReconcileDaily(ReconcileDailyRequest) returns (ReconcileDailyResponse);
}
```

## Key message shapes

`Money` is a shared value object:
```proto
message Money {
  int64 amount_minor = 1;       // 1234 for $12.34
  string currency = 2;           // ISO 4217, e.g. "USD" / "CRC"
}
```

Gateway selection is an enum:
```proto
enum GatewayPreference {
  GATEWAY_PREFERENCE_UNSPECIFIED = 0;
  GATEWAY_PREFERENCE_AUTO = 1;
  GATEWAY_PREFERENCE_STRIPE = 2;
  GATEWAY_PREFERENCE_ONVOPAY = 3;
  GATEWAY_PREFERENCE_TILOPAY = 4;
  GATEWAY_PREFERENCE_DLOCAL = 5;
  GATEWAY_PREFERENCE_REVOLUT = 6;
  GATEWAY_PREFERENCE_CONVERA = 7;
  GATEWAY_PREFERENCE_RIPPLE_XRPL = 8;
}
```

Wallet token (Apple Pay / Google Pay) is a `oneof` inside `ConfirmCheckoutRequest`:
```proto
message ConfirmCheckoutRequest {
  string intent_id = 1;
  oneof confirmation {
    string three_ds_result = 2;
    WalletToken wallet_token = 3;
  }
  string idempotency_key = 10;
}

message WalletToken {
  enum Provider {
    PROVIDER_UNSPECIFIED = 0;
    PROVIDER_APPLE_PAY = 1;
    PROVIDER_GOOGLE_PAY = 2;
  }
  Provider provider = 1;
  bytes payload = 2;   // opaque encrypted blob from the client SDK
}
```

Idempotency is **first-class** on every mutating RPC: a required `idempotency_key` field. The application layer enforces uniqueness against a Postgres table.

## Event messages

```proto
message PaymentSucceededEvent {
  string intent_id = 1;
  string consumer = 2;             // e.g. "dojo-os" | "altrupets-api"
  Money amount = 3;
  GatewayPreference gateway = 4;
  google.protobuf.Timestamp occurred_at = 5;
  map<string, string> metadata = 6;
}
```

Same shape for the other variants. `consumer` is the tenant tag so event consumers (invoice-core, marketplace-core) can route by tenant.

## OpenAPI mirror

Use `grpc-gateway` annotations sparingly — only on the RPCs that might be called by a frontend directly (none in v1; all RPCs go through backends) OR by Stoplight Elements for its interactive rendering.

To generate OpenAPI without forcing a gateway in production, we use `buf generate` with the `openapiv2` plugin configured to emit the spec even for RPCs without `google.api.http` annotations. The generated descriptor lands at `openapi/payments_core.yaml`.

```yaml
# buf.gen.yaml
version: v1
plugins:
  - plugin: buf.build/grpc/openapiv2
    out: openapi
    opt:
      - generate_unbound_methods=true
      - output_format=yaml
      - allow_merge=true
  - plugin: buf.build/community/stephenh-ts-proto
    out: src/generated
    opt:
      - esModuleInterop=true
      - outputServices=grpc-js
      - useOptionals=messages
```

## `buf lint` config

```yaml
# buf.yaml
version: v1
lint:
  use:
    - DEFAULT
  except:
    - RPC_REQUEST_STANDARD_NAME        # allow `InitiateCheckoutRequest` shape
    - RPC_RESPONSE_STANDARD_NAME
  enum_zero_value_suffix: _UNSPECIFIED
breaking:
  use:
    - FILE
```

## Backward-compatibility policy

- v1 is frozen once merged. Additive changes only (new fields with new numbers, new messages).
- Breaking changes happen in a v2 file, not by editing v1. v1 stays supported until every consumer migrates.
- `buf breaking` runs in CI against the last-tagged commit to prevent accidental breakage.

## Risks

- **Over-fit to Stripe semantics** — `InitiateCheckoutRequest` fields like `cancel_url` / `success_url` carry Stripe's redirect model. For gateways that do not redirect (card-present, wallet-direct), these fields must be optional and ignored. Documented inline.
- **Wallet token format divergence** — Apple Pay and Google Pay payload formats differ; we keep the `payload bytes` opaque and let the adapter decode.
- **3DS proto gap** — 3DS challenge/response roundtrips are stateful; we model them via `three_ds_result` as the second leg. If a gateway needs a three-leg flow, add `Initiate3DSChallenge` in a follow-up (additive).

## Rollback

Revert merges the `.proto` back out. Downstream changes (`domain-skeleton`, adapters) that depend on it are blocked until re-landed.
