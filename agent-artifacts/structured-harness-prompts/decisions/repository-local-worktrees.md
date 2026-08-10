# Repository-Local Worktrees

## Decision

Store newly allocated harness task worktrees under the canonical repository root at:

```text
<repository>/.worktree/pibox/<work-item-id>/<task-id>/
```

The repository must ignore `/.worktree/`. Harness initialization adds that root-anchored rule to `.gitignore` when an equivalent rule is not already effective and commits it together with the repository policy. If an existing initialized repository lacks an effective ignore rule, the preparation path adds and commits only the missing ignore entry while the canonical branch is clean.

Worktree allocation verifies the target is ignored with Git before creating it. If it is not ignored, allocation fails with a harness-level diagnostic and preparation instructions rather than creating an untracked directory or silently modifying an approved execution branch.

Private operational state—credentials, transcripts, run records, locks, event logs, and receipts—remains under `~/.pi/agent/harness/`. Only Git worktree checkouts move into the repository-local ignored root.

Existing externally stored worktrees remain recoverable at the paths recorded in task runtime metadata. They are not moved, deleted, or rewritten automatically. New allocations use the repository-local path.

## Context

The current manager stores task worktrees under `~/.pi/agent/harness/worktrees/<repo-id>/...`. A checkout is repository-specific working material, not private global harness state. Keeping it outside the repository obscures disk usage, complicates project-local inspection and cleanup, and separates the checkout from the repository that owns it.

## Rationale

A repository-local ignored root makes isolated task checkouts visible and attributable to the project while keeping canonical Git status clean. The `pibox` namespace avoids collisions with other tools that also use `.worktree/`. Root anchoring prevents accidental matching of similarly named nested directories. Explicit preparation preserves the rule that managed execution does not mutate an approved canonical branch implicitly.

## Consequences

- `WorktreeManager.worktreeRoot` resolves from `RepositoryIdentity.root` instead of private harness state.
- Scaffold and preparation behavior must update `.gitignore` safely and idempotently.
- Allocation must prove the target path is ignored before `git worktree add`.
- Linked-worktree sessions still allocate beneath the canonical primary repository root returned by repository discovery.
- Recovery trusts each task's recorded runtime path, supporting both legacy external and new local worktrees.
- Documentation and E2E path assertions change.
- Repository deletion also removes its local task checkouts; private run history remains available separately.

## Alternatives Considered

- Continue using the global home-directory worktree root. Rejected because checkouts are project-owned working material rather than private harness state.
- Use `.git/info/exclude`. Rejected as the default because it is invisible to collaborators and repository scaffolding, though an already effective ignore rule may come from any Git-supported ignore source.
- Auto-move existing worktrees. Rejected because moving registered Git worktrees and active processes is destructive and recovery-sensitive.
- Place task worktrees directly under `.worktree/<work-item>`. Rejected to avoid collisions with other repository tooling; `.worktree/pibox/` remains clearly harness-owned.
