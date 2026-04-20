// =============================================================================
// Application layer barrel
// -----------------------------------------------------------------------------
// Public surface for the 14 use cases that implement the proto `PaymentsCore`
// service. Inbound adapters (`src/adapters/inbound/grpc/`, landing in the
// `grpc-server-inbound` change) import from `@/application`; they never reach
// into individual use-case files.
//
// Dependency injection pattern: **factory functions (closure-based)**. Each
// use case exports a `make<UseCaseName>(deps)` factory that returns an
// async `execute(input) => Promise<Result<Output, DomainError>>` function.
//
// Why factory functions over classes:
//   1. Fewer lines of boilerplate (no `this`, no constructor, no private
//      readonly fields repeated for every dependency).
//   2. Closure captures deps once; the returned `execute` is a bare function
//      that is trivial to compose and stub in tests.
//   3. Mirrors the idiomatic TypeScript style already used in the domain
//      layer (`createPaymentIntent`, `transitionPaymentIntent`, ...).
//
// The trade-off is that consumers pass `execute` around rather than a class
// instance; this is a non-issue because inbound adapters register one
// instance per RPC at wiring time.
//
// Idempotency invariant: every mutating use case MUST call
// `IdempotencyPort.check(key)` before any port side effect. On hit, the
// stored result is returned unchanged (idempotent replay). On miss, the use
// case proceeds and commits the result via `IdempotencyPort.commit` before
// returning.
//
// Error model: use cases return `Result<T, DomainError>` from the domain
// `errors.ts` module. They never throw (state-machine throws are caught and
// wrapped into `err(...)`). Inbound adapters map `DomainError` subclasses to
// gRPC status codes in their own translator.
//
// ESLint guard (in `eslint.config.js`): this module cannot import from
// `src/adapters/**`, `src/infrastructure/**`, or any gateway SDK. Violations
// fail CI.
// =============================================================================

export {
  makeInitiateCheckout,
  makeConfirmCheckout,
  makeRefundPayment,
  type InitiateCheckoutInput,
  type InitiateCheckoutOutput,
  type ConfirmCheckoutInput,
  type ConfirmCheckoutOutput,
  type RefundPaymentInput,
  type RefundPaymentOutput,
  type InitiateCheckoutDeps,
  type ConfirmCheckoutDeps,
  type RefundPaymentDeps,
} from './use_cases/checkout.js';

export {
  makeCreateSubscription,
  makeSwitchSubscription,
  makeCancelSubscription,
  type CreateSubscriptionInput,
  type CreateSubscriptionOutput,
  type SwitchSubscriptionInput,
  type SwitchSubscriptionOutput,
  type CancelSubscriptionInput,
  type CancelSubscriptionOutput,
  type CreateSubscriptionDeps,
  type SwitchSubscriptionDeps,
  type CancelSubscriptionDeps,
} from './use_cases/subscription.js';

export {
  makeHoldEscrow,
  makeReleaseEscrow,
  makeDisputeEscrow,
  type HoldEscrowInput,
  type HoldEscrowOutput,
  type ReleaseEscrowInput,
  type ReleaseEscrowOutput,
  type DisputeEscrowInput,
  type DisputeEscrowOutput,
  type HoldEscrowDeps,
  type ReleaseEscrowDeps,
  type DisputeEscrowDeps,
} from './use_cases/escrow.js';

export {
  makeCreatePayout,
  type CreatePayoutInput,
  type CreatePayoutOutput,
  type CreatePayoutDeps,
  type PayoutGatewayPort,
} from './use_cases/payout.js';

export {
  makeProcessWebhook,
  type ProcessWebhookInput,
  type ProcessWebhookOutput,
  type ProcessWebhookDeps,
} from './use_cases/webhook.js';

export {
  makeHandleAgenticPayment,
  type HandleAgenticPaymentInput,
  type HandleAgenticPaymentOutput,
  type HandleAgenticPaymentDeps,
} from './use_cases/agentic.js';

export {
  makeGetPaymentHistory,
  makeReconcileDaily,
  type GetPaymentHistoryInput,
  type GetPaymentHistoryOutput,
  type GetPaymentHistoryDeps,
  type PaymentHistoryReaderPort,
  type PaymentHistoryEntry,
  type ReconcileDailyInput,
  type ReconcileDailyOutput,
  type ReconcileDailyDeps,
} from './use_cases/reads.js';

export {
  makeCreateOneTimeDonation,
  makeCreateRecurringDonation,
  makeManageRecurringDonation,
  type CreateDonationCommonInput,
  type CreateOneTimeDonationInput,
  type CreateOneTimeDonationOutput,
  type CreateOneTimeDonationDeps,
  type CreateRecurringDonationInput,
  type CreateRecurringDonationOutput,
  type CreateRecurringDonationDeps,
  type ManageRecurringDonationInput,
  type ManageRecurringDonationOutput,
  type ManageRecurringDonationDeps,
  type DonationRegistryPort,
  type DonationRepositoryPort,
} from './use_cases/donations.js';
