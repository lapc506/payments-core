// =============================================================================
// Package entry point
// -----------------------------------------------------------------------------
// payments-core v0.1 exposes the domain layer for application and adapter
// consumption. The application layer (14 use cases) is available via the
// dedicated `./application/index.js` subpath — it is deliberately NOT
// re-exported here because many use-case input/output types share names
// with domain port types (e.g. `HoldEscrowInput`, `RefundPaymentInput`),
// and colliding `export *` surfaces would be ambiguous. Adapters import
// each layer through its own barrel. Additional entry points (outbound
// gateway adapters, the inbound gRPC server) land in follow-up changes.
// =============================================================================

export * from './domain/index.js';
