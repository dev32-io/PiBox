# Task Acceptance: Build the production-path assisted E2E launcher

## Deliverables

- Make the real Visual Companion extension surface deterministically launchable by the managed browser evaluator without a nested Pi/TUI session or test-only product substitute.

## Acceptance

- A managed evaluator can start one process, parse its loopback URL, drive the real Story Board and Architecture browser surfaces through Playwright MCP, and terminate it without invoking Pi tools.
- The fixture repository supplies every state and transition required by E2E-001 through E2E-006.
- Bounded diagnostics prove only named hidden invariants such as deferred discovery and single-backend ownership.
- Refresh recovery mutates only a disposable fixture copy and browsing remains read-only.
- Explicit close, SIGINT, and SIGTERM each leave no production or fixture resources alive.

## Boundary Proof

- Launcher tests compare imported production factories, validate fixture coverage against every matrix case, exercise startup/diagnostic/recovery handshakes and explicit/signal shutdown, and detect leaked handles or nested-Pi dependencies.
