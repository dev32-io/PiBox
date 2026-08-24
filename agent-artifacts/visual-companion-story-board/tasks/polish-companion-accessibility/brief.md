# Task Brief: Polish responsive, keyboard, and visual consistency

## Contribution Goal

Complete the shared shell, Story Board, Markdown, Reports, and Architecture interaction system for desktop and narrow keyboard-driven use.

## Boundary — Included

- Responsive layouts for catalog, Kanban, documents, reports, evidence, and Architecture
- Shared drawer-to-sheet behavior and overflow handling
- Complete keyboard order, activation, focus management, labels, and reduced-motion support
- Cross-view design-token cleanup and deterministic UI smoke coverage

## Required Work

- 1. Audit every shell and Story Board surface for token-only shared styling, consistent spacing/radii/borders/elevation, readable density, long-title wrapping, empty states, and restrained motion.
- 2. Implement responsive breakpoints so the story catalog remains readable, Kanban lanes scroll/stack intentionally, Markdown does not overflow, and task/report/Architecture details become a full-height accessible sheet rather than disappearing.
- 3. Complete keyboard behavior for top tabs, story rows, local story tabs, task cards, accordions, report items, filters, Refresh, drawer/sheet close, and return-focus restoration.
- 4. Add semantic labels, selected/expanded/busy/error states, live-region usage limited to meaningful loading/errors, visible focus rings, reduced-motion handling, and text/icon status cues.
- 5. Ensure tab/view switching preserves usable local state without duplicate listeners and that deep links remain functional at desktop and narrow widths.
- 6. Add deterministic DOM/accessibility/responsive tests and a fixture-backed smoke script that checks representative routes without replacing final Playwright evaluation.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Feature behavior is assembled; this final implementation contribution owns cross-view consistency rather than new data or routes.
- The approved system uses a 68px header, approximately 1180px story width, 288px lanes, 464px drawer, restrained borders/elevation/motion, and a full-height narrow detail sheet.
- Essential Architecture details must not disappear below 820px, and status meaning cannot rely on color alone.

## Boundary — Excluded

- New Story Board features, routes, or artifact fields
- Live workflow status or continuous watching
- Theme switching
- Final evaluator execution or evaluation artifacts

## Interfaces and Dependencies

- Consumes the complete shell, viewers, fixture launcher, design tokens, and browser modules.
- Produces the final responsive/accessibility behavior that the whole-branch reviewer and six-case E2E evaluator inspect.
