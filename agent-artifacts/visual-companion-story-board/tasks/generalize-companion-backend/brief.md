# Task Brief: Generalize the Visual Companion backend contract

## Contribution Goal

Make the existing loopback backend host multiple viewer types and common routes without changing Architecture behavior.

## Boundary — Included

- Refactor backend declarations and implementation into explicit generic viewer/route contracts
- Add common-route and viewer-request seams needed by a shell and Story Board
- Preserve all current Architecture URLs and lifecycle behavior
- Add focused backend compatibility tests

## Required Work

- 1. Define explicit declaration contracts for registered viewers, common static assets, bounded request handlers, activation state, and backend handles while preserving the existing architecture adapter.
- 2. Refactor backend.mjs so route dispatch is independent from artifact document loading and a viewer without an active artifact can expose declared routes.
- 3. Preserve /v/architecture/api/document, /v/architecture/events, vendor routes, static assets, watcher replacement, last-valid diagnostics, show(), unreferenced resources, and close().
- 4. Add common-route support suitable for a future shell without embedding Story Board parsing or UI policy in the backend.
- 5. Add focused tests for multiple viewers, route isolation, inactive non-artifact viewers, common-route containment, Architecture compatibility, and deterministic cleanup.
- 6. Run the focused checks and leave the backend API documented through declarations and test names.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- extensions/visual-companion/backend.mjs currently assumes every viewer is an artifact-backed static page activated through show().
- Architecture depends on /v/architecture/api/document, /events, vendor routes, artifact watching, last-valid retention, show(), and close().
- Later tasks need a generic viewer registry, browser-safe request handlers, common assets, and a shell URL.

## Boundary — Excluded

- Visual shell assets or navigation
- Service start-controller changes
- Story artifact readers, APIs, or browser UI
- Architecture visual restyling

## Interfaces and Dependencies

- Consumes the existing createVisualCompanionBackend viewer array and architecture adapter contract.
- Produces a generic backend/registry contract that later shell and Story Board routes can compose while retaining existing show(), URL, and close() behavior.
