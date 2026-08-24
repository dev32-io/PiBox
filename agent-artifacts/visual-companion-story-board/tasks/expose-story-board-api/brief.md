# Task Brief: Expose lazy Story Board viewer API routes

## Contribution Goal

Register Story Board as a non-artifact viewer with bounded JSON, refresh, diagnostics, and evidence routes backed by production readers and cache.

## Boundary — Included

- Story Board viewer factory and route registration
- Catalog, workspace, task, document, report, refresh, diagnostics, and evidence endpoints
- Stable ApiResult envelopes and HTTP error/status policy
- Activation timing and containment integration tests

## Required Work

- 1. Create a Story Board viewer factory that receives repositoryRoot and injectable readers/cache but performs no filesystem discovery during construction or backend registration.
- 2. Register bounded routes for catalog, selected story workspace, task detail, document detail, report detail, evidence file, Refresh, and safe diagnostics using encoded IDs rather than arbitrary paths.
- 3. Return explicit JSON data/diagnostic envelopes for healthy, empty, degraded, not-found, and retryable-error states; set bounded content types and cache headers appropriate for session-local reads.
- 4. Serve evidence only through the manifest-authorized resolver with safe content disposition/type and never expose absolute paths in URLs or diagnostics.
- 5. Make Refresh invalidate the Story Board generation and return promptly while replacement catalog parsing continues asynchronously.
- 6. Add backend integration tests proving zero discovery before Story Board activation, lazy endpoint read boundaries, route traversal rejection, sibling degradation, Refresh behavior, one backend, and Architecture route compatibility.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The backend, readers, projections, and cache now provide the production server seams.
- Shell activation must be the first event that requests the catalog; backend/service startup must not construct or invoke catalog parsing.
- Content endpoints must stay lightweight and lazy, with evidence as the only bounded binary response.

## Boundary — Excluded

- Story Board browser components
- Markdown rendering in the browser
- Fixture CLI and complete fixture repository
- Changes to canonical artifacts

## Interfaces and Dependencies

- Consumes the generic viewer registry, Story Board readers/projectors/cache, and evidence resolver.
- Produces stable loopback HTTP endpoints consumed by Story Board browser tasks and the fixture launcher.
