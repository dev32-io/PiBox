# Task Brief: Render grouped Documents with one safe Markdown pipeline

## Contribution Goal

Provide readable lazy document accordions and a reusable sanitized Markdown renderer for both Documents and Reports.

## Boundary — Included

- Direct pinned Markdown parser and sanitizer dependencies with contained vendor routes
- One reusable Markdown-to-sanitized-DOM module and URL/image policy
- Documents category/file accordions with lazy body loading
- Readable Markdown typography and security-focused tests

## Required Work

- 1. Add marked and DOMPurify as direct runtime dependencies and expose only their required browser distributions through explicit contained vendor routes; update the lockfile.
- 2. Implement one shared Markdown renderer that parses Markdown, sanitizes resulting HTML, disables raw executable HTML, rejects unsafe schemes, and never inserts unsanitized strings with innerHTML.
- 3. Apply link policy so ordinary external links remain explicit safe links, external images render as links/placeholders without network requests, and only validated companion evidence image URLs may produce inline images.
- 4. Render the Documents view using approved category order, expandable groups and individual file accordions, omitted absent categories, per-file loading/error state, and lazy detail fetch on first expansion.
- 5. Add readable Markdown styles using shared typography/spacing/surface tokens for headings, lists, tables, code, blockquotes, links, and images.
- 6. Add tests for lazy requests, category ordering, multiple files, missing/degraded documents, raw HTML, scripts, unsafe URLs, external images, allowed local image URLs, and sanitized DOM output.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Document bodies arrive as bounded Markdown only when an individual file opens.
- The repository has no direct Markdown or sanitizer dependency; transitive packages must not be imported implicitly.
- Canonical local evidence images may be allowed later through companion evidence URLs, while raw HTML, scripts, javascript/data URLs, path escapes, and external images must not execute or auto-load.

## Boundary — Excluded

- Report catalog and report/task navigation
- Evidence API authorization, already owned by backend readers/routes
- Rich Markdown editing, syntax plugins, or remote embeds
- Final narrow viewport and keyboard audit

## Interfaces and Dependencies

- Consumes DocumentSummary/DocumentDetail APIs and shared design tokens.
- Produces a reusable renderSafeMarkdown module and Documents view consumed by the Reports UI task.
