# Prompt benchmark method

This benchmark compares prompt behavior through independent subject and reviewer subagents. It does not use an automatic semantic scorer.

## Tracked inputs

- Conditions and small scenarios: `suites/e2e/suite.ts`
- Baseline and candidate prompts: `suites/e2e/prompts/`
- Individual review rubric: `suites/e2e/prompts/review-result.md`
- Final review rubric: `suites/e2e/prompts/review-run.md`

Changing a condition, scenario, output guidance, or review rubric starts a new suite version.

## Execution

1. Render the same scenario for each condition and repetition.
2. Run one isolated `general-purpose` subject at `low` tier per packet. Do not select a concrete model or provider.
3. Save each subject's Markdown result under ignored `.benchmark/prompt-scenarios/<suite-id>/<run-id>/`.
4. Run a separate `general-purpose` reviewer for every result. It reads only that packet, result, and the individual review rubric, then writes the prescribed JSON review.
5. After all individual reviews settle, run one `general-purpose` final reviewer at `high` tier. It reads the run manifest, results, reviews, and final review rubric and writes `final-report.md`.
6. Report observations and score spread, not deterministic prompt quality. A missing result is a mechanical failure; all semantic judgment belongs to reviewers.

## E2E v2 scenarios

1. `web-upload-recovery`
2. `household-delete-permission`
3. `backend-migration-restraint`
4. `cross-surface-task-planning`
5. `unavailable-ios-planning`
