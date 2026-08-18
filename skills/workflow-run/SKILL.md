---
name: workflow-run
description: Use when the user asks to start or resume a reviewed workflow, or when execution needs recovery, verification, completion, or outcome briefing.
---

# Workflow Run

## Run

1. A clear user request to execute the reviewed workflow is the sole execution gate; call `workflow_start` directly and do not ask for a separate approval command or manually sequence routine tasks. A new bug report, “address this,” feature/fix discussion, planning acknowledgement, or review comment does not authorize starting, stopping, resuming, or amending an existing workflow.

## Execution Model

2. The runner follows the assembled execution model: ordered stages advance only after their gates settle; sequential tasks run serially in declared order on the canonical working branch and see prior commits; concurrent tasks run in independent per-task worktrees from one pinned base and cross one merge barrier. Each stage then receives its runtime-owned checks and review/fix loop, followed in order by final whole-branch E2E and final branch review/fix.
3. Managed execution has a strict ownership boundary. The orchestrator never edits source or task worktrees, never installs dependencies, never performs Git changes (including commits, merges, checkouts, resets, or conflict resolution), never launches replacement implementers, reviewers, or E2E agents, never calls `evaluation_record` for runtime-owned reviews, never accepts based on ad hoc checks, never edits unrelated artifacts, and never uses `resume` to force a checkpoint or advance a run. Let the harness and its workers perform those actions through their managed controls.
4. If checkpoint, fixer, or reviewer settlement fails, inspect the canonical recorded evidence once, use the one matching managed action (for example, the checkpoint action or the recorded worker response), then pause and surface the persistent failure. Do not take over manually, retry unchanged failure, substitute a worker, or bypass a required gate.
5. Require the clean recorded `workingBranch`; shaping already created and bound it before the first durable story write. Workflow start and resume validate that branch and never create, switch, or synchronize a delivery branch.
6. Let the runtime enforce stages, dependencies, resource claims, isolation, task merges/checks, generated stage reviews, and final gates. Successful task settlement, integration, review, and an available next step are routine advancement: do not call `task_integrate`, manipulate Git/task state, or wait for user confirmation. The runtime must refresh and continue automatically. After routine work is handed to the runtime, end the turn. Never use `sleep`, polling loops, repeated delayed `workflow_status`, or shell wait scripts to await managed agents, repairs, merges, checks, or evaluations. React only to automatically delivered workflow events, blocking worker messages, or a new user request; one evidence/status inspection in response to an actionable event is allowed, but never wait by polling. Intervene only when an actionable attention event remains after settlement, a blocking worker message exists, or the runtime explicitly pauses. Monitor routine events without narrating every transition.
7. Drive actionable review-loop checkpoints with `workflow_checkpoint`: inspect the canonical report, request focused changes with one live prompt, retry the same reviewer, or accept justified non-blocking risk after a real review attempt. Required stage reviews cannot be skipped. Reviewer/fixer identities, automatic re-review, and iteration limits are harness-owned; no separate resume call is needed after `request_changes`.
8. On interruption or failure, trust recorded branch, worktree, checkpoint, run, and evidence state over chat memory. Preserve dirty/conflicting work; never stash, reset, discard, retry unchanged failure, or resolve conflicts invisibly. Diagnose ownership and offer safe recovery choices.
9. Evaluate at the smallest planned coherent boundary. Record checks, independent verdicts, findings, repairs, reruns, and residual risk. Complete only when every required gate passes.

## Management Protocol

When a worker opens a blocking message, inspect it with `subagent_status` and preserve the exact agent and message IDs. Classify the decision before acting:

1. **Settled by canonical authority.** A reviewed intent, specification, design, or decision unambiguously resolves a contradictory subordinate task clause. If the correction is narrow, reversible, limited to undelivered work, and introduces no new product, policy, privacy/security, destructive, or irreversible choice, amend rather than escalating.
2. **Answerable without amendment.** The task remains valid and the worker only needs a focused factual answer. Respond with `subagent_respond` and let the same logical worker resume.
3. **Genuinely user-owned.** Canonical sources conflict or leave a material outcome, scope, policy, privacy/security, destructive, irreversible, or consequential trade-off unresolved. Preserve the blocked state and ask the user one precise question with the conflicting evidence and viable options.
4. **Insufficient evidence.** Ask the same worker for the smallest targeted clarification; do not guess, launch a replacement worker, or broaden scope.

For a settled task-contract defect, use one atomic `workflow_apply_change` call: patch only the contradictory task fields; cite the authoritative artifact in `authority.sources`; explain why the amendment restores the reviewed outcome; set `executionDisposition` to `resume-requesting-agent` when retained work remains valid or `restart-affected` when it does not; and include the tool's `response` object with the exact agent/message IDs so the requesting logical worker resumes from the amended contract. Do not make a separate `subagent_respond` call when the atomic response is available. Do not count a safe clarification attempt as a repair iteration, manually resume the workflow, or disturb unrelated ready work.

Escalate if the proposed change weakens reviewed acceptance rather than reconciling it, changes user-visible scope, affects delivered work without a safe restart boundary, repeats after amendment, or cannot establish a single authoritative answer. Record the amendment and source trail; never silently reinterpret the task or implement an impossible compromise.

## Finish

After every required step and gate settles, call `work_item_complete` with the bare work-item ID; this completion gate creates `outcome.md` when it does not already exist. Do not report the expected pre-gate absence of `outcome.md` as a deviation. Read the resulting outcome and observed lifecycle evidence, then brief the user on delivered behavior, verification/review, genuine deviations, residual risks or follow-up, and the recorded working-branch state. Report that working branch as ready for the user's normal merge/PR process without switching or merging it. Continue conversationally if follow-up is needed.
