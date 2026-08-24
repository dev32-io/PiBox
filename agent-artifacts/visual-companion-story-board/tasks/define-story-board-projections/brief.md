# Task Brief: Define pure Story Board projection contracts

## Contribution Goal

Create explicit browser-safe models and deterministic mapping rules before filesystem or HTTP behavior is introduced.

## Boundary — Included

- Story Board TypeScript contracts
- Pure task-column, story-ordering, document-grouping, report/task-link, and diagnostic projection functions
- Unknown and degraded status behavior
- Focused exhaustive mapping and serialization tests

## Required Work

- 1. Define narrow serializable Story Board models with only fields needed by the approved catalog, workspace, task, document, report, evidence, and diagnostics surfaces.
- 2. Implement task status mapping: draft/blocked/ready to todo; merged/integrated/cancelled to done; every other or unknown status to in-progress while retaining exact status text.
- 3. Implement deterministic story ordering with active work before complete/archived work and stable ID/title ordering inside groups.
- 4. Define document category mapping for Intent and scope, Specifications, Design, Decisions, Journey cases, and Outcome.
- 5. Define report summaries and task relationship projection without nesting full report bodies inside task details.
- 6. Add exhaustive pure tests for every current TaskStatus, unknown values, one-card-one-column membership, ordering, grouping, cross-links, missing optional data, and JSON safety.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The browser needs StorySummary, StoryWorkspace, TaskCard, TaskDetail, DocumentSummary, ReportSummary, ReportDetail, Finding, Evidence, Diagnostic, and ApiResult contracts.
- The board has exactly To do, In progress, and Done columns while preserving every raw status.
- Projection functions must expose repository-relative diagnostics only and remain independent from Git, branch switching, filesystem reads, and browser code.

## Boundary — Excluded

- Filesystem readers
- Cache or HTTP routes
- Browser rendering
- Markdown parsing

## Interfaces and Dependencies

- Consumes canonical workflow type vocabulary but no WorkItemStore methods.
- Produces stable Story Board projection types/functions for all later readers, APIs, and browser UI.
