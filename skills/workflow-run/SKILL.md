---
name: workflow-run
description: Use when the user asks to start or resume a reviewed workflow, or when execution needs recovery, verification, completion, or outcome briefing.
---

# Workflow Run

## Start or Resume

A clear user request to execute or resume the reviewed workflow is the sole execution gate. A bug report, “address this,” discussion, acknowledgement, review comment, or completed plan does not authorize starting, stopping, resuming, or amending execution.

For start, call `workflow_start` directly. The extension validates topology, branch, and prerequisites, then presents its own explicit confirmation that unattended execution requires visible permission bypass. Cancellation launches nothing and does not mutate execution state.

Any resume that would launch children uses the same centralized bypass guard when the current session is not already in bypass mode. A new activation never resumes silently in enforced mode. The permission extension switches modes only after explicit confirmation; bypass does not bypass workflow authority, Git isolation, reviews, verification, or recovery controls.

## Execution Model

1. The reviewed plan runs as ordered stages. Sequential tasks share one isolated stage workspace and see prior task commits before one integration barrier; concurrent tasks run in per-task worktrees from one pinned base and cross one integration barrier.
2. Within each stage the runtime automatically advances implementation and task checks/repairs, integration, stage checks, and the optional planned review/fix loop. It then performs whole-branch review and final E2E using the story's complete `e2e` field.
3. Runtime-generated CI repair, integration repair, stage review/fix, whole-branch review/fix, and E2E/fix attempts are state slots, not authored tasks, evaluations, reports, or handoffs. `.pi/harness.yaml` `limits.repairRounds` is the only repair-limit authority.
4. Managed execution owns source/worktree edits, dependency installation, Git operations, worker launches, checks, repairs, reviews, and gates. Do not manually reproduce scheduler transitions or edit task/runtime state.
5. Routine settlement is automatic. After handing work to the runtime, end the turn. Never poll with `sleep`, loops, repeated delayed `workflow_status`, or shell wait scripts. React only to delivered workflow events, blocking messages, explicit pauses, or a new user request.
6. The orchestrator intervenes only for contradictory authority, material product/policy/privacy/security/irreversible decisions, critical risk acceptance, unsafe or destructive recovery, unanswerable clarification, or exhausted configured retries.
7. Preserve dirty or conflicting work. Never stash, reset, discard, switch branches routinely, retry unchanged failure, or resolve conflicts invisibly.

## Context and Authority

Each worker receives the complete task `description`, `scope`, and `delivery` in persistent system context. Checks remain harness-owned. A worker may use `task_clarify` only for a concrete uncertainty; it searches or reads a bounded line range from story `spec` or `design`, not a narrative block, criterion, artifact catalog, task reference, authored evaluation, or report.

The runtime gives reviewers and fixers scoped task contracts, current findings/failure, optional review focus, and complete story context for their boundary. Only implementers/fixers receive an initial implementation-ledger system seed and `workflow_ledger` append capability. Reviewers and E2E evaluators receive neither ledger context nor ledger tools. Final E2E actors receive the complete story `e2e` field directly. No actor receives the debug journal.

Managed E2E uses the generic `e2e_workspace` capability, also available to standalone e2e-tester agents. The capability owns a session-restored temporary workspace, selected sanitized evidence, and separate structured report snapshots. Workflow consumes the exact report/evidence paths; it does not copy or Git-publish them. Fixers receive the complete exact current report plus any correction guidance. Do not ask E2E to author another terminal JSON, choose report destinations, bulk-copy test output, or duplicate evidence manifests. Tool-argument errors stay within the evaluator attempt, not product repair iterations. If reporting cannot finish, E2E remains interrupted and the workflow pauses; explicit normal resume retries evaluation without spending a product repair round. `/tmp` retention is best effort: absent current evidence is unavailable, not permission to pick an older report or silently manufacture restored continuity. Normal reviewer reporting and legacy canonical evidence handling are unchanged.

Each stage-review, whole-branch-review, and E2E loop continues its own verifier and distinct fixer while the contract/configuration and activation remain compatible. Re-review verifies prior findings and repair regressions rather than restarting a broad audit. Continued E2E still executes every required case. Preserve dirty or unintegrated repair workspaces; never erase them to force reuse.

When authority is contradictory or incomplete:

1. Never edit authored story, plan, or task resources after runtime state pins their digests.
2. If the story settles a subordinate defect or factual clarification, resolve the authoritative attention slot with the smallest exact guidance; the runtime launches a fresh attempt.
3. If the defect is factual and confined to the current task capsule or deterministic task/stage check, apply the smallest runtime execution correction at the displayed `attentionEpoch`; do not rewrite pinned authored YAML. Routine factual correction within the already authorized outcome does not require a separate user checkpoint.
4. If the reviewed outcome, story/E2E contract, topology, dependency, assignment, policy, privacy/security posture, destructive behavior, or other material authority must change, preserve pause and ask the user. This version has no in-place product replan, so replacement requires explicit stop and a new target story.
5. If evidence is insufficient, request the smallest targeted investigation rather than guessing or broadening scope.

Do not count clarification as a repair round, respond live to a settled child, or manually force advancement.

## Attention Decisions

A plain `workflow_control resume` never clears attention. Use `workflow_control request_changes` with exact guidance, or `workflow_control approve` with a rationale for every unresolved finding. For a factual execution defect, include `correction.attentionEpoch`, the exact displayed `attentionTarget`, and only changed fields. Targetless workflow-level attention cannot accept an execution correction. Task checks and stage checks replace their complete effective arrays. Checks-only task corrections rerun checks without reimplementation only when state preserves both a validated contribution and failed-check evidence; otherwise provide explicit implementation guidance. Authoritative `repair_exhausted` integration, stage-review, final-review, or E2E attention accepts genuinely new prompt guidance/evidence for one fresh corrected attempt. E2E `needs_user` attention also permits an exact-epoch/target correction when its repair count is at or above the configured limit, its cause is absent or `needs_user`, and it retains no Critical findings. Supply newly approved prerequisite guidance without raising the budget or resetting counters; unsafe or unknown cause provenance is not eligible. Normal Critical attention and exhaustion wrappers retaining Critical findings remain on the explicit user-owned risk path. This is not a finding waiver or a general replan. No correction may alter story/E2E authority, topology, dependencies, assignment, or completed contributions.

Attention resolution validates the epoch/exact target, semantic no-op status (including check IDs, string/object forms, and default profiles), and effective corrected checks before mutation, then persists cumulative `executionOverrides`, a monotonic `correctionSequence`, and retained `executionCorrections` in `state.yaml`. If another concurrent attention slot remains, it receives a fresh epoch/target and no bypass confirmation or launch occurs. Only after all attention is resolved does the runtime obtain the normal bypass confirmation when needed and launch fresh-token work; conflicting live attempts are fenced by correction mutation. Correction entries preserve prior repair counts and failed-check evidence without count-based eviction. Existing runs with previously compacted history keep their effective overrides; missing historical evidence is not invented. A successful requested review fixer returns to independent re-review while preserving the old findings; it does not waive a Critical risk. Never reset or decrement an exhausted budget. Accepting a critical-risk finding additionally requires explicit user ownership and a separate extension-owned confirmation, even in bypass. If a material decision or uncorrectable attention cannot launch, keep attention and return authority to the user.

Ledger-only `ledger_persistence_failed` attention is separate from review approval. Retained `ledgerRecoveries` are keyed by accepted attempt token. Use `request_changes` to retry a valid retained note, or `approve` to acknowledge a malformed optional note; never discard valid notes or treat ledger acknowledgement as Critical-risk acceptance. Each call resolves only its validated recovery, preserves other pending attention, and does not resume execution or request permission bypass. After the final recovery, resume only on an explicit user request through the normal guard. Do not rerun an already accepted contribution for a ledger-storage failure.

## State, Continuity, and Diagnostics

Trust story-local durable state over chat memory:

```text
agent-artifacts/<story>/
  story.yaml
  plan.yaml
  tasks/<task>.yaml
  state.yaml
  ledger.yaml
  events.jsonl
  outcome.md
  evidence/
```

- `state.yaml` is the sole authority for scheduling, ownership, attempts, retries, cumulative effective execution overrides, monotonic correction count, correction audit, Git coordinates, metrics, resume, and outcome status. Check diagnostics retain bounded stdout/stderr heads and tails with explicit truncation; inspect `causeCode` for the underlying cause when the visible code is `repair_exhausted`.
- `ledger.yaml` is the curated rolling set of currently relevant findings and evidence, without count-based eviction. Initial implementer/fixer system context selects the newest eight complete entries, retained unchanged during continuation; those actors may read newer/additional entries from the canonical path. They submit useful non-obvious notes through `workflow_ledger`, which queues them privately for the parent writer after validated settlement. It is the only rolling handoff context and the canonical file is read-only to children; routine status and new reviewer/risk records do not belong there.
- `events.jsonl` is coarse, content-free debug/analytics logging. It is never replayed, never used to derive state or metrics, and never included in normal tools, prompts, status, or TUI rendering. Read it only through an explicit bounded filtered diagnostic surface.
- One serialized workflow writer owns all three files. Children never write them.

There is no replay recovery. State is applied atomically before a best-effort debug append; a missing final debug event is acceptable, missing state is not.

## Reload, Quit, and Crash Recovery

`/reload` is the only same-activation rebind path. The first explicit workflow demand after reload automatically recreates the runner and may rebind matching active attempts from the process-global `SubagentService` using workflow/attempt metadata and bounded current/terminal delivery; it does not replay files. Reload startup itself performs no workflow disk restoration.

Treat session quit exactly like a process crash. Do not promise graceful settlement, detached survival, or continued handoff writing, and tell users not to quit while work is running. On owner loss the lifetime wrapper terminates children, though the exact exit time/event may be absent.

On the first explicit workflow demand in the next activation, before status, start, resume, control, or list inspection proceeds, compare durable ownership, mark old running slots interrupted, permanently fence their attempt tokens, pause the workflow, preserve Git/worktree state, and mark incomplete metric time. Ordinary startup performs no repository discovery or workflow disk restoration. Never adopt old children, replay `events.jsonl`, inspect PIDs, tail files, add heartbeats, or infer completion from old process output.

Recovery launches only fresh attempts and only after an explicit user request to resume. If that resume would launch children outside bypass mode, show the bypass confirmation first; cancellation launches nothing.

## Finish

Completion is runtime-owned after every stage, whole-branch review, and E2E gate settles. Read `outcome.md` and current authoritative state, then brief the user on delivered behavior, deterministic checks, review/E2E results, genuine deviations, residual risks, and the recorded working branch. Do not author a separate evaluation, report, handoff, or duplicate outcome projection. Report the branch as ready for the user's normal merge/PR process without switching or merging it.
