# Task Brief: Load canonical reports, history, risk acceptance, and evidence

## Contribution Goal

Expose independently browsable report details and only manifest-authorized canonical evidence through contained asynchronous readers.

## Boundary — Included

- Strict report/evaluation detail projection with local degradation
- Attempt history and risk-acceptance Markdown loading
- Evidence manifest parsing, metadata projection, and manifest-membership checks
- Contained regular-file evidence reads with safe media metadata
- Security and failure-isolation tests

## Required Work

- 1. Add a report-detail loader keyed only by evaluation IDs cataloged in the selected workspace and read evaluation.yaml, current report.md, attempts, findings, result, and optional risk-acceptance.md asynchronously.
- 2. Preserve report scope and task relationships, order attempt history deterministically, and keep missing optional history/risk content explicit but non-fatal.
- 3. Parse the canonical evidence manifest and expose command/result/description/checksum/media metadata without absolute source paths.
- 4. Implement one evidence resolver that serves only manifest-listed copied regular files beneath agent-artifacts/<story>/evidence/<evaluation>, rejects absolute/parent/symlink escapes, and validates the selected evaluation association.
- 5. Return unavailable diagnostics for missing or unsupported evidence without breaking report Markdown; never read volatile .pibox logs or original external source paths.
- 6. Add tests for task/story scopes, attempts, findings, accepted risk, text/image evidence, missing files, unsupported media, manifest forgery, traversal, symlink escape, and sibling isolation.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Canonical evaluations store evaluation.yaml, report.md, attempts/*-report.md, optional risk-acceptance.md, and evidence/<evaluation>/manifest.yaml plus copied files.
- Reports may be task, stage, whole-branch, E2E, or story scoped; only task scope creates Go to task/Related reports links.
- Local images referenced through approved evidence routes may render inline later; external images and arbitrary paths must remain inaccessible.

## Boundary — Excluded

- Browser Markdown rendering
- HTTP response/content-type wiring
- Raw .pibox logs, transcripts, stdout, or stderr
- Task card rendering

## Interfaces and Dependencies

- Consumes ReportSummary identities and selected story/evaluation roots.
- Produces ReportDetail and resolved canonical evidence handles suitable for bounded API routes.
