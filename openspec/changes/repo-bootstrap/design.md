# Design — Repo bootstrap

## Directory layout after this change

```
payments-core/
├── .github/
│   ├── workflows/
│   │   └── ci.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── CODEOWNERS
├── .nvmrc                         node version pin
├── .env.example
├── .prettierrc.json
├── Makefile
├── eslint.config.js
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── src/
│   └── index.ts                   export {}
└── openspec/                      already exists
└── docs/                          already exists (empty, wired by mkdocs-site)
└── proto/                         already exists (empty, wired by proto-contract-v1)
```

## `package.json`

```json
{
  "name": "@lapc506/payments-core",
  "version": "0.0.1",
  "private": true,
  "description": "One payments sidecar for the -core ecosystem (Stripe, OnvoPay, Tilopay, dLocal, Revolut, Convera, Ripple, Apple/Google Pay verify).",
  "license": "BSL-1.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "engines": { "node": ">=20.11" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier -w .",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist coverage"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  },
  "packageManager": "pnpm@9.0.0"
}
```

Runtime dependencies are deliberately empty. Adapters bring their own (`stripe`, `onvopay`, `@grpc/grpc-js`, etc.) in their respective changes.

## `tsconfig.json`

Strict. Matches `invoice-core` and `marketplace-core`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

## `tsconfig.build.json`

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "emitDeclarationOnly": false,
    "noEmit": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "**/*.spec.ts"]
}
```

## CI (`.github/workflows/ci.yml`)

Triggers: PRs to `main` and pushes to `main`. Matrix: single Node 20 entry.

Steps: checkout, set up Node with pnpm cache, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm build`, `pnpm test -- --reporter=verbose`. Greptile runs in parallel via the existing org-level integration; no workflow changes needed for it.

## ESLint flat config

Baseline rules mirror `invoice-core`:
- `@typescript-eslint/no-explicit-any: error`
- `@typescript-eslint/no-unused-vars: error` with `argsIgnorePattern: "^_"`
- `no-console: ["error", { allow: ["warn", "error"] }]`
- `no-debugger: error`
- `eqeqeq: error`
- `prefer-const: error`

No framework-specific plugins in v0.1.

## `Makefile`

Thin wrapper — just aliases to pnpm so the ergonomics match `agentic-core` (whose ecosystem audience includes non-JS collaborators):

```
install:
	pnpm install
build:
	pnpm build
test:
	pnpm test
lint:
	pnpm lint
format:
	pnpm format
clean:
	pnpm clean
.PHONY: install build test lint format clean
```

## Risks

- **ESLint v9 flat config ecosystem** — some plugins still ship `.eslintrc`-style configs. Mitigation: stick to `@typescript-eslint/*` which has native flat-config support as of 7.x. Avoid plugins we don't actually need until a later change brings them.
- **pnpm lockfile vs npm defaults** — contributors who reflexively run `npm install` will get a warning because we set `packageManager` and ship `pnpm-lock.yaml`. Mitigation: the README already recommends pnpm; CI rejects anything but pnpm on lock mismatch.

## Rollback

Revert the merge commit. The repo returns to a state with `README`, `LICENSE`, `openspec/`, `linear-setup.json`, `.gitignore` and nothing else.
