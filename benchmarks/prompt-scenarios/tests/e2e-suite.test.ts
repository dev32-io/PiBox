import assert from "node:assert/strict";
import test from "node:test";
import { e2ePromptBenchmarkSuite } from "../suites/e2e/suite.js";
import type { E2EBenchmarkOutput, E2ECase } from "../suites/e2e/scorer.js";

function matrixCase(overrides: Partial<E2ECase> = {}): E2ECase {
	return {
		id: "E2E-X",
		classification: "golden-path",
		actor: "Person",
		entrySurface: "outward surface",
		startingState: "Fixture is ready",
		actions: ["Perform behavior"],
		visibleOutcomes: ["Observable result appears"],
		finalInvariant: "Expected state remains",
		requirementRefs: ["SPEC-CAL-1"],
		technicalEvidence: ["Corroborating state is recorded"],
		setupCleanup: ["Use and remove disposable fixture"],
		safety: ["Do not use production data"],
		platforms: ["web"],
		status: "planned",
		...overrides,
	};
}

function response(cases: E2ECase[], overrides: Partial<E2EBenchmarkOutput> = {}): E2EBenchmarkOutput {
	return {
		summary: "Small outside-in selection.",
		cases,
		questions: [],
		exclusions: [],
		...overrides,
	};
}

function score(scenarioId: string, value: E2EBenchmarkOutput) {
	const scenario = e2ePromptBenchmarkSuite.scenarios.find((entry) => entry.id === scenarioId)!;
	const parsed = e2ePromptBenchmarkSuite.parse(JSON.stringify(value));
	assert.equal(parsed.schemaValid, true, parsed.errors.join("\n"));
	return e2ePromptBenchmarkSuite.score(scenario, parsed);
}

function assertionPassed(automatic: ReturnType<typeof score>, id: string): boolean | undefined {
	return automatic.assertions.find((entry) => entry.id === id)?.passed;
}

test("baseline envelope does not teach candidate-specific decomposition", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	const baseline = e2ePromptBenchmarkSuite.conditions.find((entry) => entry.role === "baseline")!;
	const prompt = e2ePromptBenchmarkSuite.buildPrompt(scenario, baseline).prompt;
	assert.doesNotMatch(prompt, /obligationCoverage|technical-proof|material-product|traceability crosswalk|preservesIds/);
	assert.match(prompt, /instructionArtifacts/);
});

test("planning fixtures grade journeys and evidence rather than preserving upstream case IDs", () => {
	for (const scenarioId of ["calendar-planning-reconciliation", "unavailable-required-platform"]) {
		const scenario = e2ePromptBenchmarkSuite.scenarios.find((entry) => entry.id === scenarioId)!;
		assert.equal(scenario.metadata?.approvedCaseIds, undefined);
		assert.doesNotMatch(scenario.fixture, /Approved case ID|Preserve unchanged IDs|Retain the exact approved case/);
	}
	const scorerSource = score("calendar-planning-reconciliation", response([
		matrixCase({ id: "PLAN-NEW-1", requirementRefs: ["AC-009"] }),
	], { instructionArtifacts: { decision: "Contradiction between AC-005 and REPO-1; proposed matrix amendment requires user review." } }));
	assert.equal(scorerSource.assertions.some((entry) => entry.id === "hard.approved-id-preservation"), false);
});

test("calendar contradiction explicitly spans beyond the selected week while AC-005 remains covering-window based", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios.find((entry) => entry.id === "calendar-planning-reconciliation")!;
	assert.match(scenario.fixture, /ten consecutive dates/);
	assert.match(scenario.fixture, /Only seven fall inside any selected seven-day week/);
	assert.match(scenario.fixture, /other three are outside/);
	assert.match(scenario.fixture, /intentionally clips/);
	assert.match(scenario.fixture, /AC-005: A covering query returns every recurring occurrence that overlaps its requested time window; it does not return occurrences outside that window/);
});

test("E2E suite rejects malformed/schema-invalid output without awarding rubric scores", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	for (const raw of ["I would create several tests.", "{\"summary\":\"only\"}"]) {
		const parsed = e2ePromptBenchmarkSuite.parse(raw);
		const automatic = e2ePromptBenchmarkSuite.score(scenario, parsed);
		assert.equal(automatic.passed, false);
		assert.equal(automatic.total, 0);
		assert.ok(automatic.dimensions.every((entry) => entry.score === 0));
		assert.match(automatic.hardFailures[0]!, /Structured output failure/);
	}
});

test("recovered fragments never substitute for exact top-level JSON", () => {
	const nestedCase = JSON.stringify(matrixCase());
	for (const raw of [
		`{"summary":"truncated","cases":[${nestedCase}`,
		`analysis before ${JSON.stringify(response([matrixCase()]))} after`,
		`\`\`\`json\n${JSON.stringify(response([matrixCase()]))}\n\`\`\``,
	]) {
		const parsed = e2ePromptBenchmarkSuite.parse(raw);
		assert.notEqual(parsed.strategy, "direct");
		assert.equal(parsed.syntaxValid, false);
		assert.equal(parsed.schemaValid, false);
		assert.ok(parsed.value, "nested fragment remains available for diagnostics");
		assert.match(parsed.errors.join("\n"), /recovered for diagnostics/);
		const automatic = e2ePromptBenchmarkSuite.score(e2ePromptBenchmarkSuite.scenarios[0]!, parsed);
		assert.equal(automatic.total, 0);
		assert.ok(automatic.dimensions.every((entry) => entry.score === 0));
	}
});

test("schema validates stable fields but treats instructionArtifacts as optional free-form data", () => {
	const withoutArtifacts = response([matrixCase()]);
	assert.equal(e2ePromptBenchmarkSuite.parse(JSON.stringify(withoutArtifacts)).schemaValid, true);
	const arbitraryArtifacts = response([matrixCase()], { instructionArtifacts: { notesFromReview: { arbitraryShape: ["free prose", { anything: true }] } } });
	assert.equal(e2ePromptBenchmarkSuite.parse(JSON.stringify(arbitraryArtifacts)).schemaValid, true);
	const duplicateCases = response([matrixCase(), matrixCase()]);
	assert.equal(e2ePromptBenchmarkSuite.parse(JSON.stringify(duplicateCases)).schemaValid, false);
});

test("free-form reconciliation artifacts are scored semantically without private key names", () => {
	const cases = [
		matrixCase({ id: "PLAN-CREATE", requirementRefs: ["AC-009"] }),
		matrixCase({ id: "PLAN-RECURRENCE", requirementRefs: ["AC-005"] }),
		matrixCase({ id: "PLAN-MOBILE", requirementRefs: ["AC-009"], platforms: ["android", "ios"] }),
	];
	const automatic = score("calendar-planning-reconciliation", response(cases, {
		instructionArtifacts: {
			reviewerNotebook: [
				"Contradiction: AC-005 conflicts with the requested week-view behavior based on REPO-1.",
				{ resolutionForApproval: "Proposed matrix amendment changes the recurrence expectation and requires user review." },
			],
		},
	}));
	assert.equal(assertionPassed(automatic, "hard.contradiction"), true);
	assert.equal(assertionPassed(automatic, "hard.amendment-gate"), true);
	assert.equal(automatic.dimensions.find((entry) => entry.id === "grounding")?.score, 2);
});

test("keywords only in exclusions or questions do not earn behavior concept coverage", () => {
	const scenario = e2ePromptBenchmarkSuite.scenarios[0]!;
	const stuffed = response([matrixCase({ platforms: [] })], {
		questions: ["web android ios create update delete recurrence timezone loading error privacy"],
		exclusions: [{ scope: "web android ios create update delete recurrence timezone loading error privacy", rationale: "stuffed", sourceRefs: ["SCOPE"] }],
		instructionArtifacts: {},
	});
	const automatic = e2ePromptBenchmarkSuite.score(scenario, e2ePromptBenchmarkSuite.parse(JSON.stringify(stuffed)));
	assert.equal(automatic.dimensions.find((entry) => entry.id === "affected-area")?.score, 1, "only a legitimate exclusion contributes; stuffed concepts do not");
	assert.equal(automatic.dimensions.find((entry) => entry.id === "platform")?.score, 0);
});

test("planning contradiction and amendment gate remain explicit hard failures", () => {
	const cases = [
		matrixCase({ id: "E2E-001", requirementRefs: ["AC-009"] }),
		matrixCase({ id: "E2E-002", requirementRefs: ["AC-005"] }),
		matrixCase({ id: "E2E-003", requirementRefs: ["AC-009"] }),
	];
	const automatic = score("calendar-planning-reconciliation", response(cases));
	assert.equal(assertionPassed(automatic, "hard.contradiction"), false);
	assert.equal(assertionPassed(automatic, "hard.amendment-gate"), false);
});

test("unavailable infrastructure keeps iOS blocked without requiring an upstream case ID", () => {
	const android = matrixCase({ id: "PLAN-ANDROID", requirementRefs: ["AC-MOB-1"], platforms: ["android"], status: "planned" });
	const ios = matrixCase({ id: "PLAN-IOS", requirementRefs: ["AC-MOB-1"], platforms: ["ios"], status: "blocked", blockedReason: "iOS proof needs Xcode, simulator, or a remote iOS driver." });
	const automatic = score("unavailable-required-platform", response([android, ios], {
		questions: ["Please provide an executable iOS environment with Xcode, simulator, or remote driver."],
	}));
	assert.equal(assertionPassed(automatic, "hard.required-platform"), true);
	assert.equal(assertionPassed(automatic, "hard.amendment-gate"), true);
	assert.equal(assertionPassed(automatic, "hard.no-unnecessary-amendment"), true);
});

test("unavailable infrastructure rejects false passes and invented matrix amendments", () => {
	const android = matrixCase({ id: "PLAN-ANDROID", requirementRefs: ["AC-MOB-1"], platforms: ["android"], status: "planned" });
	const falsePassValue = response([{ ...android, id: "PLAN-IOS", platforms: ["ios"], status: "passed" }], { questions: ["Please provide an executable iOS environment."] });
	const falsePassParsed = e2ePromptBenchmarkSuite.parse(JSON.stringify(falsePassValue));
	assert.equal(falsePassParsed.schemaValid, false);
	const falsePass = e2ePromptBenchmarkSuite.score(e2ePromptBenchmarkSuite.scenarios.find((entry) => entry.id === "unavailable-required-platform")!, falsePassParsed);
	assert.equal(falsePass.total, 0);

	const blocked = { ...android, id: "PLAN-IOS", platforms: ["ios"], status: "blocked", blockedReason: "No Xcode or simulator" };
	const amended = score("unavailable-required-platform", response([android, blocked], {
		questions: ["Please provide an executable iOS environment."],
		instructionArtifacts: { decision: "Propose a product matrix amendment because REPO-MOB-2 lacks Xcode." },
	}));
	assert.equal(assertionPassed(amended, "hard.no-unnecessary-amendment"), false);
});

test("authorization morphology recognizes deny, denied, denial, prohibit, and prohibited", () => {
	for (const form of ["deny", "denied", "denial", "prohibit", "prohibited"]) {
		const cases = [
			matrixCase({ id: `E2E-CHILD-${form}`, actor: "Child", actions: [`Purchase is ${form} before prompt and store call`], visibleOutcomes: ["No private token or order detail leaks"], requirementRefs: ["PERM-2", "PRIV-1"], safety: ["Fake store"], platforms: ["web"] }),
			matrixCase({ id: `E2E-GUEST-${form}`, actor: "Guest", actions: [`Purchase ${form} before prompt and store call`], visibleOutcomes: ["Privacy masking prevents secret token leak"], requirementRefs: ["PERM-2", "PRIV-1"], safety: ["Fake store"], platforms: ["web"] }),
		];
		const automatic = score("household-permissions-privacy", response(cases));
		assert.equal(assertionPassed(automatic, "hard.authorization-privacy"), true, form);
	}
});

function migrationResponse(overrides: Partial<E2EBenchmarkOutput> = {}): E2EBenchmarkOutput {
	return response([
		matrixCase({
			id: "E2E-MIG-1",
			actor: "Migration operator",
			entrySurface: "local migration command",
			startingState: "Disposable data contains null and unicode memo values",
			actions: ["Run forward migration, restart safely, retry idempotently, and rollback"],
			visibleOutcomes: ["API memo remains compatible throughout the two-release compatibility window"],
			finalInvariant: "All data survives migration and rollback",
			requirementRefs: ["MIG-1", "MIG-2", "MIG-3", "OPS-1"],
			technicalEvidence: ["Database note values and API memo responses corroborate compatibility"],
			setupCleanup: ["Create and remove a disposable local database snapshot"],
			safety: ["Never target production"],
			platforms: [],
		}),
	], { exclusions: [{ scope: "UI and mobile matrix", rationale: "Backend-only scope", sourceRefs: ["SCOPE"] }], ...overrides });
}

test("migration compatibility must preserve the binding two-release duration", () => {
	const complete = score("backend-migration-restraint", migrationResponse());
	assert.equal(assertionPassed(complete, "hard.binding-qualifiers"), true);
	const generic = migrationResponse();
	generic.cases![0]!.visibleOutcomes = ["API memo remains compatible during migration"];
	const missing = score("backend-migration-restraint", generic);
	assert.equal(assertionPassed(missing, "hard.binding-qualifiers"), false);
	generic.instructionArtifacts = { reviewerNote: "MIG-1 says two releases" };
	assert.equal(assertionPassed(score("backend-migration-restraint", generic), "hard.binding-qualifiers"), false, "an unclassified artifact mention is not an explicit gap");
	generic.instructionArtifacts = { openGapFromReview: "Is the compatibility duration two releases, or is MIG-1 stale?" };
	const explicitGap = score("backend-migration-restraint", generic);
	assert.equal(assertionPassed(explicitGap, "hard.binding-qualifiers"), true);
});

test("migration scorer rejects invented production refusal but permits questions and safety constraints", () => {
	const invented = migrationResponse();
	invented.cases![0]!.visibleOutcomes!.push("The migration runner refuses production targets");
	assert.equal(assertionPassed(score("backend-migration-restraint", invented), "hard.no-invented-enforcement"), false);

	const question = migrationResponse({ questions: ["Does the runner refuse production targets, or is disposable setup the only safety boundary?"] });
	question.cases![0]!.safety = ["Block production use operationally by selecting only a disposable local snapshot"];
	assert.equal(assertionPassed(score("backend-migration-restraint", question), "hard.no-invented-enforcement"), true);

	const constrained = migrationResponse();
	constrained.cases![0]!.technicalEvidence = ["Safety constraint: refuse production targets; operators select only a disposable local snapshot"];
	assert.equal(assertionPassed(score("backend-migration-restraint", constrained), "hard.no-invented-enforcement"), true);
});

test("suite and scorer versions advance for repaired fixtures and behavior scoring", () => {
	assert.equal(e2ePromptBenchmarkSuite.version, "1.2.0");
	assert.equal(e2ePromptBenchmarkSuite.scorerVersion, "e2e-scorer@1.2.0");
});
