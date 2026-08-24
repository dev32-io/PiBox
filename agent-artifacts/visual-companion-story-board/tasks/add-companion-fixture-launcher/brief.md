# Task Brief: Add the production-path companion fixture launcher

## Contribution Goal

Make the real Visual Companion browser surface deterministically launchable for development and managed E2E without a nested Pi/TUI session.

## Boundary — Included

- Standalone random-loopback launcher API and CLI
- Machine-readable startup/diagnostics output and signal cleanup
- Disposable canonical fixture repository with representative stories/tasks/documents/reports/evidence
- Discovery-delay diagnostic seam limited to fixture configuration
- Focused launcher and fixture-integrity tests

## Required Work

- 1. Add a reusable launch function accepting repositoryRoot, optional architecture artifact, optional fixture-only discovery delay, loopback host, and random port, returning host/port/url/diagnosticsUrl/close.
- 2. Add a CLI that prints one machine-readable JSON startup line, remains alive until SIGINT/SIGTERM, reports bounded diagnostics, and closes production resources exactly once.
- 3. Compose the exact production backend, registry, shell assets, Story Board readers/projectors/cache/routes, Markdown vendor assets, and Architecture adapter; do not add alternate data or render code.
- 4. Add canonical disposable fixtures containing active/complete stories, every three-column status class, all document categories, task/story/stage/final/E2E reports, attempts, findings, risk acceptance, text/image/missing/external evidence, and one historical malformed story.
- 5. Provide a safe refresh-recovery copy/update mechanism for the malformed fixture and a fixture-only delayed discovery hook so E2E can observe non-blocking loading.
- 6. Add tests for random loopback binding, startup JSON, production module composition, fixture validity/intentional invalidity, diagnostics, signal/explicit cleanup, and absence of nested Pi dependencies.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The E2E agent has Bash and Playwright MCP but cannot invoke the session-owned visual_companion tool.
- The launcher must compose the production backend, viewer registry, shell, Story Board readers/cache/routes, Markdown assets, and Architecture viewer; a test-only renderer would invalidate evidence.
- Approved journeys require healthy, legacy, malformed, report/evidence/image, refresh-recovery, and delayed-discovery fixture states.

## Boundary — Excluded

- Repository-pinned Playwright dependency or browser runner
- Managed evaluation resources
- Product-only delay or debug behavior enabled outside fixture options
- TUI automation

## Interfaces and Dependencies

- Consumes the production Visual Companion factories completed by prior sequential tasks.
- Produces a CLI/handle and deterministic fixture paths usable by the low-tier E2E evaluator for all six approved cases.
