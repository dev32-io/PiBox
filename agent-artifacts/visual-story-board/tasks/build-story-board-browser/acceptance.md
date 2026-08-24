# Task Acceptance: Build the complete Story Board browser application

## Deliverables

- Deliver the catalog, three-column task board, grouped Documents, independent Reports, safe Markdown/evidence presentation, deep navigation, and contained loading/degraded states inside the shared shell.

## Acceptance

- A developer can move from catalog to a story workspace with Board, Documents, and Reports and refresh any supported local deep URL.
- Every persisted task appears once in the approved column and visibly retains exact status, dependencies, stage, and categorized detail when available.
- Documents and reports load on demand and render safe readable Markdown, canonical local images, missing/unsupported evidence, findings, attempts, and accepted risk.
- Task-scoped reports and task details navigate bidirectionally while story/stage/final/E2E reports remain independently browsable.
- Loading, Refresh, malformed content, keyboard-only use, and narrow viewports preserve shell navigation and usable inspection.

## Boundary Proof

- Focused browser-state tests exercise production route/state/rendering modules for all six approved journey surfaces; final browser behavior is then evaluated unchanged through the assisted launcher.
