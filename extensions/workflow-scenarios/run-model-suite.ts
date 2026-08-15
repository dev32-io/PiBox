import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRoutineModelFixture, runRoutineModelScenario } from "./model-suite.js";
import { createClarifyModelFixture } from "./model-clarify-fixture.js";
import { createChangeRequestModelFixture } from "./model-change-request-fixture.js";
import { scoreModelRun } from "./model-score.js";
import { renderBenchmarkMarkdown, summarizeBenchmark, writeBenchmarkReport, type WorkflowBenchmarkReport } from "./report.js";

const root = resolve(process.env.PIBOX_BENCH_OUTPUT ?? ".benchmark/workflow-execution");
const selected = (process.env.PIBOX_MODEL_SCENARIOS ?? "routine-managed-workflow,targeted-task-clarify,worker-change-request").split(",").map((value) => value.trim()).filter(Boolean);
const factories = new Map([
	["routine-managed-workflow", createRoutineModelFixture],
	["targeted-task-clarify", createClarifyModelFixture],
	["worker-change-request", createChangeRequestModelFixture],
]);
const startedAt = new Date().toISOString();
const observations = [];
for (const scenarioId of selected) {
	const factory = factories.get(scenarioId);
	if (!factory) throw new Error(`Unknown model scenario: ${scenarioId}`);
	const fixtureRoot = resolve(root, "fixtures", scenarioId);
	await rm(fixtureRoot, { recursive: true, force: true }); await mkdir(fixtureRoot, { recursive: true });
	console.log(`Running ${scenarioId} with openai-codex/gpt-5.6-luna#medium...`);
	observations.push(await runRoutineModelScenario(await factory(fixtureRoot)));
}
const modelRuns = observations.map(scoreModelRun);
const completedAt = new Date().toISOString();
const report: WorkflowBenchmarkReport = {
	schemaVersion: 1, kind: "model", startedAt, completedAt,
	modelPolicy: { provider: "openai-codex", model: "gpt-5.6-luna", effort: "medium" },
	deterministic: [], modelRuns, summary: summarizeBenchmark([], modelRuns),
};
const stamp = completedAt.replaceAll(":", "-").replaceAll(".", "-");
await writeBenchmarkReport(`${root}/model-runs/${stamp}.json`, report);
await writeBenchmarkReport(`${root}/model-latest.json`, report);
await writeFile(`${root}/model-latest.md`, renderBenchmarkMarkdown(report));
await writeFile(`${root}/model-latest-observations.json`, `${JSON.stringify(observations, null, 2)}\n`);
for (const score of modelRuns) console.log(`${score.passed ? "PASS" : "FAIL"} ${score.scenarioId} ${score.score}/100`);
console.log(`Artifacts retained at ${root}`);
if (report.summary.failed) process.exitCode = 1;
