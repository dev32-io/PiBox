---
name: workflow-run
description: Use when an approved workflow should start, resume, recover, verify, complete, or brief the user on its outcome.
---

# Workflow Run

## Run

1. Confirm direct approval and call `workflow_start`; do not manually sequence routine tasks.
2. For new delivery, require a clean `develop`, fast-forward pull, and create the planned feature/fix branch. For continuation, require the clean recorded current branch and never sync `develop` automatically.
3. Let the runtime enforce stages, dependencies, resource claims, isolation, task merges, and planned evaluations. Monitor routine events without narrating every transition.
4. Resolve worker questions from canonical context. Apply delegated amendments with `workflow_apply_change`, respond durably, and resume. Ask the user only for material outcome, policy, privacy/security, irreversible, destructive, or explicitly retained decisions.
5. On interruption or failure, trust recorded branch, worktree, checkpoint, run, and evidence state over chat memory. Preserve dirty/conflicting work; never stash, reset, discard, retry unchanged failure, or resolve conflicts invisibly. Diagnose ownership and offer safe recovery choices.
6. Evaluate at the smallest planned coherent boundary. Record checks, independent verdicts, findings, repairs, reruns, and residual risk. Complete only when every required gate passes.

## Finish

Read `outcome.md` and observed lifecycle evidence. Brief the user on delivered behavior, verification/review, deviations, residual risks or follow-up, and branch state. For a new branch, report readiness to merge into `develop`; for a continued branch, describe only this increment without implying the larger branch is finished. Continue conversationally if follow-up is needed.
