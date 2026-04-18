# API

`payments-core` publishes a gRPC service as its canonical contract. For human
readability and for interactive exploration, the gRPC surface is mirrored as
an OpenAPI 3.1 descriptor generated from the protobuf source of truth.

- **[API Reference](reference.md)** — interactive renderer backed by
  [Stoplight Elements](https://stoplight.io/open-source/elements). Lets you
  browse every operation, read its Markdown description, and try it against
  the configured server.
- **Protobuf contract** — the source of truth; lives in the [`proto/`](https://github.com/lapc506/payments-core/tree/main/proto)
  directory of the repository. The OpenAPI descriptor is regenerated from
  it by the `proto-contract-v1` change.

## Conventions

Every operation documents: its preconditions, its idempotency key, its error
taxonomy, and which adapter ports it exercises. Breaking changes to the
contract require a new major version and a migration plan.
