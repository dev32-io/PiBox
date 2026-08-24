# Task Acceptance: Build the read-only Story Board domain reader

## Deliverables

- Project canonical repository stories, tasks, documents, reports, and evidence into deterministic browser-safe models without branch switching, source mutation, or one malformed resource hiding healthy siblings.

## Acceptance

- A repository-wide catalog deterministically lists healthy and degraded stories with active work before completed or archived work.
- Story workspace projections expose every persisted task once with exact status, grouped documents, independent reports, and task/report relationships.
- Malformed indexes, tasks, documents, reports, and evidence degrade only their local projection and expose sanitized diagnostics.
- Historical compatible fields are recoverable without source mutation or branch switching.
- Reader tests cover all approved fixture data needs for E2E-001 through E2E-006.

## Boundary Proof

- Focused reader/projector tests compare projections with disposable canonical fixtures, enumerate every persisted task status, exercise malformed sibling isolation and evidence membership metadata, and verify unchanged source checksums/Git status.
