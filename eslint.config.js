// ESLint 9 flat config for payments-core.
// Baseline rules mirror invoice-core / marketplace-core. No framework-specific
// plugins in v0.1 — adapters may extend this config if/when they need rules of
// their own.
//
// `no-restricted-imports` on `src/domain/**` enforces the hexagonal boundary:
// the domain layer must not depend on I/O libraries (`@grpc/*`, `stripe`,
// `@supabase/*`, `pg`, `node-fetch`, `axios`, `onvopay`) nor on outer layers
// (`../adapters/*`, `../application/*`, `../infrastructure/*`).
//
// A parallel rule on `src/application/**` forbids adapter imports and gateway
// SDKs — the application layer depends on ports declared under
// `src/domain/ports/` and on the domain entities via the `@/domain` barrel.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/generated/**',
      '**/*.pb.ts',
      '**/*.pb.js',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      eqeqeq: 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Domain purity guard — no I/O libs, no outer-layer imports.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@grpc/*',
                'stripe',
                '@supabase/*',
                'pg',
                'node-fetch',
                'axios',
                'onvopay',
                'fs',
                'node:fs',
                'net',
                'node:net',
                'http',
                'node:http',
                'https',
                'node:https',
              ],
              message: 'Domain layer must not depend on I/O libraries.',
            },
            {
              group: ['**/adapters/**', '**/application/**', '**/infrastructure/**'],
              message: 'Domain must not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // OnvoPay adapter isolation — the adapter must not reach into sibling
    // adapters (stripe/, tilopay/, etc.) nor into the inbound gRPC layer.
    // Allowed dependencies: `src/domain/**`, Node built-ins, and `msw` in
    // tests. Anything else is a hexagonal boundary violation.
    files: ['src/adapters/outbound/gateways/onvopay/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/adapters/outbound/gateways/stripe/**',
                '**/adapters/outbound/gateways/tilopay/**',
                '**/adapters/outbound/gateways/dlocal/**',
                '**/adapters/outbound/gateways/revolut/**',
                '**/adapters/outbound/gateways/convera/**',
                '**/adapters/outbound/gateways/ripple_xrpl/**',
                '**/adapters/inbound/**',
                '**/application/**',
                '**/infrastructure/**',
              ],
              message:
                'OnvoPay adapter must not import from sibling adapters, inbound layer, application layer, or infrastructure. Depend on src/domain/** only.',
            },
          ],
        },
      ],
    },
  },
  {
    // Application purity guard — no adapter imports, no gateway-specific SDKs,
    // no direct I/O libraries. The application layer consumes the domain via
    // the `@/domain` barrel (`src/domain/index.ts`) and nothing else.
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@grpc/*',
                'stripe',
                '@supabase/*',
                'pg',
                'node-fetch',
                'axios',
                'onvopay',
                'fs',
                'node:fs',
                'net',
                'node:net',
                'http',
                'node:http',
                'https',
                'node:https',
              ],
              message:
                'Application layer must not depend on I/O libraries or gateway SDKs. Use ports declared in src/domain/ports.',
            },
            {
              group: ['**/adapters/**', '**/infrastructure/**'],
              message:
                'Application layer must not import from adapter or infrastructure layers. Depend on ports only.',
            },
          ],
        },
      ],
    },
  },
  {
    // Inbound gRPC adapter guard — forbid cross-adapter contamination. The
    // inbound adapter depends only on the domain, application, generated
    // proto code, node built-ins, and @grpc/grpc-js. It must not reach into
    // any outbound adapter (gateway adapters live in their own modules and
    // are wired via the use-case container handed to `createServer`).
    files: ['src/adapters/inbound/grpc/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/outbound/**'],
              message:
                'Inbound gRPC adapter must not depend on outbound adapters. Wire via the use-case container in main.ts.',
            },
            {
              group: [
                'stripe',
                '@supabase/*',
                'pg',
                'node-fetch',
                'axios',
                'onvopay',
              ],
              message:
                'Inbound gRPC adapter must not depend on gateway SDKs. Wire via ports only.',
            },
          ],
        },
      ],
    },
  },
];
