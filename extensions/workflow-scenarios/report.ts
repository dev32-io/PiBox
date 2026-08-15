import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelRunScore, WorkflowScenarioResult } from "./types.js";

export interface WorkflowBenchmarkReport {
	schemaVersion: 1;
	kind: "deterministic" | "model" | "combined";
	startedAt: string;
	completedAt: string;
	gitCommit?: string;
	modelPolicy?: { provider: "openai-codex"; model: "gpt-5.6-luna"; effort: "medium" };
	deterministic: WorkflowScenarioResult[];
	modelRuns: ModelRunScore[];
	summary: { score: number; passed: number; failed: number; scenarios: number };
}

export function summarizeBenchmark(deterministic: WorkflowScenarioResult[], modelRuns: ModelRunScore[]): WorkflowBenchmarkReport["summary"] {
	const scores = [...deterministic.map((result) => result.score), ...modelRuns.map((result) => result.score)];
	const passed = deterministic.filter((result) => result.passed).length + modelRuns.filter((result) => result.passed).length;
	return { score: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0, passed, failed: scores.length - passed, scenarios: scores.length };
}

export function compareBenchmark(current: WorkflowBenchmarkReport, baseline: WorkflowBenchmarkReport): { scoreDelta: number; regressions: string[]; improvements: string[] } {
	const scoreDelta = current.summary.score - baseline.summary.score;
	const oldScores = new Map([
		...baseline.deterministic.map((result) => [result.scenarioId, result.score] as const),
		...baseline.modelRuns.map((result) => [result.scenarioId, result.score] as const),
	]);
	const changed = [...current.deterministic.map((result) => [result.scenarioId, result.score] as const), ...current.modelRuns.map((result) => [result.scenarioId, result.score] as const)]
		.map(([id, score]) => ({ id, score, previous: oldScores.get(id) }))
		.filter((entry): entry is { id: string; score: number; previous: number } => entry.previous !== undefined && entry.score !== entry.previous);
	return {
		scoreDelta,
		regressions: changed.filter((entry) => entry.score < entry.previous).map((entry) => `${entry.id}: ${entry.previous} → ${entry.score}`),
		improvements: changed.filter((entry) => entry.score > entry.previous).map((entry) => `${entry.id}: ${entry.previous} → ${entry.score}`),
	};
}

export async function writeBenchmarkReport(path: string, report: WorkflowBenchmarkReport): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function readBenchmarkReport(path: string): Promise<WorkflowBenchmarkReport> {
	return JSON.parse(await readFile(path, "utf8")) as WorkflowBenchmarkReport;
}

export function renderBenchmarkMarkdown(report: WorkflowBenchmarkReport): string {
	const rows = [
		...report.deterministic.map((result) => `| ${result.scenarioId} | deterministic | ${result.score} | ${result.passed ? "pass" : "fail"} | ${result.findings.join("; ") || "—"} |`),
		...report.modelRuns.map((result) => `| ${result.scenarioId} | ${result.model}#${result.effort} | ${result.score} | ${result.passed ? "pass" : "fail"} | ${result.dimensions.flatMap((dimension) => dimension.findings).join("; ") || "—"} |`),
	];
	return [
		"# Workflow Execution Benchmark",
		"",
		`- Score: **${report.summary.score}/100**`,
		`- Scenarios: ${report.summary.scenarios}`,
		`- Passed: ${report.summary.passed}`,
		`- Failed: ${report.summary.failed}`,
		...(report.modelPolicy ? [`- Model policy: \`${report.modelPolicy.provider}/${report.modelPolicy.model}#${report.modelPolicy.effort}\``] : []),
		"",
		"| Scenario | Runner | Score | Result | Findings |",
		"| --- | --- | ---: | --- | --- |",
		...rows,
		"",
	].join("\n");
}
