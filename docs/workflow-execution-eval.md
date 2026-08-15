# Workflow Execution Evaluation Benchmark

This benchmark makes execution-process regressions repeatable. It complements focused unit tests by exercising complete scheduler timelines, real Git safety boundaries, durable agent recovery, and opt-in model behavior.

## Commands

```bash
# Required deterministic suite; writes .benchmark/workflow-execution/latest.{json,md}
npm run eval:workflow

# Opt-in real-model suite. Policy is fixed to Luna at medium effort.
npm run eval:workflow:model

# Re-score retained or manually curated observations without another model run.
npm run eval:workflow:model:score -- path/to/observations.json

# Compare the latest deterministic + model reports with the reviewed baseline.
npm run eval:workflow:compare
```

`.benchmark/` is ignored by Git. Every run retains a timestamped machine-readable report, the latest Markdown summary, and—for model runs—the disposable repository and Pi session needed for diagnosis.

## Layers

1. **Scripted runtime scenarios** use `ScriptedWorkflowAdapter` with the real workflow-runtime extension. They measure dependency ordering, parallelism, resource claims, autonomous advancement, attention, and steering.
2. **Git safety scenarios** use real temporary repositories, canonical work-item resources, branches, and task worktrees. They verify atomic merge rollback and preservation of dirty work.
3. **Recovery scenarios** use the real run store, logical-agent registry, launch coordinator, durable messages, and fresh process attempts.
4. **Model scenarios** create a real reviewed workflow in a disposable repository and execute it through Pi. Both the orchestrator and managed agents are pinned to `openai-codex/gpt-5.6-luna#medium`.

## Metrics

Deterministic scenarios score five invariant dimensions:

- outcome — expected terminal and contribution states;
- scheduling — dependencies and expected concurrency;
- safety — resource isolation and preservation guarantees;
- autonomy — only expected steering/control actions occur;
- protocol — process attempts and terminal actions match the scenario.

Model runs score 0–100 using stable observations rather than a model-authored grade:

| Dimension | Weight | Meaning |
| --- | ---: | --- |
| Outcome | 25 | Workflow and required gates complete |
| Protocol | 15 | Agents follow role and lifecycle contracts |
| Autonomy | 15 | Routine work advances without unnecessary manager intervention |
| Clarification | 10 | `task_clarify` has scenario-appropriate precision and recall |
| Safety | 20 | Git, canonical state, and recovery preserve work and authority |
| Verification | 15 | Planned checks pass with retained evidence |

A model scenario needs an aggregate score of at least 80, but the aggregate cannot hide a critical dimension: outcome, safety, verification, and clarification must be perfect; protocol must be at least 50; and autonomy must be at least 75. Reports also retain tool-call counts, process attempts, orchestrator intervention count, user-escalation count, clarification precision, and token counts when the provider exposes them. These raw metrics should be compared alongside the aggregate score so efficiency or authority-boundary regressions are not hidden by successful delivery.

## Adding a deterministic scenario

For scheduler behavior, add a data-only `WorkflowScenarioDefinition` under `extensions/workflow-scenarios/scenarios/` and include it in the deterministic runner. Prefer one failure mechanism and explicit expectations per scenario.

For Git, recovery, or process behavior, add a function returning `WorkflowScenarioResult`. Use real temporary state, preserve it until assertions have been collected, and report every violated invariant rather than stopping at the first assertion.

Every scenario must state:

- the risk it represents;
- expected terminal state;
- expected task/process attempts;
- expected concurrency or serialization;
- allowed orchestrator/user interventions;
- state that must be preserved on failure.

## Adding a model scenario

Model scenarios must:

- pin Luna at medium effort in both the Pi invocation and repository harness policy;
- define expected clarification and intervention counts before the run;
- derive scores from transcripts, canonical resources, Git state, and evidence;
- retain the fixture and sessions after failure;
- avoid exact prose matching;
- never silently accept a critical product, security, privacy, destructive, or irreversible decision.

## Iteration practice

1. Run the deterministic suite and preserve its report.
2. Run the smallest relevant model scenarios.
3. Record observed facts, issue severity, suggested change, and whether a fix was applied.
4. Fix obvious local benchmark/process defects and rerun.
5. Do not change a critical workflow-policy or user-authority boundary during the benchmark run; retain the finding for joint review.
6. Compare the latest report with the prior baseline before committing.
