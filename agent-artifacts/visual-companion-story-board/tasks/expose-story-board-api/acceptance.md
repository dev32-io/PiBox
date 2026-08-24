# Task Acceptance: Expose lazy Story Board viewer API routes

## Deliverables

- Register Story Board as a non-artifact viewer with bounded JSON, refresh, diagnostics, and evidence routes backed by production readers and cache.

## Acceptance

- Registering or starting Visual Companion does not read agent-artifacts
- Catalog loads only after Story Board activation/request
- Workspace and detail routes load only their declared resource level
- Refresh invalidates Story Board without blocking shell routes
- Evidence and diagnostics remain path-contained and browser-safe
- Architecture APIs continue to function on the same backend

## Boundary Proof

- API integration tests instrument reader calls and exercise every route class plus traversal and refresh cases
