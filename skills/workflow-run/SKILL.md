---
name: workflow-run
description: Use when the user asks to start or resume a reviewed workflow, or when execution needs recovery, verification, completion, or outcome briefing.
---

# Workflow Run

## Run

1. A clear user request to execute the reviewed workflow is the sole execution gate; call `workflow_start` directly and do not ask for a separate approval command or manually sequence routine tasks. A new bug report, “address this,” feature/fix discussion, planning acknowledgement, or review comment does not authorize starting, stopping, resuming, or amending an existing workflow.
2. Require the clean recorded `workingBranch`; shaping already created and bound it before the first durable story write. Workflow start and resume validate that branch and never create, switch, or synchronize a delivery branch.
3. Let the runtime enforce stages, dependencies, resource claims, isolation, task merges/checks, generated stage reviews, and final gates. Successful task settlement, integration, review, and an available next step are routine advancement: do not call `task_integrate`, manipulate Git/task state, or wait for user confirmation. The runtime must refresh and continue automatically. Intervene only when an actionable attention event remains after settlement, a blocking worker message exists, or the runtime explicitly pauses. Monitor routine events without narrating every transition.
4. Drive actionable review-loop checkpoints with `workflow_checkpoint`: inspect the canonical report, request focused changes with one live prompt, retry the same reviewer, or accept justified non-blocking risk after a real review attempt. Required stage reviews cannot be skipped. Reviewer/fixer identities, automatic re-review, and iteration limits are harness-owned; no separate resume call is needed after `request_changes`. For an open worker message, use its exact agent/message IDs from `subagent_status`: answer settled questions with `subagent_respond`; when the task contradicts authoritative story context, amend the affected task contract with `workflow_apply_change`, then respond so the same logical worker resumes. Ask the user only for material outcome, policy, privacy/security, irreversible, destructive, or genuinely unresolved product decisions.
5. On interruption or failure, trust recorded branch, worktree, checkpoint, run, and evidence state over chat memory. Preserve dirty/conflicting work; never stash, reset, discard, retry unchanged failure, or resolve conflicts invisibly. Diagnose ownership and offer safe recovery choices.
6. Evaluate at the smallest planned coherent boundary. Record checks, independent verdicts, findings, repairs, reruns, and residual risk. Complete only when every required gate passes.

## Finish

After every required step and gate settles, call `work_item_complete` with the bare work-item ID; this completion gate creates `outcome.md` when it does not already exist. Do not report the expected pre-gate absence of `outcome.md` as a deviation. Read the resulting outcome and observed lifecycle evidence, then brief the user on delivered behavior, verification/review, genuine deviations, residual risks or follow-up, and the recorded working-branch state. Report that working branch as ready for the user's normal merge/PR process without switching or merging it. Continue conversationally if follow-up is needed.
