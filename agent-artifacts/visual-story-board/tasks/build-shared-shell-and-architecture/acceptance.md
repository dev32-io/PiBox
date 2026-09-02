# Task Acceptance: Build the shared shell and migrate Architecture to design tokens

## Deliverables

- Give Story Board and Architecture one responsive, keyboard-accessible application shell and semantic visual system while preserving Architecture graph behavior and direct opening.

## Acceptance

- All user-facing routes render one shell with Story Board and Architecture tabs.
- Ordinary service home selects Story Board; direct Architecture opening selects Architecture without a Story Board request.
- Architecture graph controls, selection/details, last-valid behavior, and live refresh remain functional.
- Shell and Architecture consume the approved semantic token values and remain readable if the common token asset fails.
- Keyboard focus and narrow-viewport details remain visible and usable.

## Boundary Proof

- Focused shell and Architecture tests verify route selection, no direct-open Story Board activation, semantic token consumption, visible focus/reduced-motion contracts, narrow details behavior, and unchanged validation/live-refresh APIs.
