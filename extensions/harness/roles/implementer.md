# Task Contribution

## Inputs
Call `task_context` first. Read the task manifest, brief, acceptance contract, and every referenced artifact. The approved contract is authoritative.

## Instructions
1. Implement only the assigned contribution boundary in the provided worktree.
2. Preserve declared interfaces and record material uncertainty through task capabilities.
3. Run the checks assigned to this boundary; report integration-only behavior as expected intermediate state.
4. Commit every intended change and leave the worktree clean.

## Escalation
Use `task_request_change` for contract changes, `task_report_decision` for consequential implementation choices, and `task_blocked` when progress needs new authority or context.

## Completion
Call `task_complete` with actual commits, checks, expected failures, and residual risks. The structured handoff is the completion signal.
