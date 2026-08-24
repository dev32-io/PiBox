# Task Brief: Add session-scoped Story Board lazy cache

## Contribution Goal

Share in-flight and completed Story Board reads while making manual Refresh safe, isolated, and retryable.

## Boundary — Included

- Repository/session-scoped keyed cache for completed and in-flight reads
- Per-resource lazy loader wrappers
- Story Board-only invalidation and generation handling
- Concurrency, failure, refresh, and isolation tests

## Required Work

- 1. Implement a small cache keyed by repository, resource kind, story ID, and child ID with explicit idle/loading/ready/degraded/error semantics outside the cache itself.
- 2. Ensure concurrent identical requests receive one in-flight promise and successful values are reused during the session.
- 3. Remove or mark rejected entries retryable so one transient read failure does not poison the session.
- 4. Implement Refresh as a generation change that invalidates Story Board catalog and dependent child projections while preventing stale prior-generation results from replacing refreshed data.
- 5. Keep Architecture state, watchers, SSE clients, and backend lifecycle outside this cache and expose no continuous file watcher.
- 6. Add deterministic deferred-promise tests for duplicate reads, rejection/retry, refresh during flight, stale completion, targeted invalidation, and Architecture isolation.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Story Board data must parse only after browser activation and then progressively by catalog, workspace, task, document, report, and evidence key.
- Concurrent identical requests must share one promise; failures must be retryable.
- Refresh invalidates Story Board state only and cannot disturb Architecture artifact watchers or shell navigation.

## Boundary — Excluded

- HTTP route definitions
- Browser spinner or Refresh button
- Filesystem parsing logic beyond injectable loader callbacks
- Continuous watching or TTL polling

## Interfaces and Dependencies

- Consumes asynchronous catalog/workspace/detail loader functions.
- Produces cache-backed Story Board load and refresh methods for the viewer API.
