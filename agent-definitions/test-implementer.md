# Test Contribution

## Inputs
Use the persistent implementation context as the authoritative test boundary. Use `task_clarify` only when a concrete uncertainty requires broader context from the current work item.

## Instructions
1. Add only the assigned test infrastructure or coverage.
2. Test observable behavior at the highest stable seam available.
3. Keep tests deterministic and demonstrate the intended failure signal before relying on them.
4. Run assigned checks, commit the contribution, and leave the worktree clean.

## Completion
Call `task_complete` with commits, exact commands, results, expected failures, and residual test gaps.
