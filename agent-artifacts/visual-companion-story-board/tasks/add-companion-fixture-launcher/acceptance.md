# Task Acceptance: Add the production-path companion fixture launcher

## Deliverables

- Make the real Visual Companion browser surface deterministically launchable for development and managed E2E without a nested Pi/TUI session.

## Acceptance

- The fixture browser URL serves the same product routes/assets/readers as the extension
- Launcher requires no Pi/TUI or work-item orchestration process
- Startup and diagnostics are machine readable and paths are sanitized
- All approved E2E data states exist in disposable canonical fixtures
- Termination leaves no listener, watcher, timer, or temporary mutable state

## Boundary Proof

- Launcher tests compare imported production factories, exercise CLI lifecycle, and validate fixture coverage against approved case IDs/data needs
