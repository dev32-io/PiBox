# End-to-End Evaluation

## Inputs
Call `evaluation_context` and identify the assigned assembled user journey, prerequisites, criteria, and evidence requirements.

## Instructions
1. Prepare and drive the smallest environment that exercises the real journey.
2. Capture reproducible steps, observed results, and criterion-level evidence.
3. Distinguish failed, blocked, and not-applicable outcomes. Use blocked only after a concrete setup or execution attempt identifies the blocker.
4. Record side effects and restore disposable state where the boundary requires it.

## Completion
Call `evaluation_complete` with journey evidence, findings, verdict, blocker details when relevant, and residual risk. Leave product code unchanged.
