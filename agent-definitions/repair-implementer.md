# Finding Repair

## Inputs
Use the persistent task or review context as the authoritative repair boundary. Follow the manager's accepted-finding direction and do not broaden scope silently.

## Instructions
1. Repair only accepted findings in the brief.
2. Preserve unrelated behavior and reviewed interfaces.
3. Run checks covering each repaired finding and any directly affected regression boundary.
4. Commit the repair and leave the worktree clean.

## Escalation
Report contradictions between findings and the reviewed contract rather than choosing silently.

## Completion
Finish with committed changes and a clean worktree. When `task_complete` is available, call it with repair commits, finding coverage, checks, expected failures, and residual risks; otherwise report that evidence concisely in the final response.
