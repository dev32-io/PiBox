import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HumanCuration, PromptBenchmarkManifest, PromptBenchmarkReport, ScenarioRunRecord } from "./types.js";

export function effectivePass(run: ScenarioRunRecord): boolean {
	if (run.curation.verdict) return run.curation.verdict === "pass";
	const overrides = new Map((run.curation.assertionOverrides ?? []).map((entry) => [entry.assertionId, entry.passed]));
	const hardPassed = run.automatic.assertions.filter((entry) => entry.kind === "schema" || entry.kind === "hard-failure").every((entry) => overrides.get(entry.id) ?? entry.passed);
	return hardPassed && run.automatic.normalized >= run.automatic.threshold;
}

export function buildPromptBenchmarkReport(manifest: PromptBenchmarkManifest, runs: ScenarioRunRecord[], scoringRevision?: { id: string; scorerVersion: string }): PromptBenchmarkReport {
	const roles = new Map(runs.map((run) => [run.condition.id, run.condition.role]));
	const byCondition = manifest.selection.conditions.map((conditionId) => {
		const selected = runs.filter((run) => run.condition.id === conditionId);
		return { conditionId, role: roles.get(conditionId) ?? (conditionId === manifest.suite.baselineConditionId ? "baseline" : "candidate"), runs: selected.length, meanAutomaticScore: selected.length ? Math.round(selected.reduce((sum, run) => sum + run.automatic.normalized, 0) / selected.length) : 0, automaticPassed: selected.filter((run) => run.automatic.passed).length, effectivePassed: selected.filter(effectivePass).length };
	});
	const comparisons: PromptBenchmarkReport["summary"]["comparisons"] = [];
	const baselineConditionId = manifest.suite.baselineConditionId;
	for (const candidateConditionId of manifest.selection.conditions.filter((id) => id !== baselineConditionId)) for (const scenarioId of manifest.selection.scenarios) {
		const baseline = runs.filter((run) => run.scenario.id === scenarioId && run.condition.id === baselineConditionId);
		const candidate = runs.filter((run) => run.scenario.id === scenarioId && run.condition.id === candidateConditionId);
		if (!baseline.length || !candidate.length) continue;
		const mean = (values: ScenarioRunRecord[]) => values.reduce((sum, run) => sum + run.automatic.normalized, 0) / values.length;
		comparisons.push({ scenarioId, baselineConditionId, candidateConditionId, automaticScoreDelta: Math.round(mean(candidate) - mean(baseline)) });
	}
	return { schemaVersion: 1, runId: manifest.runId, suite: manifest.suite, generatedAt: new Date().toISOString(), manifestPath: scoringRevision ? "../../manifest.json" : "manifest.json", ...(scoringRevision ? { scoringRevision } : {}), ...(manifest.route ? { route: manifest.route } : {}), runs, summary: { total: runs.length, automaticPassed: runs.filter((run) => run.automatic.passed).length, effectivePassed: runs.filter(effectivePass).length, runnerErrors: runs.filter((run) => run.status === "runner-error").length, byCondition, comparisons } };
}

const escapeCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderPromptBenchmarkMarkdown(report: PromptBenchmarkReport): string {
	const route = report.route ? `${report.route.provider}/${report.route.model}#${report.route.effort} (${report.route.tier} tier; provider extension: ${report.route.providerExtension.kind}${report.route.providerExtension.path ? ` ${report.route.providerExtension.path}` : ""})` : "unresolved";
	return [
		`# ${report.suite.title} — Tracking Report`, "", `- Run: \`${report.runId}\``, `- Route: \`${route}\``, `- Scorer: \`${report.scoringRevision?.scorerVersion ?? report.suite.scorerVersion}\`${report.scoringRevision ? ` (revision \`${report.scoringRevision.id}\`)` : " (original)"}`, `- Baseline condition: \`${report.suite.baselineConditionId}\``, `- Automatic pass: **${report.summary.automaticPassed}/${report.summary.total}**`, `- Effective pass after curation: **${report.summary.effectivePassed}/${report.summary.total}**`, `- Runner errors: **${report.summary.runnerErrors}**`, "", "## Condition summary", "", "| Condition | Role | Runs | Mean automatic | Automatic pass | Effective pass |", "| --- | --- | ---: | ---: | ---: | ---: |", ...report.summary.byCondition.map((entry) => `| ${entry.conditionId} | ${entry.role} | ${entry.runs} | ${entry.meanAutomaticScore} | ${entry.automaticPassed} | ${entry.effectivePassed} |`), "", "## Scenario evidence", "", "| Scenario | Condition | Rep | Score | Automatic | Effective | Hard failures / notes |", "| --- | --- | ---: | ---: | --- | --- | --- |", ...report.runs.map((run) => { const overrides = (run.curation.assertionOverrides ?? []).map((entry) => `${entry.assertionId}→${entry.passed ? "pass" : "fail"}: ${entry.rationale}`); const notes = [...run.automatic.hardFailures, ...run.curation.notes, ...overrides].join("; ") || "—"; return `| ${run.scenario.id} | ${run.condition.id} | ${run.repetition} | ${run.automatic.normalized} | ${run.automatic.passed ? "pass" : "fail"} | ${effectivePass(run) ? "pass" : "fail"} | ${escapeCell(notes)} |`; }), "", "## Baseline comparisons", "", "| Scenario | Baseline | Candidate | Automatic delta |", "| --- | --- | --- | ---: |", ...(report.summary.comparisons.length ? report.summary.comparisons.map((entry) => `| ${entry.scenarioId} | ${entry.baselineConditionId} | ${entry.candidateConditionId} | ${entry.automaticScoreDelta >= 0 ? "+" : ""}${entry.automaticScoreDelta} |`) : ["| — | — | — | — |"]), "", "## Human curation", "", "Original `result.json` files and their automatic scores are immutable. A curation verdict is the final effective result. Without a verdict, assertion overrides replace matching schema/hard-failure assertion outcomes for effective pass calculation; the original normalized score and automatic result remain unchanged. Re-scoring writes a versioned `scoring-revisions/<id>/` artifact.", "",
	].join("\n");
}

export async function readCuration(path: string): Promise<Record<string, HumanCuration>> { try { return JSON.parse(await readFile(path, "utf8")) as Record<string, HumanCuration>; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid benchmark curation JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`); } }
export async function writeReport(outputDirectory: string, report: PromptBenchmarkReport): Promise<void> { await mkdir(outputDirectory, { recursive: true, mode: 0o700 }); await chmod(outputDirectory, 0o700); await Promise.all([writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).then(() => chmod(join(outputDirectory, "report.json"), 0o600)), writeFile(join(outputDirectory, "report.md"), renderPromptBenchmarkMarkdown(report), { mode: 0o600 }).then(() => chmod(join(outputDirectory, "report.md"), 0o600))]); }
export async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600); }
