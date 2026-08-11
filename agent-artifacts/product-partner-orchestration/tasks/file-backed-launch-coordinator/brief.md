# Task Brief: File-backed launch coordinator

## Contribution Goal

Route all model-backed child launches through one coordinator that creates scoped independent process attempts, durable files, credentials, heartbeats, checkpoints, messages, and handoffs.

## Boundary — Included

- Shared launch input and semantic wrapper integration for direct specialists, explorers, tasks, evaluators, and repairs.
- Process-attempt identity, scoped output/transcript files, heartbeat, credentials, checkpoint and handoff writes.
- Background continuation, explicit stop control, spawn failure, and attempt lifecycle behavior.

## Required Work

- Reserve and register through the atomic registry before spawning.
- Remove dependence on parent pipes, in-memory callbacks, and synchronous main-session RPC.
- Persist durable worker messages and typed handoffs without canonical mutation authority.

## Integration Expectation

Integrates after the registry unit as the launch-coordinator boundary; semantic public capabilities remain wrappers over this coordinator.

## Boundary — Excluded

- Registry transaction implementation.
- Explorer mode schemas and managed lifecycle reconciliation policy.

## Interfaces and Dependencies

Depends on atomic-session-agent-registry for reservation, identity, transitions, and slot ownership; exports the shared coordinator and file-backed attempt interfaces to typed explorer and lifecycle migration.

## Constraints

- Children continue after main-process exit.
- Credentials authorize only immutable assignment scope, private records, structured messages/handoffs, and assigned workspace.
