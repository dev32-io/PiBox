# Task Brief: Render the asynchronous Story Board catalog

## Contribution Goal

Present repository stories in a polished read-only list with non-blocking loading, degraded, empty, error, retry, and Refresh states.

## Boundary — Included

- Story Board browser state module and activation lifecycle
- Contained loading spinner and explanatory copy
- Deterministic story list, status metadata, degraded cards, empty/error/retry states
- Refresh control and story-selection navigation

## Required Work

- 1. Add a mount/unmount Story Board browser module with idle/loading/ready/degraded/error state and one catalog request triggered only by first activation.
- 2. Render a contained spinner/loading page inside the Story Board region while leaving shell tabs and Architecture fully interactive.
- 3. Render active stories before complete/archived stories using API order and show title, bounded intent excerpt, kind, phase, state, revision, task count, and report count.
- 4. Render malformed historical stories as selectable degraded entries with an Artifact needs attention badge and bounded diagnostics rather than omitting them.
- 5. Add intentional empty state, retryable error state, and Refresh control; Refresh starts a replacement load without a global overlay and ignores stale responses.
- 6. Navigate story selection to a stable encoded local route while preserving shell tabs and add DOM-focused tests for all states and activation timing.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The shell emits Story Board activation and the API exposes a lazy catalog plus Refresh.
- Story Board is the ordinary home tab, but shell tabs must stay interactive while the catalog request runs.
- Cards/rows show story title, intent excerpt, kind, phase, state, revision, task/report counts, and diagnostics for degraded history.

## Boundary — Excluded

- Task Kanban and task details
- Documents or Reports views
- Markdown rendering
- Final mobile/keyboard audit beyond correct semantic controls

## Interfaces and Dependencies

- Consumes shell activation/navigation hooks, shared design primitives, and the catalog/Refresh API.
- Produces selected-story route events and a reusable Story Board mount state consumed by workspace UI tasks.
