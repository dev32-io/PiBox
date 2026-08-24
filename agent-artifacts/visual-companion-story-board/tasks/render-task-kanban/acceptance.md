# Task Acceptance: Render the three-column task board and task details

## Deliverables

- Turn a selected story into a traditional To do, In progress, and Done Kanban with lazy categorized task inspection and stable deep links.

## Acceptance

- The story workspace exposes Board, Documents, and Reports navigation
- Exactly three lanes render and every task appears once with raw status text
- Task detail loads only after selection and is grouped by approved labels
- Direct story/task routes survive refresh and close/back behavior is predictable
- No editing or drag-and-drop control exists

## Boundary Proof

- DOM tests cover all mapping categories, exact status badges, lazy detail requests, history restoration, and task/report target generation
