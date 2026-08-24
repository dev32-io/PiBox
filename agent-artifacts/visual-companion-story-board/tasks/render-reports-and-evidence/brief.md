# Task Brief: Render independent Reports and canonical evidence

## Contribution Goal

Give each story a dedicated report catalog and Markdown detail experience with findings, history, evidence, and bidirectional task links.

## Boundary — Included

- Reports catalog, scope/result metadata, and local filtering by scope/result
- Lazy report detail with attempts, findings, risk acceptance, and evidence
- Markdown text/image evidence presentation and unavailable states
- Go to task and Related reports route completion

## Required Work

- 1. Render the Reports local view as first-class report items with title/ID, type, scope, status/verdict, attempt, finding count, and evidence indicator; provide compact client-side scope/result filters without altering source data.
- 2. Load full report detail only when selected and render current report Markdown, attempt history, findings with severity/status, accepted risk, and residual/unavailable states using labeled expandable sections.
- 3. Render textual evidence through the shared Markdown pipeline, validated local images inline, and unsupported or missing evidence as metadata plus explicit safe links/unavailable labels.
- 4. Add Go to task only for task-scoped reports and complete Related reports navigation so history/back/direct URLs move predictably between report and task selections.
- 5. Preserve story-, stage-, whole-branch-, and E2E-scoped reports without manufacturing task ownership.
- 6. Add DOM tests for every scope, filters, lazy loading, multiple attempts, findings/risk, text/image/missing/external evidence, no external requests, and bidirectional route restoration.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Report summaries and details remain independent from task objects and may be task, stage, whole-branch, E2E, or story scoped.
- The backend exposes manifest-authorized evidence and the shared Markdown renderer enforces local-image/external-image policy.
- Task-scoped reports provide Go to task; task details already expose Related reports targets.

## Boundary — Excluded

- Raw .pibox log browsing
- Report editing, finding acceptance, or workflow approvals
- Backend evidence containment logic
- Final mobile and keyboard audit

## Interfaces and Dependencies

- Consumes ReportSummary/ReportDetail/evidence APIs, task routes, shared Markdown renderer, and design tokens.
- Produces Reports view, report-detail routes, and completed bidirectional report/task navigation.
