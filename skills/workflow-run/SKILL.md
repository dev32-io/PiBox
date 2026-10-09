---
name: workflow-run
description: Use when the user asks to start or resume a reviewed workflow, or when execution needs recovery, verification, completion, or outcome briefing.
---

# Workflow Run

## Start or Resume

On a clear start request, call `workflow_start` directly; the extension validates topology, branch, and prerequisites and shows its own bypass confirmation. A resume that would launch children uses the same guard unless the session is already in bypass mode, so a new activation never resumes silently in enforced mode. Bypass does not relax workflow authority, Git isolation, reviews, verification, or recovery controls.

## During Execution

- The runtime advances implementation, checks, integration, repairs, reviews, whole-branch review, and final E2E on its own. React only to delivered workflow events, blocking messages, explicit pauses, or a new user request.
- The runtime owns source and worktree edits, dependency installation, Git operations, and every managed launch. Do not spawn managed task, repair, review, or E2E agents yourself, reproduce scheduler transitions, edit task or runtime state, or force advancement.
- Preserve dirty or conflicting work, including unintegrated repair workspaces. Never stash, reset, discard, switch branches routinely, retry an unchanged failure, or resolve conflicts invisibly.
- If E2E reporting cannot finish, the workflow pauses; a normal explicit resume retries evaluation without spending a repair round. Missing `/tmp` evidence is unavailable, not permission to use an older report.
- Do not count clarification as a repair round; respond live to a settled child.
- In E2E guidance, do not ask for another terminal JSON, a report destination, or duplicate evidence manifests.

## When Authority Is Contradictory or Incomplete

1. Never edit authored story, plan, or task resources after runtime state pins their digests.
2. If the story already settles a subordinate defect or factual question, resolve the attention with the smallest exact guidance; the runtime launches a fresh attempt.
3. If the defect is factual and confined to the current task capsule or a deterministic task/stage check, apply the smallest runtime execution correction at the displayed `attentionEpoch`. Routine factual correction within the authorized outcome needs no separate user checkpoint.
4. If the reviewed outcome, story/E2E contract, topology, dependency, assignment, policy, privacy/security posture, destructive behavior, or other material authority must change, keep the workflow paused and ask the user. There is no in-place product replan; replacement requires an explicit stop and a new story.
5. If evidence is insufficient, request the smallest targeted investigation instead of guessing or broadening scope.

## Attention Decisions

A plain `workflow_control resume` never clears attention. Resolve it with `request_changes` (exact guidance) or `approve` (a rationale for every unresolved finding):

| Attention | Action |
|---|---|
| Factual task or check defect within the authorized outcome | `request_changes` with `correction.attentionEpoch`, the exact displayed `attentionTarget`, and only changed fields. Check arrays replace the complete effective array. Targetless workflow-level attention accepts no execution correction. |
| Checks-only task correction | Reruns checks without reimplementation only when state keeps both a validated contribution and failed-check evidence; otherwise include implementation guidance. |
| `repair_exhausted` integration, stage-review, final-review, or E2E attention | `request_changes` only with genuinely new guidance or evidence, for one fresh corrected attempt. |
| E2E `needs_user` at or above the repair limit, cause absent or `needs_user`, no Critical findings | Same as `repair_exhausted`: exact epoch/target correction carrying newly approved prerequisite guidance. Unsafe or unknown cause provenance is not eligible. |
| Finding acceptable as is | `approve` with a per-finding rationale. |
| Critical finding, or an exhaustion that retains Critical findings | Accepting it requires explicit user ownership and the separate extension-owned confirmation, even in bypass. |
| `ledger_persistence_failed` | `request_changes` retries a valid retained note; `approve` acknowledges a malformed optional note. Never discard valid notes, treat this as Critical-risk acceptance, or rerun an accepted contribution. It does not resume execution. |

Corrections never alter story/E2E authority, topology, dependencies, assignment, or completed contributions, and are not finding waivers. Never reset or decrement an exhausted budget, or raise it. A successful requested review fix returns to independent re-review and waives no Critical risk. Each resolution handles only its own slot; if another attention slot remains, it gets a fresh epoch/target and nothing launches. Once all attention is resolved, the runtime requests bypass confirmation when needed and launches fresh work; after a final ledger recovery, resume only on an explicit user request. If a material decision or uncorrectable attention blocks launch, keep the attention and return to the user.

## State and Recovery

- Trust durable state over chat memory: `state.yaml` is the sole authority for scheduling, attempts, retries, corrections, Git coordinates, and outcome. When the visible code is `repair_exhausted`, read the check diagnostics' `causeCode` for the underlying cause.
- `events.jsonl` is debug-only and never replayed; read it only through an explicit bounded diagnostic. Never put its content in prompts or status.
- `/reload` is the only same-activation rebind; the first explicit workflow call afterward reconnects the runner.
- Never adopt old children, inspect PIDs, tail files, or infer completion from old process output.
- Quit is a process crash: tell users not to quit while work runs and do not promise graceful settlement. On the next activation the runtime interrupts old attempts and pauses. Recovery launches only fresh attempts, and only after an explicit user request to resume.

## Finish

Completion is runtime-owned after every stage, whole-branch review, and E2E gate settles. Read `outcome.md` and current authoritative state, then brief the user on delivered behavior, deterministic checks, review/E2E results, genuine deviations, residual risks, and the recorded working branch. Do not author a separate evaluation, report, handoff, or duplicate outcome projection. Report the branch as ready for the user's normal merge/PR process without switching or merging it.
