# Task Brief: Build the read-only Story Board domain reader

## Contribution Goal

Project canonical repository stories, tasks, documents, reports, and evidence into deterministic browser-safe models without branch switching, source mutation, or one malformed resource hiding healthy siblings.

## Boundary — Included

- Asynchronous branch-independent readers for story indexes, intent summaries, task manifests/narratives, documents, evaluation reports/history/risk acceptance, and evidence metadata
- Strict-first parsing with bounded tolerant fallback and localized diagnostics for malformed or historical resources
- Pure browser-safe projections for catalog summaries, workspaces, task cards/details, document/report catalogs and details, findings, and evidence
- Deterministic active-before-complete ordering and exact three-column task mapping
- Read-only path containment and tests covering healthy, legacy, malformed, absent, and mixed sibling resources

## Required Work

- 1. Create a Story Board package beneath extensions/visual-companion with explicit domain model types for StorySummary, StoryWorkspace, TaskCard, TaskDetail, DocumentSummary/Detail, ReportSummary/Detail, Finding, and Evidence metadata.
- 2. Implement asynchronous repository readers that enumerate only agent-artifacts, validate IDs and catalog-relative paths, read canonical indexes and children without checking out branches, and never call workflow mutation, run-store, session, transcript, recovery, or cleanup APIs.
- 3. Reuse narrowly safe canonical types or parsing helpers where possible; otherwise implement strict-first read-only parsing and bounded metadata recovery that reports sanitized resource-relative diagnostics and isolates failures to the affected story or child.
- 4. Implement pure projections for active-before-complete/archived ordering, safely recoverable story metadata, semantic document groups, report scope/history/findings/risk acceptance, bidirectional task/report relationships, and every persisted task status mapped exactly once to To do, In progress, or Done while preserving exact text.
- 5. Define evidence metadata and manifest-membership information without serving file bytes; reject malformed paths, symlinks or non-regular candidates, missing members, and references outside the selected canonical evidence root.
- 6. Add fixture-driven tests for empty repositories, healthy and archived stories, legacy indexes/tasks, malformed story and child isolation, absent optional categories, every current task status, story/task/stage/final/E2E report shapes, accepted risk, missing/unsupported evidence, deterministic ordering, and proof that reads leave files and Git state unchanged.

## Integration Expectation

Integrate the complete read-only domain boundary before any Story Board HTTP route or browser UI consumes canonical artifacts.

## Context

- Canonical work items live under agent-artifacts/<id> with index.yaml, Markdown artifacts, task manifests/narratives, evaluation manifests/reports, risk acceptance, and copied evidence manifests/files.
- Existing WorkItemStore detail reads enforce the checked-out work item's working branch and combine strict parsing with mutation-oriented lifecycle assumptions; Story Board must inspect arbitrary current-repository stories read-only and branch-independently.
- The Board groups draft/blocked/ready as To do, merged/integrated/cancelled as Done, and every other persisted status as In progress while retaining exact status text.

## Boundary — Excluded

- HTTP routes, session caching, browser Markdown rendering, or UI state
- Workflow artifact migration, repair, writes, Git switching, or access to private .pibox runtime records
- Assisted launcher process control

## Interfaces and Dependencies

- Consumes repositoryRoot and canonical agent-artifacts paths plus narrowly reusable workflow types/parsers.
- Produces asynchronous read-only reader functions and pure browser-safe projection models consumed by Story Board cache/routes and fixture generation.

## Constraints

- All diagnostics and projected paths must be repository-relative and sanitized.
- Malformed resources degrade locally; one failure must not suppress healthy stories or siblings.
- Do not auto-migrate, rewrite, stage, commit, switch branches, or read private .pibox runtime data.
- Evidence candidates remain metadata until a later bounded route verifies canonical manifest membership and containment.
