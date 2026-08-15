import { readFile, writeFile } from "node:fs/promises";
import { compareBenchmark, readBenchmarkReport, renderBenchmarkMarkdown, summarizeBenchmark, writeBenchmarkReport, type WorkflowBenchmarkReport } from "./report.js";

const root = process.env.PIBOX_BENCH_OUTPUT ?? ".benchmark/workflow-execution";
const baselinePath = process.argv[2] ?? "benchmarks/workflow-execution/baseline.json";
const deterministic = await readBenchmarkReport(`${root}/latest.json`);
const model = await readBenchmarkReport(`${root}/model-latest.json`);
const current: WorkflowBenchmarkReport = {
	schemaVersion: 1,
	kind: "combined",
	startedAt: deterministic.startedAt,
	completedAt: model.completedAt,
	...(deterministic.gitCommit ? { gitCommit: deterministic.gitCommit } : {}),
	...(model.modelPolicy ? { modelPolicy: model.modelPolicy } : {}),
	deterministic: deterministic.deterministic,
	modelRuns: model.modelRuns,
	summary: summarizeBenchmark(deterministic.deterministic, model.modelRuns),
};
await writeBenchmarkReport(`${root}/current-combined.json`, current);
await writeFile(`${root}/current-combined.md`, renderBenchmarkMarkdown(current));
const baseline = await readBenchmarkReport(baselinePath);
const comparison = compareBenchmark(current, baseline);
console.log(`Current ${current.summary.score}/100; baseline ${baseline.summary.score}/100; delta ${comparison.scoreDelta >= 0 ? "+" : ""}${comparison.scoreDelta}.`);
for (const improvement of comparison.improvements) console.log(`IMPROVED ${improvement}`);
for (const regression of comparison.regressions) console.log(`REGRESSED ${regression}`);
const newFailures = [
	...current.deterministic.filter((result) => !result.passed).map((result) => result.scenarioId),
	...current.modelRuns.filter((result) => !result.passed).map((result) => result.scenarioId),
].filter((id) => {
	const prior = [...baseline.deterministic, ...baseline.modelRuns].find((result) => result.scenarioId === id);
	return prior?.passed !== false;
});
if (newFailures.length) console.log(`NEW FAILURES ${newFailures.join(", ")}`);
if (comparison.regressions.length || newFailures.length) process.exitCode = 1;
