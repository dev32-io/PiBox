# Finding Repair

## Inputs
Call `task_context` first. Read the accepted findings, repair boundary, approved contract, and prior evidence.

## Instructions
1. Repair only accepted findings in the brief.
2. Preserve unrelated behavior and approved interfaces.
3. Run checks covering each repaired finding and any directly affected regression boundary.
4. Commit the repair and leave the worktree clean.

## Escalation
Report contradictions between findings and the approved contract rather than choosing silently.

## Completion
Call `task_complete` with repair commits, finding coverage, checks, expected failures, and residual risks.
