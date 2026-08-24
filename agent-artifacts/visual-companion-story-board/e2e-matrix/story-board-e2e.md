# Visual Companion Story Board E2E matrix

## Cases

### E2E-001 — Developer uses the shell while Story Board loads asynchronously

**Classification:** golden-path

#### Setup

- Launch the production-path Visual Companion fixture server on a random loopback port against a disposable repository containing several healthy stories
- Configure the fixture discovery seam to remain observably in flight long enough to exercise navigation without changing product rendering behavior

#### Actions

- Open the fixture URL in a browser
- Observe the Story Board loading state
- Switch to Architecture before catalog loading completes
- Return to Story Board after loading settles

#### Expected Outcomes

- The shell and both top-level tabs render before the story catalog is ready
- The loading indicator is contained within Story Board and never blocks tab interaction
- Architecture becomes usable while Story Board remains in flight
- Returning to Story Board shows each expected story once in deterministic active-before-complete ordering
- No Story Board discovery occurs before the browser first activates Story Board

#### Evidence

- Browser screenshots of initial loading, Architecture during loading, and completed catalog
- Browser-visible story titles and statuses compared with the disposable canonical fixture
- Bounded fixture diagnostic proving the hidden invariant that discovery began only after Story Board activation

#### Safety

- Use only a disposable fixture repository and random loopback port
- Terminate the fixture server and retain no browser credentials

### E2E-002 — Developer browses a story, its traditional task board, and grouped documents

**Classification:** golden-path

#### Setup

- Use a disposable healthy story containing tasks that map to To do, In progress, and Done plus intent, multiple specifications, design, decisions, journey cases, and outcome documents

#### Actions

- Select the story from the catalog
- Inspect the Board columns and exact task status badges
- Open one task and inspect each available detail category
- Refresh the task deep URL
- Open Documents and expand selected categories and individual files

#### Expected Outcomes

- The story workspace exposes Board, Documents, and Reports navigation
- Each task appears exactly once in To do, In progress, or Done according to the approved mapping
- Blocked, paused, changes-requested, failed, integrating, and cancelled meanings remain visible through exact text badges rather than extra columns
- Task detail is categorized and remains selected after browser refresh of its local deep URL
- Documents are grouped under the approved semantic categories, missing categories are omitted, and bodies render as readable Markdown only when expanded

#### Evidence

- Desktop screenshot of the complete three-column board
- Task detail screenshot and refreshed local URL
- Rendered Markdown from representative document categories compared with fixture source

#### Safety

- Do not expose edit or drag-and-drop controls
- Keep all interactions read-only against disposable artifacts

### E2E-003 — Developer reads independent reports and follows bidirectional task and evidence links

**Classification:** golden-path

#### Setup

- Use a disposable story containing task-scoped and story-scoped reports, multiple attempts, findings, risk acceptance, textual evidence, a canonical copied image, missing evidence, and an external image URL

#### Actions

- Open the story Reports view
- Open the story-scoped report and then a task-scoped report
- Inspect findings, history, risk acceptance, text evidence, and the local image rendered through Markdown
- Use Go to task from the task-scoped report
- Use Related reports from the task detail
- Attempt to open the missing evidence item and observe the external image reference

#### Expected Outcomes

- Reports remain first-class list items and clearly identify scope, result, attempts, findings, and evidence
- Canonical text and local image evidence render through the shared safe Markdown presentation
- Go to task opens the correct task and Related reports returns to the related report
- Missing evidence has a clear unavailable state without breaking report content
- The external image does not auto-load and arbitrary filesystem paths are not exposed

#### Evidence

- Reports catalog and report-detail screenshots
- Bidirectional browser URLs and task/report titles
- Rendered canonical image and textual evidence
- Browser network observation showing no external image request

#### Safety

- Evidence is served only from disposable canonical copied evidence storage
- Do not follow external links or access paths outside the fixture repository

### E2E-004 — Developer recovers from malformed historical artifacts with Refresh

**Classification:** recovery

#### Setup

- Launch the fixture server against a disposable repository containing healthy stories plus malformed story index, task, document, and report fixtures
- Retain valid replacement fixture contents for one malformed story

#### Actions

- Load Story Board and inspect healthy and degraded entries
- Open the degraded story and inspect localized diagnostics
- Replace the malformed disposable content with its valid counterpart
- Select Refresh
- Navigate to Architecture during the replacement scan and return

#### Expected Outcomes

- Healthy stories and valid sibling resources remain usable despite malformed artifacts
- The malformed story remains visible with recovered metadata and an Artifact needs attention indication
- Diagnostics identify the affected resource without leaking unrestricted filesystem paths
- Refresh invalidates Story Board cache and reparses asynchronously without blocking Architecture
- The repaired story replaces its degraded projection without service restart
- No source artifact is rewritten by browsing or parsing

#### Evidence

- Before-and-after catalog and diagnostic screenshots
- Checksums or Git status proving viewer reads did not modify fixture artifacts
- Browser observation of responsive navigation during Refresh

#### Safety

- Modify only disposable fixture copies
- Restore or remove the fixture and stop its server after the case

### E2E-005 — Architecture visualization remains functional under the shared shell

**Classification:** edge

#### Setup

- Launch the production-path fixture server with a valid architecture artifact and Story Board fixture
- Open a shell route that selects Architecture directly

#### Actions

- Confirm Architecture is selected without first opening Story Board
- Change graph view and layout
- Toggle groups, fit the diagram, and select node and edge details
- Change the disposable architecture artifact to exercise its existing live refresh behavior
- Switch to Story Board and back

#### Expected Outcomes

- Direct Architecture opening renders the shared shell and does not initiate Story Board parsing
- Existing graph controls, pan and zoom, selection details, and last-valid/live-refresh behavior remain functional
- Architecture and shell components consume the shared semantic neutral design tokens without the prior hard-coded palette
- Switching viewers preserves usable viewer state and does not create a second backend

#### Evidence

- Architecture desktop screenshot showing shared shell and neutral visual system
- Browser observations for controls, details, and artifact refresh
- Bounded server diagnostic confirming one backend and deferred Story Board discovery

#### Safety

- Use a disposable architecture artifact and loopback server
- Remove the artifact and terminate the fixture server

### E2E-006 — Developer navigates Story Board with a keyboard and narrow viewport

**Classification:** edge

#### Setup

- Use a representative healthy story with tasks, documents, and reports
- Open the fixture in a desktop browser and prepare a narrow mobile-sized viewport

#### Actions

- Navigate top-level tabs, story entries, local story views, task cards, accordions, report items, drawer controls, and Refresh using only the keyboard
- Repeat story and task inspection at the narrow viewport
- Inspect statuses in normal and warning/error states

#### Expected Outcomes

- Interactive elements have a logical focus order, visible focus treatment, meaningful labels, and supported keyboard activation
- Task and report details become a usable full-height sheet at the narrow viewport rather than disappearing
- Story documents and report Markdown remain readable without hidden essential controls
- Status meaning is conveyed by text or icon in addition to semantic color
- The shared neutral design system uses consistent typography, spacing, borders, radii, restrained elevation, and motion across Story Board and Architecture

#### Evidence

- Desktop keyboard-focus screenshots
- Narrow-viewport catalog, board, and detail-sheet screenshots
- Recorded keyboard actions and visible outcomes for each major interaction

#### Safety

- Perform read-only interaction against disposable fixtures
- Do not retain browser data after the journey

## Scope

- Browser-visible Visual Companion shell and viewer navigation
- Asynchronous lazy Story Board catalog and nested workspace
- Three-column task board, Documents, Reports, and canonical evidence presentation
- Degraded-artifact recovery through manual Refresh
- Architecture behavior under the shared shell
- Responsive and keyboard-accessible interaction through the production-path fixture launcher

## Safety

- All browser journeys bind only to a random loopback port
- The fixture launcher must compose the same production backend, registry, routes, readers, projector, Markdown assets, and viewer UI as the extension
- Every journey uses disposable canonical artifacts and cleans up its server and temporary files
- Service controller lifecycle, parser unit behavior, cache semantics, path containment, and sanitizer internals are verified deterministically outside this user-journey matrix
