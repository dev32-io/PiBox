# Task Brief: Read the canonical story catalog asynchronously

## Contribution Goal

Discover healthy and historical stories from agent-artifacts without Git operations, source mutation, or whole-catalog failure.

## Boundary — Included

- Repository-contained asynchronous story directory discovery
- Strict work-item parsing followed by tolerant metadata recovery
- Lightweight intent excerpt loading and deterministic catalog projection
- Empty, malformed, legacy, symlink, and sibling-isolation tests

## Required Work

- 1. Implement an asynchronous catalog reader rooted only at <repository>/agent-artifacts with no WorkItemStore reads, Git commands, branch checks, or writes.
- 2. For each story directory, read index.yaml and attempt the exported strict parser first; catch failures per directory instead of aborting the catalog.
- 3. On strict failure, recover only safe ID, title, kind, phase/state, revision, catalog IDs/counts, and repository-relative diagnostics; never infer delivery validity or repair content.
- 4. Read only enough intent Markdown to produce a bounded plain-text excerpt and avoid loading specifications, task bodies, reports, or evidence.
- 5. Resolve real paths and reject directory/symlink escapes while omitting absolute paths from diagnostics.
- 6. Project and sort healthy/degraded summaries with active-before-complete ordering and add tests using current legacy shape, malformed indexes, no agent-artifacts directory, and healthy siblings.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- WorkItemStore.list() strictly parses every story and one legacy delivery shape currently breaks global listing.
- Story Board must use filesystem-only asynchronous reads, strict parsing first, and bounded degraded recovery per story.
- Catalog reads need only index metadata, counts, and a short intent excerpt; child bodies remain lazy.

## Boundary — Excluded

- Task, document, report, or evidence body loading
- Cache, Refresh, or HTTP routes
- Browser catalog rendering
- Automatic artifact migration

## Interfaces and Dependencies

- Consumes the pure story ordering/projection contracts and exported strict work-item parser where safe.
- Produces Promise<ApiResult<StorySummary[]>>-equivalent catalog data plus bounded diagnostics.
