import assert from "node:assert/strict";
import test from "node:test";
import { createHarnessWorkflowAdapter } from "../workflow-adapter.js";

function task(id: string, status: string, dependsOn: string[] = []) {
	return { id, title: id, status, dependsOn, execution: { parallelism: "allowed", resourceClaims: [id] } };
}

test("derives and refreshes task, integration, and evaluation steps without copying a workflow graph", async () => {
	let tasks: any[] = [task("first", "ready"), task("second", "blocked", ["first"])];
	let evaluation: any = { id: "review", status: "planned", scope: { integrationUnit: "delivery" } };
	const item: any = { id: "example", title: "Example", planning: { status: "approved" }, tasks: [{ id: "first" }, { id: "second" }], integrationUnits: [{ id: "delivery", tasks: ["first", "second"] }], evaluations: [{ id: "review" }] };
	const runtime: any = {
		workItems: { async read() { return item; }, async activateDraftTasks() { return []; }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); }, async readEvaluation() { return evaluation; } },
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.deepEqual(snapshot.steps.map((step) => [step.kind, step.status]), [["task", "ready"], ["task", "pending"], ["integration", "pending"], ["evaluation", "pending"]]);

	tasks = [task("first", "integrated"), task("second", "ready", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:second"))?.status, "ready");

	tasks = [task("first", "contribution_complete"), task("second", "contribution_complete", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "integration")?.status, "ready");

	tasks = [task("first", "integrated"), task("second", "integrated", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "ready");
	evaluation = { ...evaluation, status: "passed" };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.status, "done");
});
