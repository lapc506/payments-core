# Operations

Runbooks, deploy topology, and incident response for `payments-core` in
production.

## What lands here

- **Deploy topology** — where the service runs, how it is scaled, and which
  regions host adapter-specific traffic.
- **Observability** — log pipeline, metric dashboards, tracing propagation
  across consumer → `payments-core` → provider.
- **Runbooks** — on-call playbooks for adapter outages, webhook backlogs,
  reconciliation drift, and idempotency-key collisions.
- **Release process** — how new adapter versions roll out, feature flags,
  and rollback paths.
- **SLOs & error budgets** — availability and latency targets per port.

Until those pages land, operational notes live inline in each change's
`design.md` under the **Risks** section.
