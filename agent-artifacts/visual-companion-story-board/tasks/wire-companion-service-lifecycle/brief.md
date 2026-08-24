# Task Brief: Wire idempotent Visual Companion service lifecycle

## Contribution Goal

Make /services start, status, and stop visual-companion operate one shell-first session backend while preserving direct Architecture launch.

## Boundary — Included

- Shared create/reuse/open/stop lifecycle functions
- Service-controller start support and accurate status details
- Direct Architecture artifact activation through the same backend
- Session startup/shutdown cleanup and focused lifecycle tests

## Required Work

- 1. Extract one serialized lifecycle path that creates or reuses the backend, tracks its shell URL and active architecture artifact, and opens browser destinations.
- 2. Add the visual-companion service start controller so /services start visual-companion starts or reopens the shell and publishes running state and URL.
- 3. Keep status and health bounded and cloneable; keep stop idempotent and ensure it closes server, watchers, timers, and clients exactly once.
- 4. Route visual_companion Architecture starts through the shared lifecycle, validate repository-contained artifact paths, activate the artifact, and open the shell with Architecture selected.
- 5. Preserve session_start stopped state and session_shutdown cleanup/unregistration.
- 6. Add focused mocked-extension and backend tests for first start, repeated start, direct Architecture reuse, status, stop, startup failure rollback, and shutdown.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- extensions/visual-companion/index.ts currently registers health and stop only; the service adapter already supports a start controller.
- The visual_companion tool and service controller must share one serialized lifecycle instead of creating separate backends.
- Startup must return after the shell listens and before Story Board discovery.

## Boundary — Excluded

- Story Board readers and API routes
- Browser catalog or board UI
- Changes to the generic service-adapter command syntax

## Interfaces and Dependencies

- Consumes the shell URL/destination contract and createVisualCompanionBackend handle.
- Produces a ServiceController with start, health, and stop plus the unchanged visual_companion tool surface.
