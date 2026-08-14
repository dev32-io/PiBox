import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlanBundle, normalizePlanEdit } from "../plan-authoring.js";

test("expands compact plan fields while preserving structured task contracts", () => {
	const plan = normalizePlanBundle({
		workItem: {
			id: "compact-plan", title: "Compact plan",
			delivery: { branchType: "feature" },
			intentSections: { problem: "Plans are verbose.", desiredOutcome: "Compact writes.", scopeIncluded: ["Planning"], successSignals: ["Structured output"] },
		},
		artifacts: [{ id: "behavior", type: "spec", sections: { context: "One behavior.", requiredBehaviors: ["Stay structured."], acceptanceCriteria: [{ id: "AC-001", statement: "The worker receives structured context." }] } }],
		tasks: [{
			id: "implement-behavior",
			briefSections: { contributionGoal: "Implement behavior.", boundaryIncluded: ["One vertical slice"] },
			acceptanceSections: { criterionContributions: [{ criteria: ["behavior#AC-001"], contribution: "Implement the criterion." }], boundaryProof: ["Focused test passes"] },
		}],
	});
	assert.equal(plan.workItem.kind, "story");
	assert.deepEqual(plan.workItem.delivery, { branchType: "feature", branchMode: "create", baseBranch: "develop" });
	assert.equal(plan.workItem.narrativeSchemaVersion, 2);
	const task = plan.tasks[0] as any;
	assert.equal(task.narrativeSchemaVersion, 2);
	assert.equal(task.manifest.status, "draft");
	assert.equal(task.manifest.execution.assignment.agent, "implementer");
	assert.equal(task.manifest.execution.assignment.role, undefined);
	assert.equal(task.manifest.assembly.stageId, "implement-behavior");
	assert.deepEqual(task.manifest.references.specs, ["behavior"]);
	assert.deepEqual(task.briefSections.requiredWork, ["One vertical slice"]);
	assert.match(task.briefSections.integrationExpectation, /implement-behavior/);
	assert.deepEqual(task.acceptanceSections.deliverables, ["Implement behavior."]);
	assert.deepEqual(plan.integrationUnits, []);
	assert.deepEqual(plan.evaluations, []);
});

test("normalizes a surgical task edit without requiring a complete-plan rewrite", () => {
	const edit = normalizePlanEdit("task", "update", "work-item:compact-plan/task:implement-behavior", {
		briefSections: { contributionGoal: "Corrected goal.", boundaryIncluded: ["Corrected slice"], requiredWork: ["Implement correction"], integrationExpectation: "Ready for the next stage." },
		acceptanceSections: { deliverables: ["Correction"], criterionContributions: [{ criteria: ["behavior#AC-001"], contribution: "Correct behavior." }], boundaryProof: ["Regression passes"] },
	}, "compact-plan");
	assert.equal(edit.action, "update");
	assert.equal((edit.value as any).narrativeSchemaVersion, 2);
	assert.equal((edit.value as any).briefSections.contributionGoal, "Corrected goal.");
	assert.equal((edit.value as any).manifest, undefined);
});

test("rejects silent or malformed surgical edits", () => {
	assert.throws(() => normalizePlanEdit("task", "update", "work-item:compact-plan/task:one", { typoField: "lost" }, "compact-plan"), /unknown field/i);
	assert.throws(() => normalizePlanEdit("task", "update", "work-item:compact-plan/task:one", { briefSections: { contributionGoal: "Half" } }, "compact-plan"), /briefSections and acceptanceSections together/i);
	assert.throws(() => normalizePlanEdit("task", "update", "work-item:compact-plan/task:one", {}, "compact-plan"), /no changed fields/i);
	assert.throws(() => normalizePlanEdit("task", "delete", "work-item:compact-plan/task:one", {}, "compact-plan"), /does not accept value/i);
});
