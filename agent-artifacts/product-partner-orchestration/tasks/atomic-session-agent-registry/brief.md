# Task Brief: Atomic session-agent registry

## Contribution Goal

Implement the private session-scoped registry with stable identity, depth-one enforcement, sixteen-slot accounting, atomic locking, deterministic transitions, event sequencing, and replay.

## Boundary — Included

- Repository/session registry identity and private layout.
- Logical agent records, active-slot reservation, depth validation, lifecycle transitions, stale-lock recovery, snapshots, and ordered events.
- Deterministic registry APIs and runtime/unit tests.

## Required Work

- Implement cross-process mutex transactions and atomic snapshot replacement.
- Enforce depth and capacity before process creation.
- Retain nonterminal history and release slots only on terminal states.

## Integration Expectation

Integrates as the registry unit before coordinator, explorer, and migration work; its public runtime interface is the sole lifecycle ledger.

## Boundary — Excluded

- Child process spawning and file-backed attempt I/O.
- Explorer assignment semantics and managed task/evaluation migration.

## Interfaces and Dependencies

Consumes the lifecycle specification, orchestration design, active-agent-slot-accounting decision, and background-agent-liveness decision; exports registry reservation, transition, listing, and reconciliation primitives to the launch coordinator.

## Constraints

- Private runtime state stays outside Git.
- A child cannot reserve or spawn another child.
- PID alone cannot establish process identity.
