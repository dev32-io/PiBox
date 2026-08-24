# Task Brief: Render the three-column task board and task details

## Contribution Goal

Turn a selected story into a traditional To do, In progress, and Done Kanban with lazy categorized task inspection and stable deep links.

## Boundary — Included

- Story workspace header and Board/Documents/Reports local navigation scaffold
- Three-column task Kanban with compact empty columns
- Task card metadata and semantic status treatment
- Lazy task detail drawer, close behavior, browser history, and deep-route restoration

## Required Work

- 1. Load the selected story workspace and render breadcrumb/header metadata plus local Board, Documents, and Reports navigation with Board as default.
- 2. Render exactly To do, In progress, and Done lanes and place every returned task card once; compact truly empty lanes without inventing operational columns.
- 3. Render task title, exact status text, dependencies, and stage with semantic warning/error/cancelled styling that also uses text or icon.
- 4. On task selection, request full detail and render labeled sections for brief, acceptance, dependencies, assignment/stage, verification, delivery history, and Related reports links.
- 5. Synchronize selected story/task and drawer close state with encoded history routes so direct task URLs and browser refresh restore the same selection.
- 6. Handle missing/degraded tasks locally and add DOM tests for every column class, exact statuses, one-card membership, lazy detail fetch, drawer history, and workspace errors.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The workspace API returns task cards already mapped to one approved column and a separate lazy task-detail route.
- Exact statuses such as blocked, paused, changes_requested, failed, integrating, and cancelled must remain visible rather than creating extra columns.
- A desktop detail drawer must have correct semantics now; final narrow-sheet and keyboard polish comes later.

## Boundary — Excluded

- Document Markdown and accordions
- Report catalog/detail and evidence
- Final narrow viewport sheet and full keyboard audit
- Editing or drag-and-drop

## Interfaces and Dependencies

- Consumes StoryWorkspace and TaskDetail APIs plus the catalog’s stable story route.
- Produces Board view, local story subnavigation, task-detail routes, and Related reports navigation targets.
