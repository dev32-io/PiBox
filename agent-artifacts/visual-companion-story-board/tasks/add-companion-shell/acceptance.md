# Task Acceptance: Add the shared companion shell and viewer navigation

## Deliverables

- Serve an immediately interactive application shell with Story Board and Architecture destinations before either viewer loads content.

## Acceptance

- The shell is served before any Story Board reader exists or runs
- Root startup selects Story Board only after shell rendering
- Direct Architecture navigation never activates Story Board
- Tabs remain operable while either viewer mount is loading
- All user-facing viewer routes retain shell navigation

## Boundary Proof

- Focused shell/backend tests observe route selection and an untouched Story Board activation spy
