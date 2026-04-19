// =============================================================================
// Domain layer barrel
// -----------------------------------------------------------------------------
// Single import surface for the application layer and for outbound adapters.
// Adapters must NEVER reach into `src/domain/entities/*.ts`,
// `src/domain/value_objects/*.ts`, or `src/domain/ports/*.ts` directly; always
// import from `@/domain`.
//
// Hard constraint enforced via eslint `no-restricted-imports` on
// `src/domain/**`: no I/O libraries, no outer-layer imports. The domain
// layer is pure TypeScript.
// =============================================================================

export * from './entities/index.js';
export * from './errors.js';
export * from './ports/index.js';
export * from './value_objects/index.js';
