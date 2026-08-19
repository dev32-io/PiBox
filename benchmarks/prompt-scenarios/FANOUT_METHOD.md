# Prompt benchmark fan-out method

This is the stable internal method for comparing PiBox prompt instructions without adding a product-facing benchmark runtime.

## Sources of truth

- Suite and six approved fixtures: `suites/e2e/suite.ts`
- Current baseline instructions: `suites/e2e/prompts/baseline-shaping.md` and `baseline-planning.md`
- Candidate instructions: `suites/e2e/prompts/candidate-outside-in.md`
- E2E rubric and hard failures: `suites/e2e/scorer.ts`

A comparison is valid only when every condition uses the same suite version, scenario fixtures, output contract, agent role, subject tier, and repetition count. Retain the rendered packet hash with each result. If a fixture, condition, output contract, or rubric changes, increment the suite/scorer version and treat it as a new benchmark series.

## Execution

1. Render one immutable packet for every selected condition × scenario × repetition from the tracked suite.
2. Fan out one `general-purpose` subagent per packet with `tier: low` unless the reviewed run explicitly selects another tier. Do not select a concrete model; retain the resolved route reported by PiBox.
3. Each subject may read only its packet and write only its designated ignored response artifact. It must not inspect implementation files, other responses, or the scorer.
4. Run packets concurrently within the configured subagent limit. A failed or timed-out subject is retained as a failed observation; do not silently replace it.
5. Persist packets, hashes, raw JSON responses, subject receipts, route information, and failures under ignored `.benchmark/prompt-scenarios/fanout/<run-id>/`.
6. After every subject settles, use one `general-purpose` subagent at `high` tier to review the complete retained run against the tracked rubric. The evaluator must distinguish prompt behavior from fixture/scorer defects and write a Markdown final report into the run directory.
7. The main session reviews the high-tier report and raw evidence before accepting any prompt change. Never claim improvement from aggregate score alone.

## Approved E2E v1 scenarios

1. `calendar-shaping-replay`
2. `calendar-planning-reconciliation`
3. `backend-migration-restraint`
4. `household-permissions-privacy`
5. `cross-surface-transition`
6. `unavailable-required-platform`

## Comparison policy

The baseline condition is always `current-baseline`; comparison direction never depends on launch order. Report per-scenario and per-dimension differences, hard failures, latency, tokens when available, and overall means. Preserve results that disagree with expectations. A candidate is eligible for production prompt review only when its gains survive human review and it introduces no new critical authorization, privacy, destructive-operation, contradiction, or unavailable-platform failure.
