# Task Brief: Build the complete Story Board browser application

## Contribution Goal

Deliver the catalog, three-column task board, grouped Documents, independent Reports, safe Markdown/evidence presentation, deep navigation, and contained loading/degraded states inside the shared shell.

## Boundary — Included

- Story catalog with active-before-complete ordering, metadata, degraded diagnostics, empty/loading/error/retry states, and story selection
- Story workspace with Board, Documents, and Reports local navigation and stable deep URLs
- Traditional To do/In progress/Done board, exact status badges, task cards, and categorized responsive task detail drawer/sheet
- Grouped lazy Documents with shared safe Markdown presentation
- Independent Reports catalog/detail with attempts, findings, accepted risk, textual/image/missing/unsupported evidence, and bidirectional task links
- Refresh behavior, viewer switching during loads, keyboard semantics, responsive layout, and focused browser-state tests

## Required Work

- 1. Implement the Story Board browser state/router under the shared shell with stable catalog, story workspace, local Board/Documents/Reports, task detail, document detail, and report detail URLs that restore selection on browser refresh.
- 2. Build catalog idle/loading/ready/empty/degraded/retryable error states; render safely recoverable title, intent excerpt, kind, phase, state, revision, task/report counts, deterministic active-before-complete order, local diagnostics, and Refresh.
- 3. Build the Board with exactly three semantic columns using API-projected mappings; render every task exactly once, retain exact persisted status text and non-color meaning, show dependencies/stage when present, and lazy-load categorized task detail only after selection.
- 4. Build Documents as expandable semantic groups for Intent and scope, Specifications, Design, Decisions, Journey cases, and Outcome; omit absent optional groups and request/render each Markdown body only when opened.
- 5. Build Reports as independent list/detail surfaces showing scope/result, attempts, findings, risk acceptance, and evidence; implement Go to task and Related reports navigation, shared safe Markdown rendering, inline canonical local images, inert external-image links, and explicit missing/unsupported evidence states.
- 6. Keep shell and Architecture navigation responsive while Story Board or Refresh requests remain in flight; prevent stale responses from overwriting newer navigation or refreshed state; keep failures localized to the affected content region.
- 7. Apply shared tokens, visible focus, supported keyboard activation, logical focus movement/return, wrapping/readability, reduced motion, and narrow-viewport full-height detail sheets across catalog, board, Documents, and Reports.
- 8. Add focused browser-module and asset-contract tests for route parsing/restoration, status/card uniqueness, progressive request timing, stale-response suppression, category omission, report/task links, Markdown/evidence rendering decisions, keyboard labels/roles, focus return, and responsive sheet classes.

## Integration Expectation

Run on the canonical branch after shell and API integration so one fresh agent owns the complete browser state, navigation, rendering, and focused-test feedback loop.

## Context

- The integrated shell supplies Story Board and Architecture mount points plus shared semantic tokens; the integrated API supplies lazy catalog/workspace/detail routes, Refresh, sanitized Markdown payloads, and safe evidence URLs.
- The application is read-only and must preserve stable refreshable local URLs, exact task statuses, bidirectional task/report navigation, and user-visible idle/loading/ready/degraded/retryable error states.
- Browser E2E will use a later production-path launcher, so browser code should expose stable accessible roles, labels, routes, and deterministic states rather than test-only hooks.

## Boundary — Excluded

- Canonical filesystem parsing, cache/server/evidence authorization, service lifecycle, or Architecture graph implementation
- Standalone assisted launcher and disposable fixture materialization
- Workflow edit controls, drag-and-drop, live runtime status, or continuous watching

## Interfaces and Dependencies

- Consumes shared shell mount/navigation/token contracts and Story Board catalog/workspace/task/document/report/evidence/Refresh endpoints.
- Produces production Story Board browser assets and stable accessible routes/roles used unchanged by the assisted launcher and final E2E evaluator.

## Constraints

- Browsing, filtering, expanding, refreshing, and navigation must never write canonical artifacts.
- Do not eagerly request workspace, task, document, report, or evidence content before the user action that needs it.
- Do not inject raw canonical HTML or auto-load external images.
- Every status remains visible as text or icon plus text; essential controls and details remain available at narrow viewports.
