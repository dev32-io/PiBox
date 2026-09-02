# Workflow Execution Evaluation

The required deterministic evaluation exercises the retained target stage state machine directly:

```bash
npm run eval:workflow
```

It checks ordered sequential stages, concurrent stage batches, bounded deterministic-check repair, owner-loss fencing with fresh resume, and explicit critical-risk authority. Add a focused scenario to `extensions/workflow-scenarios/run-deterministic.ts` only when a workflow architecture change creates a gap not covered by the unit and adapter tests.

The older generic-step scenario harness and opt-in model scoring/comparison commands were removed with the obsolete workflow architecture. Files under `benchmarks/workflow-execution/` are retained historical evidence, not an executable current baseline.
