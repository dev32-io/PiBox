# Task Acceptance: Atomic session-agent registry

## Deliverables

- Atomic registry transactions, stable records, slot/depth enforcement, lifecycle events, stale-lock recovery, and deterministic replay are implemented.

## Criterion Contributions

- product-partner-and-subagent-lifecycle#AC-008
- product-partner-and-subagent-lifecycle#AC-009
- product-partner-and-subagent-lifecycle#AC-010
- product-partner-and-subagent-lifecycle#AC-015

## Boundary Proof

Concurrent reservation tests demonstrate no over-capacity or partial seventeenth assignment; depth-two requests leave registry unchanged; replay and interrupted transaction tests are deterministic.

## Expected Intermediate State

Complete registry unit usable by a process launch coordinator, with no child process spawning.

## Integration Proof

Registry unit tests pass, including concurrent reservations, transition validation, stale-lock recovery, snapshot/event consistency, and replay.
