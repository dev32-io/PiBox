# Task Acceptance: Render the asynchronous Story Board catalog

## Deliverables

- Present repository stories in a polished read-only list with non-blocking loading, degraded, empty, error, retry, and Refresh states.

## Acceptance

- Catalog loading never blocks top-level tab interaction
- No catalog request occurs before Story Board activation
- Healthy and degraded stories render with approved metadata and ordering
- Refresh and retry are viewer-local and stale-safe
- Selecting a story creates a refreshable encoded route

## Boundary Proof

- DOM tests with deferred fetches demonstrate tab responsiveness, activation timing, catalog states, and stale Refresh handling
