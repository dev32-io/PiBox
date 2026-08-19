import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { e2ePromptBenchmarkSuite } from "../suites/e2e/suite.js";

const expectedScenarios = [
	"web-upload-recovery",
	"household-delete-permission",
	"backend-migration-restraint",
	"cross-surface-task-planning",
	"unavailable-ios-planning",
];

test("v2 uses five small focused scenarios", () => {
	assert.equal(e2ePromptBenchmarkSuite.version, "2.0.0");
	assert.deepEqual(e2ePromptBenchmarkSuite.scenarios.map((scenario) => scenario.id), expectedScenarios);
	for (const scenario of e2ePromptBenchmarkSuite.scenarios) {
		assert.ok(scenario.fixture.length < 700, `${scenario.id} should stay concise`);
	}
});

test("subject output is concise Markdown without a rigid JSON envelope", () => {
	for (const scenario of e2ePromptBenchmarkSuite.scenarios) {
		for (const condition of e2ePromptBenchmarkSuite.conditions) {
			const prompt = e2ePromptBenchmarkSuite.buildPrompt(scenario, condition).prompt;
			assert.match(prompt, /Return a concise Markdown E2E matrix/);
			assert.doesNotMatch(prompt, /Return exactly one JSON object|instructionArtifacts|classification.*golden-path\|edge/);
		}
	}
});

test("automatic handling checks only whether a result exists", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	const valid = e2ePromptBenchmarkSuite.parse("## Matrix\n\nUseful result");
	const validScore = e2ePromptBenchmarkSuite.score(scenario, valid);
	assert.equal(validScore.passed, true);
	assert.equal(validScore.normalized, 100);
	assert.deepEqual(validScore.dimensions, []);

	const empty = e2ePromptBenchmarkSuite.parse("   ");
	const emptyScore = e2ePromptBenchmarkSuite.score(scenario, empty);
	assert.equal(emptyScore.passed, false);
	assert.equal(emptyScore.normalized, 0);
	assert.deepEqual(emptyScore.dimensions, []);
});

test("tracked review prompts separate individual and final judgment", () => {
	const promptDir = fileURLToPath(new URL("../suites/e2e/prompts/", import.meta.url));
	const individual = readFileSync(`${promptDir}/review-result.md`, "utf8");
	const final = readFileSync(`${promptDir}/review-run.md`, "utf8");
	assert.match(individual, /Score each dimension from 1 .* to 5/);
	assert.match(individual, /Do not expect perfect coverage/);
	assert.match(final, /volatile sample/);
	assert.match(final, /individual overall scores and their spread/);
});
