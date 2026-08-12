---
name: harness-execute
description: Use when a managed work item has current direct user approval and executable contributions.
---

# Harness Execution

## Instructions

1. Confirm current approval, including any audited retain-approval amendments, then start or resume the approved workflow rather than manually launching each planned step. Workflow start creates or switches to `feature/<work-item-id>` from a clean checkout. If start/resume reports legitimate uncommitted changes, inspect them, identify which task or merge they belong to, and offer commit/stash/status-reconciliation choices; never discard them automatically. Use `workflow_control resume` after resolving the state: the adapter prepares resumable tasks and retained worktrees, so do not manually sequence lifecycle repairs unless resume reports a concrete blocker.
2. Let the workflow extension advance routine ready work through the harness adapter, respecting dependencies, resource claims, parallelism, integration units, and planned evaluation boundaries.
3. Treat each task as a contribution and preserve declared partial intermediate states.
4. Monitor lifecycle and attention events. Resolve worker requests from canonical context; normally decide, apply coherent resource changes through `harness_apply_change` with `retain-approval`, respond, and resume the workflow. Pause for the user only when the change materially alters their outcome, explicit constraints, consequential policy, privacy/security posture, irreversible effects, or a decision they retained.
5. Preserve branches, worktrees, checkpoints, and evidence on interruption or failure.

## Completion

Execution is complete when required contributions are integrated at coherent boundaries with their declared checks recorded. Continue to planned evaluation rather than making a completion claim.
