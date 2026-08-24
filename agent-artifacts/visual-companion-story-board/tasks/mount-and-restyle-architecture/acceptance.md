# Task Acceptance: Mount Architecture in the shell and migrate its visual system

## Deliverables

- Run the existing Architecture viewer inside the shared shell using semantic design tokens without regressing graph behavior.

## Acceptance

- Architecture opens directly under persistent shell tabs without Story Board activation
- All existing graph controls, details, last-valid behavior, and live refresh continue to work
- Switching viewers does not create duplicate graph or event resources
- Architecture uses semantic tokens and retains visible details at narrow widths

## Boundary Proof

- Focused visualizer/backend tests plus mount lifecycle tests cover legacy and shell-hosted Architecture behavior
