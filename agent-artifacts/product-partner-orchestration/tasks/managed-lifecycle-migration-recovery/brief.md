# Task Brief: Managed lifecycle migration and recovery

## Contribution Goal

Migrate managed tasks, evaluations, repairs, direct specialists, approval, integration, and completion lifecycle paths onto the shared coordinator and add idempotent resume reconciliation without breaking legacy records.

## Boundary — Included

- Semantic wrapper migration for managed launch paths.
- Session resume identity, handoff/message reconciliation, live/dead/ambiguous process handling, waiting and recovery states.
- Compatibility, approval, worktree, schema-v1, canonical protection, and final background-resume lifecycle coverage.

## Required Work

- Reconcile valid handoffs before liveness, preserve positively identified live children, interrupt confirmed-dead children, and block ambiguous duplicates.
- Surface blocking messages before dependent execution and support durable response plus later attempt.
- Retain legacy run records and enforce existing lifecycle gates and protections.

## Integration Expectation

Final integration unit assembles all five contributions and is the only boundary for background-resume E2E, lifecycle regression, and work-item completion evidence.

## Boundary — Excluded

- Final fleet dashboard or management TUI.
- Changing canonical authority or automatically applying worker-proposed contract changes.

## Interfaces and Dependencies

Depends on atomic-session-agent-registry, file-backed-launch-coordinator, and typed-explorer-protocol; integrates product-partner-prompt-contracts scenarios into the final lifecycle regression and consumes all canonical decisions for capacity and liveness.

## Constraints

- Reconciliation is idempotent.
- Private runtime data remains outside Git and legacy records are not moved or deleted.
