import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlanBundle, normalizePlanEdit, normalizePlanStage, normalizeResourceArtifact, normalizeResourceEvaluation } from "../plan-authoring.js";

test("accepts concise author-facing specification artifacts", () => {
	const artifact = normalizeResourceArtifact({
		id: "todo-contract", artifactType: "specification", title: "Todo contract",
		content: {
			actors: ["Personal user"],
			requirements: ["A non-empty todo can be created.", "Completed todos can be cleared."],
			domainLanguage: ["Todo is one persisted task; filter is a view, not stored state."],
			edgeCases: ["Whitespace-only input is rejected."],
			constraints: ["Todo content remains local."],
		},
	}) as any;
	assert.equal(artifact.type, "spec");
	assert.deepEqual(artifact.sections.requiredBehaviors, ["A non-empty todo can be created.", "Completed todos can be cleared."]);
	assert.deepEqual(artifact.sections.acceptanceCriteria, [
		{ id: "AC-001", statement: "A non-empty todo can be created." },
		{ id: "AC-002", statement: "Completed todos can be cleared." },
	]);
	assert.deepEqual(artifact.sections.domainLanguage, ["Todo is one persisted task; filter is a view, not stored state."]);
});

test("accepts concise author-facing design artifacts", () => {
	const artifact = normalizeResourceArtifact({ id: "todo-design", kind: "design", content: { goal: "Keep state transitions testable.", approach: ["Use one reducer."], components: ["App composes reducer-backed controls."], flow: ["Action updates state and persistence."], verification: ["Reducer and component tests cover transitions."] } }) as any;
	assert.equal(artifact.type, "design");
	assert.deepEqual(artifact.sections.chosenApproach, ["Use one reducer."]);
});

test("prohibits planner-authored evaluation resources", () => {
	assert.throws(() => normalizeResourceEvaluation({ id: "planner-check", kind: "regression" }, "checkout"), /cannot create evaluation/i);
	assert.throws(() => normalizePlanBundle({ workItem: { id: "checkout" }, tasks: [], stages: [], evaluations: [] }), /cannot contain evaluation/i);
});

test("normalizes and preserves explicit stage modes while keeping omission compatible", () => {
	assert.deepEqual(normalizePlanStage({ id: "ordered", tasks: ["one", "two"], mode: "sequential" }), { id: "ordered", tasks: ["one", "two"], checks: [], mode: "sequential" });
	assert.deepEqual(normalizePlanStage({ id: "parallel", tasks: ["one", "two"], mode: "concurrent" }), { id: "parallel", tasks: ["one", "two"], checks: [], mode: "concurrent" });
	assert.equal((normalizePlanStage({ id: "legacy", tasks: ["one"] }) as any).mode, undefined);
	assert.throws(() => normalizePlanStage({ id: "delivery", tasks: ["checkout"], mode: "unsupported" }), /unsupported execution mode/i);
});

test("normalizes structured verification checks while preserving legacy commands", () => {
	assert.deepEqual(normalizePlanStage({ id: "mobile", tasks: ["android"], checks: ["npm test", { id: "android-unit", command: "./gradlew test", profile: "android" }] }), {
		id: "mobile", tasks: ["android"], checks: ["npm test", { id: "android-unit", command: "./gradlew test", profile: "android" }],
	});
	assert.throws(() => normalizePlanStage({ id: "mobile", tasks: ["android"], checks: [{ id: "same", command: "one" }, { id: "same", command: "two" }] }), /duplicate check id/i);
});

test("normalizes explicit stage review decisions and requires substantive policies", () => {
	assert.deepEqual(normalizePlanStage({ id: "delivery", tasks: ["checkout"], checks: ["npm test"], review: { focus: ["Checkout correctness"] } }), { id: "delivery", tasks: ["checkout"], checks: ["npm test"], review: { mode: "required", tier: "medium", focus: ["Checkout correctness"] } });
	assert.deepEqual(normalizePlanStage({ id: "mechanical", tasks: ["format"], review: { mode: "skip", rationale: "Local mechanical change is fully covered by deterministic checks." } }), { id: "mechanical", tasks: ["format"], checks: [], review: { mode: "skip", rationale: "Local mechanical change is fully covered by deterministic checks." } });
	assert.throws(() => normalizePlanStage({ id: "delivery", tasks: ["checkout"], review: { tier: "high", focus: ["bugs"], rationale: "hard" } }), /substantive rationale and focus/i);
	assert.throws(() => normalizePlanStage({ id: "delivery", tasks: ["checkout"], review: { tier: "max" } }), /max is not available/i);
	assert.throws(() => normalizePlanStage({ id: "delivery", tasks: ["checkout"], review: { mode: "skip", rationale: "too short" } }), /substantive rationale/i);
	assert.throws(() => normalizePlanStage({ id: "delivery", tasks: ["checkout"], review: { mode: "skip", tier: "medium", rationale: "Deterministic checks fully cover this local mechanical stage." } }), /cannot declare tier or focus/i);
});

test("preserves stage mode through author-facing stage edits", () => {
	const created = normalizePlanEdit("stage", "create", "work-item:checkout/stage:ordered", { id: "ordered", tasks: ["one", "two"], mode: "sequential" }, "checkout");
	assert.equal((created.value as any).mode, "sequential");
	const updated = normalizePlanEdit("stage", "update", "work-item:checkout/stage:ordered", { mode: "concurrent" }, "checkout");
	assert.deepEqual(updated.value, { mode: "concurrent" });
});

test("expands concise self-contained task contracts", () => {
	const plan = normalizePlanBundle({
		workItem: {
			id: "compact-plan", title: "Compact plan",
			branchKind: "feature",
			intentSections: { problem: "Plans are verbose.", desiredOutcome: "Compact writes.", scopeIncluded: ["Planning"], successSignals: ["Structured output"] },
		},
		artifacts: [{ id: "behavior", type: "spec", sections: { context: "One behavior.", requiredBehaviors: ["Stay structured."], acceptanceCriteria: [{ id: "AC-001", statement: "The worker receives structured context." }] } }],
		tasks: [{
			id: "implement-behavior",
			goal: "Implement behavior.",
			context: ["The worker must receive a complete assignment without dereferencing story artifacts."],
			included: ["One vertical slice"],
			requiredWork: ["1. Implement the slice.", "2. Add and run the focused test."],
			acceptance: ["The worker receives the complete task contract."],
			checks: ["npm test -- behavior"],
		}],
	});
	assert.equal(plan.workItem.kind, "story");
	assert.equal(plan.workItem.branchKind, "feature");
	assert.equal(plan.workItem.delivery, undefined);
	assert.equal(plan.workItem.narrativeSchemaVersion, 2);
	const task = plan.tasks[0] as any;
	assert.equal(task.narrativeSchemaVersion, 2);
	assert.equal(task.manifest.status, "draft");
	assert.equal(task.manifest.execution.assignment.agent, "implementer");
	assert.equal(task.manifest.execution.assignment.role, undefined);
	assert.equal(task.manifest.assembly.stageId, "implement-behavior");
	assert.equal(task.manifest.references, undefined);
	assert.deepEqual(task.manifest.verification.taskChecks, ["npm test -- behavior"]);
	assert.deepEqual(task.briefSections.requiredWork, ["1. Implement the slice.", "2. Add and run the focused test."]);
	assert.match(task.briefSections.integrationExpectation, /implement-behavior/);
	assert.deepEqual(task.acceptanceSections.deliverables, ["Implement behavior."]);
	assert.deepEqual(task.acceptanceSections.acceptance, ["The worker receives the complete task contract."]);
	assert.deepEqual(plan.stages, []);
});

test("requires explicit justification for high and max planner routing", () => {
	assert.throws(() => normalizePlanBundle({
		workItem: { id: "high-plan", title: "High plan", branchKind: "feature", intentSections: { problem: "Complexity.", desiredOutcome: "Bounded work.", scopeIncluded: ["One slice"], successSignals: ["Tests"] } },
		tasks: [{ id: "high-task", goal: "Do the bounded work.", included: ["One vertical slice"], acceptance: ["The slice works."], assignment: { tier: "high" } }],
	}), /tierJustification/);
});

test("accepts local task routing only with recorded explicit user permission", () => {
	const plan = normalizePlanBundle({
		workItem: { id: "local-plan", title: "Local plan", branchKind: "feature", intentSections: { problem: "Local execution is blocked.", desiredOutcome: "Permission-gated local work.", scopeIncluded: ["One slice"], successSignals: ["Local task routing"] } },
		tasks: [{ id: "local-task", goal: "Do the bounded work locally.", included: ["One vertical slice"], acceptance: ["The slice works."], assignment: { tier: "local", rationale: "The user explicitly requested local execution for this task." } }],
	}) as any;
	assert.equal(plan.tasks[0].manifest.execution.assignment.tier, "local");
	assert.match(plan.tasks[0].manifest.execution.assignment.rationale, /user explicitly requested/i);
	assert.throws(() => normalizePlanBundle({
		workItem: { id: "unapproved-local", title: "Unapproved local", branchKind: "feature", intentSections: { problem: "Missing permission.", desiredOutcome: "Reject it.", scopeIncluded: ["One slice"], successSignals: ["Rejection"] } },
		tasks: [{ id: "local-task", goal: "Do work.", included: ["One slice"], acceptance: ["The slice works."], assignment: { tier: "local" } }],
	}), /permission-gated.*user/i);
});

test("keeps legacy artifact-referenced task plans readable", () => {
	const plan = normalizePlanBundle({
		workItem: { id: "legacy-plan", title: "Legacy plan", branchKind: "feature", intentSections: { problem: "Legacy task.", desiredOutcome: "Remain readable.", scopeIncluded: ["Compatibility"], successSignals: ["Normalization succeeds"] } },
		artifacts: [{ id: "behavior", type: "spec", sections: { context: "Legacy behavior.", requiredBehaviors: ["Remain compatible."], acceptanceCriteria: [{ id: "AC-001", statement: "The task remains readable." }] } }],
		tasks: [{ id: "legacy-task", briefSections: { contributionGoal: "Keep compatibility.", boundaryIncluded: ["Legacy task"] }, acceptanceSections: { criterionContributions: [{ criteria: ["behavior#AC-001"], contribution: "Preserve behavior." }], boundaryProof: ["Compatibility test passes"] } }],
	});
	const task = plan.tasks[0] as any;
	assert.deepEqual(task.manifest.references.specs, ["behavior"]);
	assert.match(task.briefSections.integrationExpectation, /legacy-task/);
});

test("normalizes a surgical self-contained task edit", () => {
	const edit = normalizePlanEdit("task", "update", "work-item:compact-plan/task:implement-behavior", {
		goal: "Corrected goal.",
		context: ["Correct the existing behavior without consulting an artifact pointer."],
		included: ["Corrected slice"],
		work: ["Implement correction"],
		acceptance: ["The corrected behavior is observable."],
		proof: ["Regression passes"],
		integrationExpectation: "Ready for the next stage.",
	}, "compact-plan");
	assert.equal(edit.action, "update");
	assert.equal((edit.value as any).narrativeSchemaVersion, 2);
	assert.equal((edit.value as any).briefSections.contributionGoal, "Corrected goal.");
	assert.deepEqual((edit.value as any).acceptanceSections.acceptance, ["The corrected behavior is observable."]);
	assert.equal((edit.value as any).manifest, undefined);
});

test("rejects silent or malformed surgical edits", () => {
	assert.throws(() => normalizePlanEdit("task", "update", "work-item:compact-plan/task:one", { typoField: "lost" }, "compact-plan"), /unknown field/i);
	assert.throws(() => normalizePlanEdit("task", "update", "work-item:compact-plan/task:one", { goal: "Half" }, "compact-plan"), /requires included/i);
	assert.throws(() => normalizePlanEdit("task", "update", "work-item:compact-plan/task:one", {}, "compact-plan"), /no changed fields/i);
	assert.throws(() => normalizePlanEdit("task", "delete", "work-item:compact-plan/task:one", {}, "compact-plan"), /does not accept value/i);
});
