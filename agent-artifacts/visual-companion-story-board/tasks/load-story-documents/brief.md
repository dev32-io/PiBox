# Task Brief: Load contained story document bodies on demand

## Contribution Goal

Return one selected canonical story document as bounded Markdown without exposing arbitrary files or affecting sibling content.

## Boundary — Included

- Document ID/path resolution from the selected story’s canonical catalog
- Realpath and regular-file containment checks
- Bounded asynchronous Markdown reads with metadata and local diagnostics
- Focused lazy, missing, oversized, traversal, and symlink tests

## Required Work

- 1. Define a document identity resolver that accepts only IDs present in the selected StoryWorkspace document catalog rather than arbitrary relative paths.
- 2. Resolve the canonical file with realpath, require a regular file beneath the selected story root, and reject absolute paths, parent segments, and symlink escapes.
- 3. Read Markdown asynchronously with a documented size bound and return title, category, source identity, Markdown text, and repository-relative diagnostics.
- 4. Treat missing, unreadable, or oversized documents as local degraded results without invalidating other story resources.
- 5. Add tests for each approved document category, lazy invocation, missing files, path traversal, symlink escapes, size bounds, and no source writes.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Documents include intent, specifications, designs, decisions, E2E matrices, and outcome paths cataloged by the workspace reader.
- The browser will request a document body only when its category/file accordion opens.
- Markdown rendering belongs to the browser pipeline; this reader owns identity, containment, size, and diagnostics.

## Boundary — Excluded

- Markdown-to-HTML rendering or sanitization
- Report, risk-acceptance, or evidence content
- HTTP routes and browser accordions

## Interfaces and Dependencies

- Consumes a validated story root and DocumentSummary identity from the workspace reader.
- Produces a browser-safe DocumentDetail containing bounded Markdown and diagnostics.
