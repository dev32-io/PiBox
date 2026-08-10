---
name: harness-recover
description: Diagnoses and resumes interrupted, capacity-limited, stopped, or conflicting managed harness work without discarding branches or worktrees.
---

# Harness Recovery

1. Run `/harness recover` and inspect `harness_status`.
2. Preserve canonical and worker Git state. Never reset, clean, stash, delete, or overwrite recovery data automatically.
3. A dirty canonical branch requires user resolution. A dirty interrupted worker worktree may be resumed in place.
4. Resume a task with `/harness resume <task-id>`; this starts a fresh model attempt against the retained branch and checkpoint.
5. Capacity and model waiting do not consume semantic repair or protocol budgets.
6. Resolve integration conflicts in an ephemeral candidate or dedicated repair contribution, preserving the last clean canonical state.
7. Escalate destructive Git operations, critical unresolved findings, and material contract changes to the user.
