import { readFile, writeFile } from "node:fs/promises";
import { scoreModelRun } from "./model-score.js";
import { renderBenchmarkMarkdown, summarizeBenchmark, writeBenchmarkReport, type WorkflowBenchmarkReport } from "./report.js";
import type { ModelRunObservation } from "./types.js";

const observationPath = process.argv[2];
if (!observationPath) throw new Error("Usage: npm run eval:workflow:model -- <observation.json>");
const parsed = JSON.parse(await readFile(observationPath, "utf8")) as ModelRunObservation | ModelRunObservation[];
const observations = Array.isArray(parsed) ? parsed : [parsed];
for (const observation of observations) {
	if (observation.model !== "openai-codex/gpt-5.6-luna" || observation.effort !== "medium") {
		throw new Error(`Model workflow benchmarks must use openai-codex/gpt-5.6-luna at medium effort; received ${observation.model}#${observation.effort}`);
	}
}
const startedAt = new Date().toISOString();
const modelRuns = observations.map(scoreModelRun);
const completedAt = new Date().toISOString();
const report: WorkflowBenchmarkReport = {
	schemaVersion: 1,
	kind: "model",
	startedAt,
	completedAt,
	modelPolicy: { provider: "openai-codex", model: "gpt-5.6-luna", effort: "medium" },
	deterministic: [],
	modelRuns,
	summary: summarizeBenchmark([], modelRuns),
};
const root = process.env.PIBOX_BENCH_OUTPUT ?? ".benchmark/workflow-execution";
const stamp = completedAt.replaceAll(":", "-").replaceAll(".", "-");
await writeBenchmarkReport(`${root}/model-runs/${stamp}.json`, report);
await writeBenchmarkReport(`${root}/model-latest.json`, report);
await writeFile(`${root}/model-latest.md`, renderBenchmarkMarkdown(report));
for (const score of modelRuns) console.log(`${score.passed ? "PASS" : "FAIL"} ${score.scenarioId} ${score.score}/100`);
console.log(`Model benchmark: ${report.summary.score}/100 (${report.summary.passed}/${report.summary.scenarios} passed)`);
if (report.summary.failed) process.exitCode = 1;
