# Visual Companion shell and Story Board design

## Design Goal

Evolve the architecture-specific companion into a fast reusable local application whose generic backend, viewer adapters, static artifact projection, browser presentation, and design system remain independently understandable and testable.

## Chosen Approach

- Keep the Visual Companion extension responsible for Pi tool/command registration, service lifecycle, session cleanup, browser opening, and creation of one session-local backend.
- Refactor the generic backend into a small HTTP host plus viewer registry. The backend owns loopback serving, route containment, common asset delivery, viewer registration, and shutdown; it does not own Story Board parsing or presentation logic.
- Introduce a shared application shell that owns top-level Story Board and Architecture navigation, direct-route selection, viewer-local loading boundaries, and shared design-token assets.
- Implement Story Board as a viewer package with asynchronous discovery, focused canonical readers, a tolerant compatibility boundary, pure browser-safe projection, session-scoped single-flight caching, bounded routes, and dedicated browser assets.
- Use progressive loading: the service starts with no story reads; Story Board activation loads only catalog summaries; story selection loads task/document/report catalogs; task, document, report, and evidence content loads on demand.
- Provide a deterministic standalone fixture launcher that composes the same backend and viewer registry as the extension, binds a random loopback port, prints a machine-readable URL, and shuts down cleanly. It exists as a verification and local-development seam, not an alternate product implementation.
- Replace architecture-specific hard-coded colors with shared semantic design tokens. Browser CSS consumes the token file directly, and Cytoscape resolves the same CSS variables through computed styles.

## Verification Boundaries

- Unit checks cover status-to-column mapping, deterministic ordering, browser-safe projection, strict/fallback parsing, lazy reader boundaries, path containment, Markdown sanitization policy, cache single-flight behavior, invalidation, and degraded sibling isolation.
- Backend integration checks cover idempotent start/status/stop controllers, loopback binding, shell-first startup without discovery invocation, viewer registration, direct Architecture selection, shared routes, and cleanup.
- Architecture regression checks cover document validation, layout selection, graph interaction, details, last-valid behavior, live refresh, and semantic token consumption.
- Fixture-driven Playwright journeys cover shell responsiveness during loading, nested Story Board navigation, documents, reports and evidence, malformed-artifact recovery through Refresh, Architecture compatibility, keyboard navigation, and narrow viewport behavior.
- The fixture launcher must use the production backend, registry, routes, parser, projector, Markdown assets, and UI; verification must fail if it silently substitutes a test-only data/rendering path.
- Visual evidence should include representative desktop and narrow-viewport screenshots using the approved neutral token system. Internal timing evidence is used only to prove the hidden invariant that discovery was not invoked before Story Board activation.

## Components and Interfaces

- Visual Companion lifecycle adapter: registers the visual_companion tool, the service descriptor including a start controller, session hooks, viewer factories, and browser-launch behavior.
- Companion backend: loopback HTTP server, shared asset route, viewer-scoped route dispatch, optional SSE support for viewers that need it, process-safe resource ownership, and deterministic close.
- Viewer registry: maps stable viewer identifiers to assets, route handlers, optional artifact loaders, and shell destinations without hard-coding Architecture in the backend.
- Companion shell: persistent header, Story Board and Architecture tabs, direct/deep-route interpretation, viewer mount points, accessible focus behavior, and non-blocking viewer-local state.
- Story discovery and catalog loader: asynchronously enumerates agent-artifacts and reads the minimum index/intent data needed for story summaries.
- Canonical readers: focused asynchronous readers for work-item indexes, task manifests and narratives, story documents, evaluation manifests/reports/history/risk acceptance, and canonical evidence manifests/files.
- Compatibility reader: uses strict canonical parsing first and falls back to bounded metadata recovery and diagnostics without rewriting source artifacts.
- Static projector: pure functions transform readers into explicit browser-safe StorySummary, StoryWorkspace, TaskCard, TaskDetail, DocumentSummary, ReportSummary, ReportDetail, Finding, and Evidence models.
- Session cache: repository-scoped maps of completed values and in-flight promises. Refresh invalidates only Story Board projections and starts a new scan; it does not affect Architecture artifact watching.
- Story Board routes: bounded JSON and evidence endpoints for catalog, workspace summaries, task details, document bodies, report details, and canonical copied evidence.
- Markdown presentation: one browser renderer and sanitizer used by Documents and Reports. It allows safe local companion evidence URLs, keeps external images from auto-loading, rejects executable HTML and unsafe URL schemes, and renders missing/unsupported evidence explicitly.
- Story Board UI: story catalog, story header, Board/Documents/Reports local navigation, three Kanban columns, compact task cards, responsive detail drawer/sheet, document accordions, report catalog/detail, diagnostics, retry, and Refresh.
- Shared design-token file: semantic colors, gradients, typography, spacing, geometry, borders, elevation, motion, focus, and application dimensions consumed by every viewer.
- Fixture server and canonical fixtures: healthy, legacy, malformed, report/evidence, image, and refresh-recovery repositories suitable for deterministic browser journeys.

## Data and Control Flow

- /services start visual-companion asks the lifecycle adapter to create or reuse the backend, returns as soon as the shell is serving, updates service status, and opens the shell home route.
- Direct visual_companion architecture start creates or reuses the same backend, registers or updates the active architecture artifact, and opens a shell route selecting Architecture.
- The shell loads static navigation first. Activating Story Board transitions its local state from idle to loading and requests the catalog; other tabs remain interactive.
- The catalog loader asynchronously discovers story directories, shares duplicate in-flight reads, strictly parses healthy artifacts, projects tolerant degraded entries for failures, and returns deterministic summaries.
- Selecting a story requests a lightweight workspace containing task cards and document/report catalogs. Selecting a task or expanding a content item makes a separate bounded request for its full content.
- The browser renders Markdown only after the requested body arrives. Canonical evidence URLs resolve through the evidence route after containment and manifest membership checks.
- Refresh invalidates cached Story Board projections, starts a replacement catalog request, and preserves shell navigation. Successful responses replace degraded or stale browser state.
- Architecture continues to use its existing artifact watcher and SSE refresh path independently from Story Board caching.

## Failure and Recovery

- Backend startup failure leaves service state stopped and reports a bounded actionable error; partial resources are closed.
- Catalog-level absence returns an intentional empty state. Catalog scan failure returns retryable Story Board-local diagnostics and never disables Architecture.
- Malformed story-level resources produce a degraded story entry. Malformed child resources produce local diagnostics while valid siblings remain available.
- A failed or abandoned browser request does not corrupt cache state. Concurrent identical requests share one promise; rejected entries can be retried or invalidated by Refresh.
- Unsafe Markdown constructs are removed or converted to inert text/link representations. External images never cause automatic network requests.
- Evidence access is denied unless the requested file is a regular canonical copied evidence item beneath the selected work item and evaluation evidence root.
- A missing evidence file renders an unavailable state while preserving report readability.
- Stop and session shutdown close HTTP listeners, SSE clients, file watchers, timers, and fixture resources without waiting for story parsing to finish indefinitely.
- Historical parsing never invokes mutation, migration, branch switching, or Git writes.

## Alternatives Considered

- A monolithic Node server containing service lifecycle, parsing, API projection, and browser behavior was rejected because it would couple unrelated viewer and workflow concerns and become difficult for bounded local implementation tasks to modify safely.
- Starting a full story scan before opening the browser was rejected because repository size and malformed artifacts would make companion startup unpredictable and block Architecture users.
- A live projection over .pibox and the TUI workflow adapter was deferred because it mixes volatile private runtime state with the persisted read-only story model.
- Eight or more operational task-status columns were rejected in favor of traditional To do, In progress, and Done columns with exact status badges.
- Embedding reports only inside task details was rejected because story-, stage-, whole-branch-, and E2E-scoped reports are independent artifacts and users need a complete report catalog.
- Requiring managed E2E to orchestrate a nested interactive Pi/TUI session was rejected in favor of a production-path fixture launcher plus deterministic lifecycle integration checks.
