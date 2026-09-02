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

The runtime may give reviewers and fixers the scoped task contracts, current finding or failure, relevant curated ledger entries, optional review focus, and the complete story context needed for that boundary. Final E2E actors receive the complete story `e2e` field directly. No actor receives the debug journal.

When authority is contradictory or incomplete:

1. Never edit authored story, plan, or task resources after runtime state pins their digests.
2. If the story settles a subordinate defect or factual clarification, resolve the authoritative attention slot with the smallest exact guidance; the runtime launches a fresh attempt.
3. If the reviewed contract must change, preserve pause and ask whether to stop; this version has no in-place replan, so only an explicit stop followed by a new target story can replace it.
4. If evidence is insufficient, request the smallest targeted investigation rather than guessing or broadening scope.

Do not count clarification as a repair round, respond live to a settled child, or manually force advancement.

## Attention Decisions

A plain `workflow_control resume` never clears attention. After the user decides, call `workflow_control request_changes` with exact guidance, or `workflow_control approve` with a rationale for every unresolved finding. Accepting a critical-risk finding additionally requires explicit user ownership and a separate extension-owned confirmation, even in bypass. Attention resolution validates first, obtains confirmations, persists the decision in `state.yaml`, and only then launches fresh work. Repair requests remain limited by `limits.repairRounds`; never reset an exhausted budget. If requested changes cannot launch, keep attention and ask the user whether to accept with rationale or stop.

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

- `state.yaml` is the sole authority for scheduling, ownership, attempts, retries, Git coordinates, metrics, resume, and outcome status.
- `ledger.yaml` is the small rewritten set of currently relevant non-obvious findings and evidence. It is the only rolling handoff context; routine status never belongs there.
- `events.jsonl` is coarse, content-free debug/analytics logging. It is never replayed, never used to derive state or metrics, and never included in normal tools, prompts, status, or TUI rendering. Read it only through an explicit bounded filtered diagnostic surface.
- One serialized workflow writer owns all three files. Children never write them.

There is no replay recovery. State is applied atomically before a best-effort debug append; a missing final debug event is acceptable, missing state is not.

## Reload, Quit, and Crash Recovery

`/reload` is the only same-activation rebind path. A reloaded runner may rebind matching active attempts from the process-global `SubagentService` using workflow/attempt metadata and bounded current/terminal delivery; it does not replay files.

Treat session quit exactly like a process crash. Do not promise graceful settlement, detached survival, or continued handoff writing, and tell users not to quit while work is running. On owner loss the lifetime wrapper terminates children, though the exact exit time/event may be absent.

During startup of the next activation, before any resume or child launch, compare durable ownership, mark old running slots interrupted, permanently fence their attempt tokens, pause the workflow, preserve Git/worktree state, and mark incomplete metric time. Never adopt old children, replay `events.jsonl`, inspect PIDs, tail files, add heartbeats, or infer completion from old process output.

Recovery launches only fresh attempts and only after an explicit user request to resume. If that resume would launch children outside bypass mode, show the bypass confirmation first; cancellation launches nothing.

## Finish

Completion is runtime-owned after every stage, whole-branch review, and E2E gate settles. Read `outcome.md` and current authoritative state, then brief the user on delivered behavior, deterministic checks, review/E2E results, genuine deviations, residual risks, and the recorded working branch. Do not author a separate evaluation, report, handoff, or duplicate outcome projection. Report the branch as ready for the user's normal merge/PR process without switching or merging it.
