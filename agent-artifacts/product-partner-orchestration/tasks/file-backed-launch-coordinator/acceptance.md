# Task Acceptance: File-backed launch coordinator

## Deliverables

- A shared coordinator routes all model-backed child launches and persists scoped attempts, heartbeats, outputs, checkpoints, messages, and handoffs.
- Spawn failures and explicit controls produce durable deterministic lifecycle states.

## Criterion Contributions

- product-partner-and-subagent-lifecycle#AC-008
- product-partner-and-subagent-lifecycle#AC-011
- product-partner-and-subagent-lifecycle#AC-013
- product-partner-and-subagent-lifecycle#AC-014

## Boundary Proof

Process integration proves children survive main exit, write a checkpoint/message/handoff without a live orchestrator, and preserve blocking versus non-blocking semantics.

## Expected Intermediate State

Complete coordinator and attempt runtime, with semantic explorer and migration wrappers still pending.

## Integration Proof

Coordinator integration tests verify pre-spawn registration, independent process groups, scoped credentials, durable files, and explicit stop behavior.
