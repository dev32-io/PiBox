---
name: workflow-run
description: Use when the user asks to start or resume a reviewed workflow, or when execution needs recovery, verification, completion, or outcome briefing.
---

# Workflow Run

## Run

A clear user request to execute the reviewed workflow is the sole execution gate; call `workflow_start` directly. A bug report, “address this,” discussion, acknowledgement, or review comment does not authorize starting, stopping, resuming, or amending a workflow.

## Execution Model

1. Ordered stages advance only after their gates settle. Sequential tasks run serially in declared order on the canonical working branch and see prior commits; concurrent tasks run in independent per-task worktrees from one pinned base and cross one merge barrier. Each stage receives runtime-owned checks and, unless explicitly skipped by the reviewed low-risk policy, a review/fix loop. After assembly, whole-branch review evaluates the exact execution-start-to-current diff before final E2E runs every approved journey.
2. Managed execution owns source/worktree edits, dependency installation, Git operations, worker launches, review records, checks, and gates. Use its controls rather than taking over, substituting workers, or using the `workflow_control` `resume` action to force advancement.
3. If checkpoint, fixer, or reviewer settlement fails, inspect canonical evidence once, use the matching managed action, then pause and surface persistent failure. Do not retry unchanged failure or bypass a gate.
4. Require the clean recorded `workingBranch`; shaping created and bound it before the first durable story write. Start and resume validate that branch without creating, switching, or synchronizing it.
5. Routine settlement and advancement are automatic. After handing work to the runtime, end the turn; do not call `task_integrate`, manipulate Git/task state, wait for confirmation, or narrate routine transitions.
6. Never poll with `sleep`, loops, repeated delayed `workflow_status`, or shell wait scripts. React only to delivered workflow events, blocking worker messages, or a new user request. One evidence/status inspection per actionable event is allowed; intervene only for unresolved attention, a blocking message, or an explicit runtime pause.
7. Reviewer output is evidence, not merge authority. Inspect the canonical report and choose `workflow_checkpoint` `approve` or `request_changes`; approval may accept named Major/Minor findings through structured `acceptedRisks` with rationale. Critical risk requires explicit user confirmation and returns `userDecisionRequired` in headless mode. The harness owns required reviews, reviewer/fixer identities, re-review, and iteration limits; `request_changes` needs no separate resume action. Preserve unrelated new non-critical issues as residual risk.
8. On interruption or failure, trust recorded branch, worktree, checkpoint, run, and evidence state over chat memory. Preserve dirty/conflicting work; never stash, reset, discard, retry unchanged failure, or resolve conflicts invisibly. Diagnose ownership and offer safe recovery choices.
9. Evaluate at the smallest planned coherent boundary. Record checks, independent verdicts, findings, repairs, reruns, and residual risk. Complete only when every required gate passes.

## Management Protocol

When a worker opens a blocking message, inspect the canonical message and workflow evidence once and preserve the exact agent and message IDs. The requesting process attempt is terminal; any safe continuation is a fresh bounded attempt against the same activation-owned logical transcript. Classify the decision before acting:

1. **Settled by canonical authority.** A reviewed intent, specification, design, or decision unambiguously resolves a contradictory subordinate task clause. If the correction is narrow, reversible, limited to undelivered work, and introduces no new product, policy, privacy/security, destructive, or irreversible choice, amend rather than escalating.
2. **Answerable without amendment.** The task remains valid and the worker only needs a focused factual answer. Use one atomic `workflow_apply_change` with no canonical operations, `executionDisposition: resume-requesting-agent`, and `response` carrying the exact IDs and answer. The scheduler starts the fresh attempt; there is no live respond surface.
3. **Genuinely user-owned.** Canonical sources conflict or leave a material outcome, scope, policy, privacy/security, destructive, irreversible, or consequential trade-off unresolved. Preserve the blocked state and ask the user one precise question with the conflicting evidence and viable options.
4. **Insufficient evidence.** Use the same response path to give the smallest targeted investigation request to a fresh attempt of the same logical worker; do not guess, launch a replacement identity, or broaden scope.

For a settled task-contract defect, use one atomic `workflow_apply_change` call: patch only the contradictory task fields; cite the authoritative artifact in `authority.sources`; explain why the amendment restores the reviewed outcome; set `executionDisposition` to `resume-requesting-agent` when retained work remains valid or `pause-affected` when it does not; and include `response` with the exact `agentId`, `messageId`, and `text`. Do not try to answer a settled process live, count safe clarification as a repair iteration, manually resume the workflow, or disturb unrelated ready work.

Escalate if the proposed change weakens reviewed acceptance rather than reconciling it, changes user-visible scope, affects delivered work without a safe restart boundary, repeats after amendment, or cannot establish a single authoritative answer. Record the amendment and source trail; never silently reinterpret the task or implement an impossible compromise.

## Finish

After every required step and gate settles, call `work_item_complete` with the bare work-item ID; this completion gate creates `outcome.md` when it does not already exist. Do not report the expected pre-gate absence of `outcome.md` as a deviation. Read the resulting outcome and observed lifecycle evidence, then brief the user on delivered behavior, verification/review, genuine deviations, residual risks or follow-up, and the recorded working-branch state. Report that working branch as ready for the user's normal merge/PR process without switching or merging it. Continue conversationally if follow-up is needed.
