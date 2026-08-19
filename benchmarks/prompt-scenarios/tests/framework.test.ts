import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractStructuredJson } from "../json.js";
import { buildPromptBenchmarkReport, effectivePass } from "../report.js";
import { plannedRunKeys, rescorePromptBenchmark, runPromptBenchmark } from "../framework.js";
import { parseAvailableModels, resolveBenchmarkRoute } from "../route.js";
import type { AutomaticScore, PromptBenchmarkManifest, PromptBenchmarkSuite, PromptSubjectRunner, ResolvedSubjectRoute } from "../types.js";
import { DEFAULT_HARNESS_CONFIG } from "../../../extensions/workflow/config.js";

const score = (passed: boolean): AutomaticScore => ({
	passed,
	threshold: 70,
	total: passed ? 2 : 0,
	maxTotal: 2,
	normalized: passed ? 100 : 0,
	hardFailures: passed ? [] : ["value was not ok"],
	assertions: [{ id: "fake.ok", kind: "behavior", passed, message: passed ? "ok" : "not ok", evidence: ["value.ok"] }],
	dimensions: [{ id: "fake", label: "Fake behavior", score: passed ? 2 : 0, maxScore: 2, rationale: "Deterministic fake", evidence: ["value.ok"] }],
});

const suite: PromptBenchmarkSuite<{ ok?: boolean }> = {
	id: "fake-suite",
	title: "Fake Suite",
	version: "1.0.0",
	scorerVersion: "fake@1",
	description: "framework fixture",
	baselineConditionId: "baseline",
	conditions: [
		{ id: "baseline", role: "baseline", title: "Baseline", version: "1", description: "baseline", render: () => ({ variantId: "baseline-v1", instruction: "baseline instruction", sourceRefs: ["baseline.md"] }) },
		{ id: "candidate", role: "candidate", title: "Candidate", version: "1", description: "candidate", render: () => ({ variantId: "candidate-v1", instruction: "candidate instruction", sourceRefs: ["candidate.md"] }) },
	],
	scenarios: [{ id: "scenario", title: "Scenario", description: "fixture", fixture: "fictional evidence" }],
	buildPrompt(scenario, condition) {
		const rendered = condition.render(scenario);
		return { ...rendered, prompt: `${rendered.instruction}\n${scenario.fixture}\nJSON only` };
	},
	parse(raw) {
		const parsed = extractStructuredJson(raw);
		return { ...parsed, schemaValid: parsed.syntaxValid && typeof (parsed.value as { ok?: unknown })?.ok === "boolean", value: parsed.value as { ok?: boolean } };
	},
	score: (_scenario, parsed) => score(parsed.schemaValid && parsed.value?.ok === true),
};

const route: ResolvedSubjectRoute = {
	tier: "local",
	configuredRoute: "fake/model#low",
	provider: "fake",
	model: "model",
	effort: "low",
	fallbackIndex: 0,
	resolutionAttempts: [{ configuredRoute: "fake/model#low", status: "selected", supportedEfforts: ["low"], availabilityCommand: "fake list", providerExtension: { provider: "fake", kind: "builtin" } }],
	providerExtension: { provider: "fake", kind: "builtin" },
};

function manifest(outputDirectory: string, conditionIds = ["baseline", "candidate"]): PromptBenchmarkManifest {
	return {
		schemaVersion: 1,
		runId: "run-1",
		status: "planned",
		startedAt: "2026-01-01T00:00:00.000Z",
		repositoryRoot: outputDirectory,
		outputDirectory,
		suite: { id: suite.id, title: suite.title, version: suite.version, scorerVersion: suite.scorerVersion, baselineConditionId: suite.baselineConditionId },
		selection: { tier: "local", conditions: conditionIds, scenarios: ["scenario"], repetitions: 2, concurrency: 2, timeoutMs: 1_000, totalCalls: conditionIds.length * 2 },
		config: { digest: "sha256:fake", sources: ["test"] },
		plannedRunKeys: plannedRunKeys(conditionIds, ["scenario"], 2),
		completedRunKeys: [],
	};
}

test("structured extraction accepts fenced/noisy JSON and preserves syntax failure", () => {
	assert.deepEqual(extractStructuredJson("prefix\n```json\n{\"ok\":true}\n```\nsuffix").value, { ok: true });
	assert.equal(extractStructuredJson("analysis before {\"ok\":true} after").strategy, "balanced");
	const invalid = extractStructuredJson("not json at all");
	assert.equal(invalid.syntaxValid, false);
	assert.match(invalid.errors[0]!, /No valid JSON/);
});

test("generic framework runs selected variants with a fake runner and retains exact evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-bench-"));
	try {
		const calls: string[] = [];
		const runner: PromptSubjectRunner = { async run(request) {
			calls.push(request.prompt);
			return { exitCode: 0, provider: request.route.provider, model: request.route.model, effort: request.route.effort, text: "answer:\n```json\n{\"ok\":true}\n```", stderr: "", events: [{ type: "message_end", message: { role: "assistant", usage: { inputTokens: 12, outputTokens: 4, cost: { total: 0 } } } }] };
		} };
		const selectedManifest = manifest(root);
		const report = await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selectedManifest, suite, route, conditionIds: selectedManifest.selection.conditions, scenarioIds: ["scenario"], repetitions: 2, concurrency: 2, timeoutMs: 1_000, runner });
		assert.equal(calls.length, 4);
		assert.equal(report.summary.total, 4);
		assert.equal(report.summary.automaticPassed, 4);
		assert.equal(report.runs[0]?.metrics.inputTokens, 12);
		const request = JSON.parse(await readFile(join(root, "runs", "baseline__scenario__r001", "request.json"), "utf8"));
		assert.equal(request.prompt, "baseline instruction\nfictional evidence\nJSON only");
		assert.equal(request.condition.variantId, "baseline-v1");
		assert.equal(await readFile(join(root, "runs", "baseline__scenario__r001", "raw-response.txt"), "utf8"), "answer:\n```json\n{\"ok\":true}\n```");
		assert.match(await readFile(join(root, "report.md"), "utf8"), /Human curation/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("parser and scorer exceptions are isolated per run and settle the manifest", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-bench-score-exception-"));
	try {
		const selected = manifest(root, ["baseline"]); const throwing: PromptBenchmarkSuite = { ...suite, parse() { throw new Error("nested parser exploded"); } };
		const runner: PromptSubjectRunner = { async run(request) { return { exitCode: 0, provider: request.route.provider, model: request.route.model, effort: request.route.effort, text: "{}", stderr: "", events: [] }; } };
		const report = await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selected, suite: throwing, route, conditionIds: ["baseline"], scenarioIds: ["scenario"], repetitions: 2, concurrency: 2, timeoutMs: 1_000, runner });
		assert.equal(report.summary.total, 2); assert.equal(report.summary.runnerErrors, 2); assert.equal((JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as PromptBenchmarkManifest).status, "failed");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("runner failures score visibly while retaining partial machine evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-bench-fail-"));
	try {
		const selectedManifest = manifest(root, ["baseline"]);
		const runner: PromptSubjectRunner = { async run() { throw new Error("fake provider unavailable"); } };
		const report = await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selectedManifest, suite, route, conditionIds: ["baseline"], scenarioIds: ["scenario"], repetitions: 2, concurrency: 1, timeoutMs: 1_000, runner });
		assert.equal(report.summary.runnerErrors, 2);
		assert.equal(report.runs[0]?.automatic.passed, false);
		assert.match(await readFile(join(root, "runs", "baseline__scenario__r001", "errors.json"), "utf8"), /fake provider unavailable/);
		const retainedManifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as PromptBenchmarkManifest;
		assert.equal(retainedManifest.status, "failed");
		assert.equal(retainedManifest.completedRunKeys.length, 2);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("human curation changes effective reporting without deleting automatic score", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-bench-curate-"));
	try {
		const selectedManifest = manifest(root, ["baseline"]);
		const runner: PromptSubjectRunner = { async run(request) { return { exitCode: 0, provider: request.route.provider, model: request.route.model, effort: request.route.effort, text: "{\"ok\":false}", stderr: "", events: [] }; } };
		await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selectedManifest, suite, route, conditionIds: ["baseline"], scenarioIds: ["scenario"], repetitions: 2, concurrency: 1, timeoutMs: 1_000, runner });
		await writeFile(join(root, "curation.json"), `${JSON.stringify({ baseline__scenario__r001: { verdict: "pass", annotator: "human", notes: ["Raw answer is acceptable under reviewed semantics."] } }, null, 2)}\n`);
		const report = await rescorePromptBenchmark(root, suite);
		assert.equal(report.summary.automaticPassed, 0);
		assert.equal(report.summary.effectivePassed, 1);
		const curated = report.runs.find((run) => run.runKey === "baseline__scenario__r001")!;
		assert.equal(curated.automatic.passed, false);
		assert.equal(curated.curation.verdict, "pass");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("resume preserves completed evidence and executes only interrupted keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-bench-resume-"));
	try {
		const selected = manifest(root, ["baseline"]); let calls = 0;
		const runner: PromptSubjectRunner = { async run(request) { calls++; return { exitCode: 0, provider: request.route.provider, model: request.route.model, effort: request.route.effort, text: "{\"ok\":true}", stderr: "", events: [] }; } };
		await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selected, suite, route, conditionIds: ["baseline"], scenarioIds: ["scenario"], repetitions: 2, concurrency: 1, timeoutMs: 1_000, runner });
		const firstBefore = await readFile(join(root, "runs", "baseline__scenario__r001", "result.json"), "utf8");
		await rm(join(root, "runs", "baseline__scenario__r002", "result.json")); selected.status = "running"; calls = 0;
		const report = await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selected, suite, route, conditionIds: ["baseline"], scenarioIds: ["scenario"], repetitions: 2, concurrency: 1, timeoutMs: 1_000, runner });
		assert.equal(calls, 1); assert.equal(report.summary.total, 2); assert.equal(await readFile(join(root, "runs", "baseline__scenario__r001", "result.json"), "utf8"), firstBefore);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("rescoring writes a versioned revision and leaves original results immutable", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-bench-immutable-"));
	try {
		const selected = manifest(root, ["baseline"]); const runner: PromptSubjectRunner = { async run(request) { return { exitCode: 0, provider: request.route.provider, model: request.route.model, effort: request.route.effort, text: "{\"ok\":true}", stderr: "", events: [] }; } };
		await runPromptBenchmark({ repositoryRoot: root, outputDirectory: root, manifest: selected, suite, route, conditionIds: ["baseline"], scenarioIds: ["scenario"], repetitions: 2, concurrency: 1, timeoutMs: 1_000, runner });
		const resultPath = join(root, "runs", "baseline__scenario__r001", "result.json"); const before = await readFile(resultPath, "utf8"); const report = await rescorePromptBenchmark(root, suite);
		assert.equal(await readFile(resultPath, "utf8"), before); assert.ok(report.scoringRevision); assert.equal(JSON.parse(await readFile(join(root, "scoring-revisions", report.scoringRevision!.id, "runs", "baseline__scenario__r001.json"), "utf8")).scorerVersion, "fake@1");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("assertion overrides affect only effective hard-failure scoring", () => {
	const automatic = score(true); automatic.passed = false; automatic.normalized = 100; automatic.assertions = [{ id: "hard.x", kind: "hard-failure", passed: false, message: "x", evidence: [] }]; automatic.hardFailures = ["x"];
	const run = { automatic, curation: { notes: [], assertionOverrides: [{ assertionId: "hard.x", passed: true, rationale: "reviewed" }] } } as any;
	assert.equal(effectivePass(run), true); assert.equal(run.automatic.passed, false);
});

test("baseline comparison direction is independent of selected condition order", () => {
	const selected = manifest("/repo", ["candidate", "baseline"]); selected.selection.repetitions = 1; selected.selection.totalCalls = 2;
	const fakeRecord = (condition: "baseline" | "candidate", normalized: number) => ({ schemaVersion: 1 as const, runKey: `${condition}__scenario__r001`, suite: { id: suite.id, version: suite.version }, scenario: { id: "scenario", title: "Scenario" }, condition: { id: condition, role: condition === "baseline" ? "baseline" as const : "candidate" as const, version: "1", variantId: condition, sourceRefs: [] }, repetition: 1, route, prompt: { sha256: "x", path: "x" }, startedAt: "x", completedAt: "x", durationMs: 1, status: "completed" as const, exitCode: 0, artifacts: { request: "x", response: "x", events: "x", stderr: "x", errors: "x" }, parse: { syntaxValid: true, schemaValid: true, strategy: "direct" as const, errors: [] }, automatic: { ...score(true), normalized }, scoring: { scorerVersion: "fake@1", revision: "original" as const }, curation: { notes: [] }, metrics: {} });
	const report = buildPromptBenchmarkReport(selected, [fakeRecord("candidate", 90), fakeRecord("baseline", 40)]);
	assert.deepEqual(report.summary.comparisons[0], { scenarioId: "scenario", baselineConditionId: "baseline", candidateConditionId: "candidate", automaticScoreDelta: 50 });
});

test("route resolution uses configured tier order and exact available identities", async () => {
	const output = "provider      model      context  max-out  thinking  images\nlocal-llm     local-a    128K     16K      yes       no\n";
	assert.deepEqual(parseAvailableModels(output), [{ provider: "local-llm", model: "local-a", thinking: true }]);
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	config.modelTiers.local = ["local-llm/missing#high", "local-llm/local-a#medium"];
	const loaded = { config, digest: "sha256:fake", sources: ["test"], diagnostics: [] };
	const resolved = await resolveBenchmarkRoute(loaded, "local", "/repo", async () => ({ models: [{ provider: "local-llm", model: "local-a", thinking: true }], command: "fake list" }));
	assert.equal(resolved.configuredRoute, "local-llm/local-a#medium");
	assert.equal(resolved.fallbackIndex, 1);
	assert.deepEqual(resolved.resolutionAttempts.map((attempt) => attempt.status), ["model_missing", "selected"]);
	await assert.rejects(() => resolveBenchmarkRoute(loaded, "local", "/repo", async () => ({ models: [], command: "fake list" })), /No usable model route/);
});
