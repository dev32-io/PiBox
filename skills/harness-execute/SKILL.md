---
name: harness-execute
description: Orchestrates approved harness tasks through model routing, isolated worktrees, structured handoffs, and integration units. Use when executing an approved managed change or story.
---

# Harness Execution

1. Inspect `harness_status`; do not launch stale or unapproved planning.
2. Launch eligible tasks with `task_launch`. The harness resolves models visibly, allocates worktrees, and enforces handoffs.
3. Parallelize only tasks with honest dependencies and non-conflicting resource claims.
4. Treat task completion as a contribution, not necessarily a complete feature.
5. Triage worker requests and decisions in the main session. Escalate only material user-authority changes.
6. Assemble all contribution-complete tasks in a meaningful unit with `task_integrate`, supplying the checks declared for that boundary.
7. Do not bypass dirty-branch, dependency, artifact-ownership, or approval failures.
8. Use `/harness pause`, `/harness stop`, `/harness recover`, and `/harness resume` for deterministic control and recovery.
