# Workflow E2E Exercise: local todo

**Repository:** `~/Development/todoTest`  
**Scenario:** scaffold an empty Git repository with the economy profile, plan a small pure-local HTML todo list, require direct approval, execute it in a task worktree, assemble it, run a fresh combined evaluation, and complete the work item.

## Session-registry and background-child regression

A focused lifecycle exercise verified the unified subagent runtime:

1. A typed `map` explorer launched through the session registry and returned a validated `exploration_complete` handoff with exact evidence.
2. The main Pi process was forcibly terminated after another explorer entered `running`; the detached child continued with file-backed output and wrote its handoff after the parent was gone.
3. A managed implementation child likewise finished after its launching print-mode parent exited. Reconciliation found the durable task handoff, validated its retained clean worktree and commits, and advanced it to `contribution_complete` without rerunning it.
4. A new main session integrated that contribution, launched a registry-backed evaluator, recorded a passing verdict, and completed the work item.
5. A worker in one persistent RPC session emitted a blocking color-selection change request and exited. Both the compatibility `agent_respond` path and the preferred `workflow_apply_change` response transaction were exercised. Relaunch reused the same logical agent and reserved slot, created process attempt two with the durable response, committed the selected value, and completed successfully.

This verifies that parent-owned pipes are not authoritative, logical-agent identity survives process attempts, and handoff-first reconciliation avoids duplicate writers.

## Background workflow regression

A fresh Luna workflow started through `workflow_start` and returned control to the main session in 13.83 seconds while its implementation child was still running. The independent workflow extension then refreshed harness adapter state, accepted the task handoff, integrated the declared unit and checks, launched the planned deterministic evaluator, and recorded a passing verdict after 65.00 seconds total. The canonical repository and task worktree were clean. This demonstrates that the main session is no longer held inside a multi-minute task tool call while deterministic workflow progression continues in the background.

## Persistent implementer context regression

A fresh Luna task received its brief, acceptance contract, referenced specification, expected contribution state, and required check through the system prompt. Its action prompt contained only the task identity, repository-inspection direction, required check, and completion signal. The first turn inspected the repository with `bash` and `find`; routine implementation made zero `task_clarify` calls. Luna created the exact proof file, ran the assigned check, committed it, left a clean worktree, and completed the supervised handoff. Unit coverage also verifies that role instructions and persistent context are combined in Pi's appended system prompt, which remains present across compaction.

## Resource-oriented planning and amendment regression

A real `todoTest` session exposed an unnecessary single-resource coalescing commit: a valid task-model patch committed its change, then attempted a second no-op revision commit and failed. Single-resource mutations now commit directly. Model-supplied revision tokens, contract hashes, and runtime revision-equality gates were removed; approval status, scoped tools, schema validation, serialization, clean Git state, and immutable delivery history remain the enforcement boundary.

A fresh Luna planning session exercised the preferred stateless resource surface against an empty repository:

1. `workflow_list` established that no matching work item existed.
2. One `workflow_apply_change` created the work item, specification, implementation task, integration unit, and deterministic evaluation as one canonical Git commit and one planning revision.
3. `workflow_transition` submitted that revision for direct user approval.
4. After approval, a separate session used `workflow_list` and `workflow_get` to retrieve the exact task reference, complete representation, and current revision.
5. It patched the existing task in place with `retain-approval` and an `agent-message` source. The work item remained approved, gained an audited approval amendment, and no duplicate work item, task, or evaluation was created.

The regression also exposed and fixed an important model-facing signal issue: resource bodies previously existed only in tool `details`, while the model saw a terse text summary. List/get/mutation tools now render the full JSON resource envelope in model-visible content, including references and revisions.

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
11. **Tool failures could look like successful results.** Workflow capabilities now throw on mechanical failure, allowing Pi to mark tool results as errors and discouraging model workarounds.
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
