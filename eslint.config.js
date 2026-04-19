// ESLint 9 flat config for payments-core.
// Baseline rules mirror invoice-core / marketplace-core. No framework-specific
// plugins in v0.1 — adapters may extend this config if/when they need rules of
// their own.
//
// `no-restricted-imports` on `src/domain/**` enforces the hexagonal boundary:
// the domain layer must not depend on I/O libraries (`@grpc/*`, `stripe`,
// `@supabase/*`, `pg`, `node-fetch`, `axios`, `onvopay`) nor on outer layers
// (`../adapters/*`, `../application/*`, `../infrastructure/*`).
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
];
