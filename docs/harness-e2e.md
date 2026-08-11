# Harness E2E Exercise: local todo

**Repository:** `~/Development/todoTest`  
**Scenario:** scaffold an empty Git repository with the economy profile, plan a small pure-local HTML todo list, require direct approval, execute it in a task worktree, assemble it, run a fresh combined evaluation, and complete the work item.

## Session-registry and background-child regression

A focused lifecycle exercise verified the unified subagent runtime:

1. A typed `map` explorer launched through the session registry and returned a validated `exploration_complete` handoff with exact evidence.
2. The main Pi process was forcibly terminated after another explorer entered `running`; the detached child continued with file-backed output and wrote its handoff after the parent was gone.
3. A managed implementation child likewise finished after its launching print-mode parent exited. Reconciliation found the durable task handoff, validated its retained clean worktree and commits, and advanced it to `contribution_complete` without rerunning it.
4. A new main session integrated that contribution, launched a registry-backed evaluator, recorded a passing verdict, and completed the work item.

This verifies that parent-owned pipes are not authoritative, logical-agent identity survives process attempts, and handoff-first reconciliation avoids duplicate writers.

## Final result

The harness completed `local-todo` with:

- Repository-local economy policy committed at `.pi/harness.yaml`.
- Canonical intent, behavior spec, design, task, integration unit, evaluation, evidence, and outcome.
- One implementation child using `openai-codex/gpt-5.6-luna`.
- One isolated task branch and worktree.
- Declared integration checks run automatically from `task.yaml`.
- One integration-unit commit on the canonical branch.
- One fresh combined evaluator using Luna.
- Checksummed evidence copied into `agent-artifacts/local-todo/evidence/`.
- Deterministic completion with the remaining low-severity accessibility finding appended to `outcome.md`.
- Clean canonical and worker Git state.

## Issues discovered and fixed

1. **Provider-native tool-call IDs were rejected.** OpenAI Codex IDs contain `|`, but idempotency initially used a path-safe regex. Operation records now hash arbitrary bounded provider IDs into safe filenames.
2. **Task planning accepted unknown roles and raw model IDs.** `task_define` now validates configured role names, model aliases, and role workspace requirements before committing planning.
3. **Economy routing could be bypassed by an explicit planned alias.** The economy scaffold now maps all built-in aliases to Luna at capability rank 100, so task-level `sol` or `terra` choices still resolve to the explicitly configured economy model.
4. **Task checks could be prose or silently omitted during integration.** Tool descriptions now require shell commands, and integration defaults to the checks declared by all tasks in the unit.
5. **Filename-like resource claims failed path validation.** Resource claims are now bounded opaque strings stored under hashed lock paths, so values such as `index.html` are valid without permitting path traversal.
6. **A malformed Luna tool call streamed whitespace indefinitely.** The lifecycle hook now aborts a tool-call argument after 16 KiB of whitespace-only streaming.
7. **Evaluator capabilities were accidentally disabled.** Evaluator processes also have run IDs and were misclassified as workers. Process classification now uses task/evaluation scope variables independently.
8. **Child session events caused duplicate repository event sequence numbers.** Worker and evaluator processes now write their run-scoped logs only; repository-level session events remain orchestrator-owned.
9. **Evaluator transcripts were not retained.** Managed evaluator event streams now persist to their private run transcript.
10. **Tiny runs produced oversized transcripts.** Streaming deltas are no longer duplicated in private transcripts; durable message/tool terminal events are queued and flushed in order.
11. **Tool failures could look like successful results.** Harness capabilities now throw on mechanical failure, allowing Pi to mark tool results as errors and discouraging model workarounds.
12. **Remaining non-blocking findings could be omitted from the outcome prose.** Completion now appends unresolved non-blocking findings deterministically.

## Verification artifacts

Canonical records are in:

```text
~/Development/todoTest/agent-artifacts/local-todo/
```

Private run records are in:

```text
~/.pi/agent/harness/repositories/<repo-id>/work-items/local-todo/runs/
```

This pre-migration exercise used the legacy task-worktree path:

```text
~/.pi/agent/harness/worktrees/<repo-id>/local-todo/implement-local-todo/
```

New allocations use `<repository>/.worktree/pibox/<work-item>/<task>/`; legacy recorded paths remain recoverable.

The exercise intentionally used the small economy profile to reduce model cost while still covering configuration merge, approval, child capability loading, task completion, integration, independent evaluation, evidence, and final completion.
