# Visual Companion Story Board behavior

## Context

Defines the user-visible behavior of the repository-local Visual Companion shell, Story Board catalog, nested story workspace, shared Markdown presentation, and compatibility with Architecture. V1 is a read-only view over persisted canonical artifacts and is intentionally not a live workflow dashboard.

## Required Behaviors

- The visual-companion service supports idempotent start, status, and stop through the existing /services interface; start opens or reopens the shell, status exposes running state and URL, and stop releases backend resources.
- Service startup registers the shell and viewer routes before any Story Board repository discovery begins.
- The shared shell exposes Story Board and Architecture tabs on all user-facing routes. Story Board is the home view for ordinary service startup, while direct architecture opening selects Architecture without triggering Story Board parsing.
- Story Board discovery begins asynchronously only when the browser activates Story Board. Its content area owns idle, loading, ready, degraded, and retryable error states while the shell and other viewer remain interactive.
- The story catalog reads canonical agent-artifacts in the current repository and presents active stories before completed or archived stories using deterministic ordering within each group.
- Each story summary presents safely recoverable title, intent excerpt, kind, phase, state, planning revision, task count, and report count.
- Selecting a story opens a workspace with Board, Documents, and Reports views and a refreshable local URL.
- The Board presents To do, In progress, and Done columns. To do contains draft, blocked, and ready tasks; Done contains merged, integrated, and cancelled tasks; all other persisted task statuses appear In progress. Every card retains the exact status as text and does not rely on color alone.
- Task cards present title, exact status, dependencies, and stage when available. Full task details load only after selection and are grouped into brief, acceptance, dependencies, assignment and stage, verification, delivery history, and related-report navigation.
- Documents group available files under Intent and scope, Specifications, Design, Decisions, Journey cases, and Outcome. Groups and individual files are expandable, absent optional categories are omitted, and document bodies load only when opened.
- Reports are first-class list items rather than content hidden inside task cards. Reports present scope, verdict or status, attempts, findings, risk acceptance, and evidence. Task-scoped reports link to their task, and task details link to related reports.
- One shared safe Markdown renderer presents story documents, reports, findings, risk acceptance, and textual evidence. Canonical local evidence images referenced by Markdown render inline, unsupported evidence appears as metadata and links, and external images do not auto-load.
- Refresh invalidates Story Board session caches and starts a new asynchronous scan without blocking shell navigation. Story Board does not continuously watch canonical artifacts in v1.
- The Architecture viewer retains existing document validation, layout, selection, details, and live artifact refresh behavior while consuming the shared shell and design-token system.
- Story Board is read-only: browsing, expanding, filtering, refreshing, and navigating never changes canonical workflow artifacts.

## Acceptance Criteria

- **AC-001:** Starting Visual Companion makes an interactive loopback shell available without invoking Story Board discovery during backend startup.
- **AC-002:** Starting an already-running companion reuses the backend and reopens its URL; stopping it releases server, watcher, timer, and client resources.
- **AC-003:** Opening Architecture directly displays the architecture viewer under the shared shell without initiating a Story Board scan.
- **AC-004:** Activating Story Board shows a contained loading state and allows immediate navigation to Architecture while parsing continues.
- **AC-005:** The catalog deterministically lists healthy and degraded stories without one malformed artifact preventing healthy stories from rendering.
- **AC-006:** Opening a story produces Board, Documents, and Reports views with stable refreshable local navigation.
- **AC-007:** Every persisted task appears exactly once in To do, In progress, or Done and visibly retains its exact persisted status.
- **AC-008:** Story documents and reports are rendered as safe, readable Markdown and are loaded only when their view or item requires them.
- **AC-009:** Reports and task details provide bidirectional navigation when evaluation scope identifies a task.
- **AC-010:** Canonical copied evidence cannot escape its bounded evidence route; local Markdown images render inline and external images remain inert links.
- **AC-011:** Refresh causes updated or repaired disposable artifacts to be represented without restarting the service.
- **AC-012:** The UI remains keyboard usable and preserves story/task/report inspection at narrow viewports.
- **AC-013:** Architecture remains functional and uses shared semantic design tokens rather than its prior hard-coded palette.
- **AC-014:** A deterministic standalone fixture launcher exposes the same backend, registry, routes, parser, and browser assets used by the extension so managed E2E does not require a nested interactive Pi session.

## Domain Language

- Visual Companion is the loopback-only backend and browser shell.
- Viewer is a companion surface selected through the shell; v1 viewers are Story Board and Architecture.
- Story is one canonical work item and is analogous to a Jira epic.
- Task is a persisted ticket belonging to a story.
- Document is canonical intent, specification, design, decision, journey-matrix, or outcome Markdown.
- Report is a canonical evaluation result that remains independently browsable and may be scoped to a task, stage, or story-level checkpoint.
- Evidence is metadata and sanitized copied content recorded under a canonical evaluation evidence resource.
- Persisted status is the phase, state, or task status read from canonical artifacts; it is distinct from future live runtime status.
- Degraded story is a read-only projection that recovers safe metadata from a malformed or historical artifact while exposing local diagnostics.

## Actors

- Developer browsing the current repository
- Architecture visualization caller that opens a companion artifact directly
- Managed E2E evaluator exercising the browser through a deterministic fixture server

## Scenarios

- A developer starts Visual Companion and sees the Story Board shell immediately while story discovery begins in the Story Board content region.
- A developer switches to Architecture during a slow catalog scan and returns after the catalog finishes.
- An architecture caller opens a generated architecture artifact directly and never activates Story Board.
- A developer opens a story, compares tasks across the three traditional columns, and inspects one task in a responsive detail drawer.
- A developer expands only the specification and design documents needed for the current question.
- A developer opens a task-scoped report, reads findings and inline local evidence, follows Go to task, and returns through Related reports.
- A developer repairs a malformed disposable artifact and selects Refresh to replace its degraded card with a healthy projection.
- A managed E2E evaluator launches a deterministic repository fixture, drives the real browser surface, and stops the fixture without requiring another interactive Pi/TUI process.

## Edge Cases

- The repository has no agent-artifacts directory or no stories.
- A story is complete or archived and must sort after active work without being hidden.
- A historical index or task uses legacy fields accepted by the tolerant reader but not the current strict contract.
- A story index, task manifest, document, report, or evidence item is malformed or missing while sibling resources remain valid.
- A task has a failed, protocol-failed, paused, changes-requested, integrating, or cancelled exact status that must remain visible despite simplified column grouping.
- A story has no tasks, documents, reports, or optional document category.
- A report has no task scope, multiple attempts, accepted risk, missing evidence, or an unsupported evidence media type.
- Two browser requests ask for the same unloaded resource concurrently.
- The user leaves a tab while its request remains in flight, returns during loading, or refreshes after a failed load.
- A Markdown document contains raw HTML, scriptable URLs, an external image, or a path traversal attempt.
- The viewport is narrow enough that the desktop detail drawer must become a usable sheet.

## Out of Scope

- Live workflow events, agent activity, elapsed metrics, or parity with the TUI workflow widget
- Private or volatile .pibox runtime records including sessions, transcripts, stdout, stderr, handoffs, locks, and recovery metadata
- Task or story edits, drag-and-drop transitions, workflow approvals, or execution controls
- Continuous filesystem watching for Story Board content
- Serving the companion on non-loopback interfaces
- Automatic artifact migration or repair
- A browser-based raw log explorer
