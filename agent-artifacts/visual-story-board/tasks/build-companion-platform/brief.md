# Task Brief: Build the reusable Visual Companion platform

## Contribution Goal

Provide one loopback-only Visual Companion host with reusable viewer registration, shell-first startup, idempotent service lifecycle, and preserved direct Architecture behavior.

## Boundary — Included

- Refactor the backend into a generic loopback HTTP host with common assets, viewer registration, bounded explicit routes, and deterministic resource ownership
- Add idempotent /services start, status, and stop behavior for visual-companion while retaining the visual_companion architecture-opening tool
- Preserve Architecture artifact validation, watcher, SSE, direct opening, last-valid behavior, and browser launch compatibility
- Add focused lifecycle, route-isolation, startup-order, reuse, and cleanup tests

## Required Work

- 1. Define and implement a viewer/route registration contract in extensions/visual-companion that supports common shell assets, viewer assets, bounded dynamic handlers, and optional Architecture artifact loading without embedding Story Board parsing in the host.
- 2. Refactor backend creation and close semantics so one random-port loopback server owns listeners, viewer resources, SSE clients, watchers, and timers and releases each resource exactly once.
- 3. Add a visual-companion service start controller that creates or reuses the host, serves the shell before optional viewers perform data work, publishes running state and URL, and makes repeated start/status/stop operations idempotent.
- 4. Keep the existing visual_companion tool as the Architecture direct-open adapter: register or update the architecture artifact, select Architecture in the shared route, and avoid activating Story Board.
- 5. Harden common/viewer route containment and 404 behavior without weakening the existing repository containment check for architecture artifacts.
- 6. Add and run focused tests for random loopback binding, viewer registration, shell-first startup with a discovery spy, repeated and concurrent lifecycle operations, direct Architecture selection, one-backend reuse, and shutdown cleanup.

## Integration Expectation

Integrate as the production transport and lifecycle contract before shell, Story Board routes, or fixture launcher work begins.

## Context

- The current backend in extensions/visual-companion/backend.mjs serves viewer-scoped assets, one document API, SSE, and artifact watching; the extension currently registers only Architecture.
- The service registry already supports start, health, and stop controllers, but visual-companion currently registers only health and stop, so /services start visual-companion is unsupported.
- Story Board discovery must not run during backend startup or direct Architecture opening; startup must expose the shell first and one session-local backend must be reused.

## Boundary — Excluded

- Story Board canonical parsing, projection, caching, API semantics, or browser UI
- Architecture visual restyling and shared design tokens
- Assisted fixture repositories and final browser journeys

## Interfaces and Dependencies

- Consumes the existing service-adapter controller contract and Architecture viewer factory.
- Produces a reusable Visual Companion host/viewer registry, common shell route contract, lifecycle handle, running URL, and deterministic close boundary consumed by later shell, Story Board API, and assisted-launcher tasks.

## Constraints

- Bind only to loopback interfaces and random ports unless an existing safe explicit port is supplied.
- Do not perform Story Board filesystem discovery during host creation, ordinary service start, or direct Architecture opening.
- Do not expose arbitrary filesystem routes or couple generic backend code to workflow mutation APIs.
- Preserve current Architecture validation, document API, live refresh, and process-exit behavior.
