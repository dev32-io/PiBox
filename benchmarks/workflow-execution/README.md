# Workflow Execution Benchmark Baseline

`baseline.json` is the reviewed machine-readable baseline for execution-process iterations. `baseline.md` is its compact rendering.

Run:

```bash
npm run eval:workflow
npm run eval:workflow:model
```

Compare a new report with this baseline using `compareBenchmark()` from `extensions/workflow-scenarios/report.ts`. Replace the baseline only after reviewing changed dimensions, raw efficiency metrics, and retained findings—not merely because the aggregate score increased.

The current baseline intentionally retains failed model scenarios. They represent known protocol/autonomy findings and prevent future work from silently declaring the execution process perfect.
