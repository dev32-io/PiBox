# Task Acceptance: Build the lazy Story Board API and cache

## Deliverables

- Expose bounded progressive Story Board routes with session-scoped single-flight caching, manual Refresh, safe content loading, and canonical evidence containment.

## Acceptance

- Backend/service startup and direct Architecture opening invoke no Story Board discovery.
- Catalog, workspace, task, document, report, and evidence routes load progressively and return stable browser-safe models.
- Concurrent identical unloaded requests share one in-flight operation; failures retry; Refresh replaces stale/degraded projections without service restart.
- Markdown and evidence policies prevent executable content, external image requests, and filesystem escape while preserving safe canonical local images and readable missing/unsupported evidence.
- Stopping the companion releases Story Board cache and outstanding route resources without mutating canonical artifacts.

## Boundary Proof

- Focused route/cache tests use disposable healthy, malformed, report/evidence, and refresh fixtures to observe lazy invocation counts, single-flight identity, retry/invalidation, sanitized Markdown policy, evidence membership/realpath denial, and unchanged source state.
