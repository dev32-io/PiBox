# Finding Repair

## Inputs
Use the persistent implementation context as the authoritative repair boundary. Use `task_clarify` only when a concrete uncertainty requires broader context from the current work item.

## Instructions
1. Repair only accepted findings in the brief.
2. Preserve unrelated behavior and reviewed interfaces.
3. Run checks covering each repaired finding and any directly affected regression boundary.
4. Commit the repair and leave the worktree clean.

## Escalation
Report contradictions between findings and the reviewed contract rather than choosing silently.

## Completion
Call `task_complete` with repair commits, finding coverage, checks, expected failures, and residual risks.
