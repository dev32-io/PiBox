# Task Brief: Read lazy story workspace summaries and task details

## Contribution Goal

Load one selected story’s task cards, task details, document catalog, and report summaries without reading document or report bodies prematurely.

## Boundary — Included

- Selected-story workspace reader
- Task manifest cards and on-demand task detail reader
- Document category/catalog summaries without body reads
- Evaluation summary catalogs and task/report relationship projection
- Per-child degradation and lazy-read tests

## Required Work

- 1. Add a contained asynchronous workspace reader for one validated story ID and reject absolute, parent, or symlink-escaped identifiers/paths.
- 2. Read task manifests independently, apply strict task parsing first, preserve exact status/dependencies/stage, and degrade only the malformed task while valid siblings remain.
- 3. Build task cards without brief or acceptance bodies; add a separate task-detail method that reads and returns categorized brief, acceptance, assignment/stage, dependencies, verification, delivery history, and related report IDs only when selected.
- 4. Build document summaries from intent, artifact catalogs, e2e matrices, and outcome paths using approved categories, omitting missing optional groups and leaving Markdown bodies unloaded.
- 5. Build lightweight report summaries from evaluation manifests with scope, type, status/verdict, attempt, finding count, evidence availability, and optional task relationship; do not load report Markdown or evidence files.
- 6. Add read-spy tests proving workspace summary laziness, task-detail on demand, child isolation, legacy task compatibility, missing optional categories, and bounded diagnostics.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Catalog selection should request a lightweight workspace, not every Markdown body.
- Task manifests use strict parsing with legacy in-memory compatibility; brief.md and acceptance.md are separate task details.
- Documents are indexed by story artifact catalogs; evaluations remain independent report summaries and may link to a task by scope.

## Boundary — Excluded

- Full document Markdown
- Full report/attempt/risk/evidence content
- Cache and HTTP routing
- Browser task board or documents UI

## Interfaces and Dependencies

- Consumes StorySummary/projection contracts and the catalog’s validated repository/story roots.
- Produces StoryWorkspace summaries plus a separate TaskDetail loader consumed by later routes.
