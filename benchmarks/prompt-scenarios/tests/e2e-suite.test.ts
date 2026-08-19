import assert from "node:assert/strict";
import test from "node:test";
import { e2ePromptBenchmarkSuite } from "../suites/e2e/suite.js";
import type { E2EBenchmarkOutput } from "../suites/e2e/scorer.js";

function output(overrides: Partial<E2EBenchmarkOutput> = {}): E2EBenchmarkOutput {
	return {
		summary: "Small outside-in selection.",
		questions: [],
		instructionArtifacts: {},
		obligations: [{ id: "OB-1", text: "Required behavior", sourceRefs: ["AC-MOB-1"] }],
		cases: [{ id: "E2E-MOB-1", classification: "golden-path", actor: "Traveler", entrySurface: "Android app", startingState: "Trip exists", actions: ["Export trip"], visibleOutcomes: ["System share sheet appears"], finalInvariant: "Trip remains unchanged", requirementRefs: ["AC-MOB-1"], technicalEvidence: ["Driver records share intent for the named hidden platform handoff"], setupCleanup: ["Use disposable trip and remove it"], safety: ["No production data"], platforms: ["android"], status: "planned" }],
		obligationCoverage: [{ obligationId: "OB-1", caseIds: ["E2E-MOB-1"] }],
		gaps: [],
		exclusions: [{ scope: "Unrelated web export", rationale: "No web behavior changed", sourceRefs: ["SCOPE"] }],
		amendments: [],
		...overrides,
	};
}

test("baseline envelope does not teach candidate-specific decomposition", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	const baseline = e2ePromptBenchmarkSuite.conditions.find((entry) => entry.role === "baseline")!;
	const prompt = e2ePromptBenchmarkSuite.buildPrompt(scenario, baseline).prompt;
	assert.doesNotMatch(prompt, /obligationCoverage|technical-proof|material-product|traceability crosswalk|preservesIds/);
	assert.match(prompt, /instructionArtifacts/);
});

test("E2E suite scores malformed/schema-invalid output instead of throwing", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	const malformed = e2ePromptBenchmarkSuite.parse("I would create several tests.");
	const malformedScore = e2ePromptBenchmarkSuite.score(scenario, malformed);
	assert.equal(malformedScore.passed, false);
	assert.match(malformedScore.hardFailures[0]!, /Structured output failure/);
	const schemaInvalid = e2ePromptBenchmarkSuite.parse("{\"summary\":\"only\"}");
	assert.equal(schemaInvalid.syntaxValid, true);
	assert.equal(schemaInvalid.schemaValid, false);
	assert.equal(e2ePromptBenchmarkSuite.score(scenario, schemaInvalid).passed, false);
});

test("deep traceability validation rejects empty and dangling nested records", () => {
	const invalid = output({ obligationCoverage: [{}] });
	const parsed = e2ePromptBenchmarkSuite.parse(JSON.stringify(invalid));
	assert.equal(parsed.schemaValid, false);
	assert.match(parsed.errors.join("\n"), /real obligation|covered exactly once/);
	const dangling = output({ obligationCoverage: [{ obligationId: "OB-1", caseIds: ["MISSING"] }] });
	assert.equal(e2ePromptBenchmarkSuite.parse(JSON.stringify(dangling)).schemaValid, false);
});

test("keywords only in exclusions or questions do not earn concept coverage", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	const stuffed = { summary: "neutral", cases: [{ id: "E2E-X", classification: "golden-path", actor: "Person", entrySurface: "surface", startingState: "start", actions: ["act"], visibleOutcomes: ["result"], finalInvariant: "done", requirementRefs: ["SPEC-CAL-1"], technicalEvidence: [], setupCleanup: ["setup"], safety: ["safe"], platforms: [], status: "planned" }], questions: ["web android ios create update delete recurrence timezone loading error privacy"], exclusions: [{ scope: "web android ios create update delete recurrence timezone loading error privacy", rationale: "stuffed", sourceRefs: ["SCOPE"] }], instructionArtifacts: {} };
	const score = e2ePromptBenchmarkSuite.score(scenario, e2ePromptBenchmarkSuite.parse(JSON.stringify(stuffed)));
	assert.equal(score.dimensions.find((entry) => entry.id === "affected-area")?.score, 1, "only the presence of a legitimate exclusion contributes; stuffed concepts do not");
	assert.equal(score.dimensions.find((entry) => entry.id === "platform")?.score, 0);
});

test("planning contradiction and amendment gate are explicit hard failures", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios.find((entry) => entry.id === "calendar-planning-reconciliation")!;
	const parsed = e2ePromptBenchmarkSuite.parse(JSON.stringify(output()));
	const automatic = e2ePromptBenchmarkSuite.score(scenario, parsed);
	assert.equal(automatic.assertions.find((entry) => entry.id === "hard.contradiction")?.passed, false);
	assert.equal(automatic.assertions.find((entry) => entry.id === "hard.amendment-gate")?.passed, false);
});

test("unavailable required platform must be retained as blocked, never passed", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios.find((entry) => entry.id === "unavailable-required-platform")!;
	const unsafe = output({ cases: [{ ...output().cases![0]!, platforms: ["ios"], status: "passed" }] });
	const unsafeScore = e2ePromptBenchmarkSuite.score(scenario, e2ePromptBenchmarkSuite.parse(JSON.stringify(unsafe)));
	assert.equal(unsafeScore.assertions.find((entry) => entry.id === "hard.required-platform")?.passed, false);
	assert.equal(unsafeScore.assertions.find((entry) => entry.id === "hard.no-false-pass")?.passed, false);
	const safe = output({
		cases: [
			output().cases![0]!,
			{ ...output().cases![0]!, id: "E2E-MOB-1-IOS", entrySurface: "iOS app", platforms: ["ios"], status: "blocked", blockedReason: "No Xcode, simulator, or remote driver is available." },
		],
		amendments: [{ classification: "contradiction-infeasible", evidenceRefs: ["REPO-MOB-2"], impactedRequirementRefs: ["AC-MOB-1", "E2E-MOB-1"], preservesIds: true, proposedDelta: "Keep iOS required and blocked pending a capable environment.", userReviewRequired: true }],
	});
	const safeScore = e2ePromptBenchmarkSuite.score(scenario, e2ePromptBenchmarkSuite.parse(JSON.stringify(safe)));
	assert.equal(safeScore.assertions.find((entry) => entry.id === "hard.required-platform")?.passed, true);
	assert.equal(safeScore.assertions.find((entry) => entry.id === "hard.amendment-gate")?.passed, true);
});
