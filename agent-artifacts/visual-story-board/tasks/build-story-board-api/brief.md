# Task Brief: Build the lazy Story Board API and cache

## Contribution Goal

Expose bounded progressive Story Board routes with session-scoped single-flight caching, manual Refresh, safe content loading, and canonical evidence containment.

## Boundary — Included

- Story Board viewer registration and bounded JSON/content/evidence routes
- Idle lazy activation, progressive resource loading, repository-scoped completed/in-flight cache, single-flight behavior, rejection retry, and Refresh invalidation
- Shared Markdown sanitization and URL policy used by Documents, Reports, findings, accepted risk, and textual evidence
- Manifest-membership plus realpath containment for canonical copied evidence files
- Focused route, cache, lazy-loading, sanitization, containment, and cleanup tests

## Required Work

- 1. Register Story Board as a host viewer without reading the repository during host creation; make the first browser catalog request the activation boundary and record only bounded fixture-capable diagnostics for named hidden invariants.
- 2. Add stable bounded routes for catalog summaries, lightweight story workspace, selected task details, selected document bodies, selected report details, Refresh, diagnostics, and manifest-listed copied evidence.
- 3. Implement repository-scoped caches for completed projections and in-flight promises so concurrent identical reads share work, failed reads can retry, abandoned clients do not corrupt cache state, and Refresh invalidates only Story Board before starting an asynchronous replacement catalog read.
- 4. Enforce progressive loading: catalog reads only index/intent summaries; workspace reads task cards and document/report catalogs; full task, document, report, and evidence content loads only on selection.
- 5. Implement one Markdown policy and browser-safe transport representation that removes executable HTML and unsafe schemes, converts external images to inert links, allows only bounded local companion evidence URLs, and renders missing/unsupported evidence explicitly.
- 6. Serve evidence bytes only after validating selected work item/evaluation identity, canonical evidence manifest membership, regular-file realpath containment beneath the copied evidence root, and supported response metadata; deny traversal, symlink escape, arbitrary repository files, and unlisted items.
- 7. Close caches and outstanding viewer resources deterministically with the host, and add tests for no eager discovery, direct Architecture isolation, duplicate request single-flight, failed-read retry, Refresh during navigation, path/symlink/manifest attacks, external-image inertness, missing evidence, and source immutability.

## Integration Expectation

Integrate in parallel with shell/Architecture work after the foundation stage; expose stable production routes before the browser application is implemented.

## Context

- The integrated domain reader produces browser-safe catalog/workspace/task/document/report/evidence models; the reusable host provides viewer route registration and deterministic close.
- Story Board discovery must begin only after browser activation. Catalog loads summaries; story selection loads workspace catalogs; task/document/report/evidence content loads only when selected.
- Refresh invalidates only Story Board session projections, retries rejected entries, and must not block shell navigation or disturb Architecture watching.

## Boundary — Excluded

- Story Board browser catalog/board/documents/reports presentation
- Canonical parser/projection ownership already supplied by the domain-reader task
- Standalone assisted launcher process and fixture repository
- Continuous filesystem watching or private runtime data

## Interfaces and Dependencies

- Consumes the reusable host viewer/route contract and integrated asynchronous Story Board reader/projector.
- Produces stable loopback Story Board endpoints, refresh and bounded diagnostics controls, shared Markdown policy payloads, and safe evidence URLs consumed by the Story Board browser and assisted launcher.

## Constraints

- No Story Board filesystem work before activation and no continuous Story Board watcher.
- All route parameters and filesystem targets must remain ID-validated, manifest-authorized, realpath-contained, read-only, and loopback-only.
- Refresh must not reset Architecture artifact watching or block shell tab navigation.
- External images must never auto-load; raw HTML, scriptable schemes, traversal, symlink escape, directories, and unlisted evidence must be rejected.
