# Task Acceptance: Wire idempotent Visual Companion service lifecycle

## Deliverables

- Make /services start, status, and stop visual-companion operate one shell-first session backend while preserving direct Architecture launch.

## Acceptance

- The existing /services start|status|stop visual-companion interface works without a new command
- Repeated start reuses one backend and reopens its URL
- Direct Architecture opening reuses the backend and selects Architecture
- No Story Board discovery is invoked by backend or service startup
- Stop and session shutdown leave the service stopped with no live resources

## Boundary Proof

- Lifecycle tests capture controller registration, backend factory counts, browser URLs, service snapshots, and close calls
