---
name: harness-execute
description: Use when a managed work item has current direct user approval and executable contributions.
---

# Harness Execution

## Instructions

1. Confirm current approval, including any audited retain-approval amendments, and launch only ready contributions.
2. Parallelize only when dependencies and resource claims permit it.
3. Treat each task as a contribution; preserve declared partial intermediate states.
4. Resolve worker requests from canonical context. Normally decide, apply any coherent resource changes through `harness_apply_change` with `retain-approval`, respond, and resume the same logical assignment. Pause for the user only when the change materially alters their outcome, explicit constraints, consequential policy, privacy/security posture, irreversible effects, or a decision they retained.
5. Integrate all required contributions at their declared integration unit.
6. Run the unit's declared checks before advancing the canonical branch.
7. Preserve branches, worktrees, checkpoints, and evidence on interruption or failure.

## Completion

Execution is complete when required contributions are integrated at coherent boundaries with their declared checks recorded. Continue to planned evaluation rather than making a completion claim.
