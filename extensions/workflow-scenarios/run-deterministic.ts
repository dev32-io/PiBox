import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { coreScenarios } from "./scenarios/core.js";
import { gitSafetyScenarios } from "./git-safety.js";
import { recoverySafetyScenarios } from "./recovery-safety.js";
import { renderBenchmarkMarkdown, summarizeBenchmark, writeBenchmarkReport, type WorkflowBenchmarkReport } from "./report.js";
import { runWorkflowScenario } from "./scenario-runner.js";

const exec = promisify(execFile);
const startedAt = new Date().toISOString();
const results = [];
for (const scenario of coreScenarios) {
	const result = await runWorkflowScenario(scenario);
	results.push(result);
	console.log(`${result.passed ? "PASS" : "FAIL"} ${scenario.id} ${result.score}/100${result.findings.length ? ` — ${result.findings.join("; ")}` : ""}`);
}
for (const scenario of [...gitSafetyScenarios, ...recoverySafetyScenarios]) {
	const result = await scenario();
	results.push(result);
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.scenarioId} ${result.score}/100${result.findings.length ? ` — ${result.findings.join("; ")}` : ""}`);
}
const completedAt = new Date().toISOString();
const gitCommit = await exec("git", ["rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim(), () => undefined);
const report: WorkflowBenchmarkReport = {
	schemaVersion: 1,
	kind: "deterministic",
	startedAt,
	completedAt,
	...(gitCommit ? { gitCommit } : {}),
	deterministic: results,
	modelRuns: [],
	summary: summarizeBenchmark(results, []),
};
const root = process.env.PIBOX_BENCH_OUTPUT ?? ".benchmark/workflow-execution";
const stamp = completedAt.replaceAll(":", "-").replaceAll(".", "-");
await writeBenchmarkReport(`${root}/runs/${stamp}.json`, report);
await writeBenchmarkReport(`${root}/latest.json`, report);
await writeFile(`${root}/latest.md`, renderBenchmarkMarkdown(report));
console.log(`Workflow benchmark: ${report.summary.score}/100 (${report.summary.passed}/${report.summary.scenarios} passed)`);
if (report.summary.failed) process.exitCode = 1;
