import assert from "node:assert/strict";
import test from "node:test";
import { createHarnessWorkflowAdapter } from "../workflow-adapter.js";

function task(id: string, status: string, dependsOn: string[] = [], stageId = "delivery") {
	return { id, title: id, status, dependsOn, execution: { resourceClaims: [id] }, assembly: { stageId } };
}

test("exposes dynamic agent delegation through the workflow adapter", async () => {
	let captured: any;
	const expected: any = { ref: "agent:critic", state: "completed", summary: "ready", agentId: "critic" };
	const adapter = createHarnessWorkflowAdapter({
		runtimeFor: async () => ({} as any), launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }),
		spawnSubagent: async (request) => { captured = request; return expected; },
	});
	const request: any = { operationId: "spawn-1", agent: "plan-critic", task: "Review" };
	assert.equal(await adapter.spawnSubagent?.(request, {} as any), expected);
	assert.deepEqual(captured, request);
});

test("workflow preparation serializes branch setup, execution state, and task activation", async () => {
	const calls: string[] = [];
	let insideMutex = false;
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async submitPlanning() { calls.push(`submit:${insideMutex}`); },
			async beginExecution(id: string) { calls.push(`begin:${insideMutex}`); return { id, phase: "execution", planning: { revision: 1 } }; },
			async ensureFinalEvaluations() { calls.push(`final:${insideMutex}`); return []; },
			async activateDraftTasks() { calls.push(`activate:${insideMutex}`); return []; },
		},
		mutex: { async run(_owner: string, operation: () => Promise<unknown>) { insideMutex = true; try { return await operation(); } finally { insideMutex = false; } } },
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), prepareFeatureBranch: async () => { calls.push(`branch:${insideMutex}`); } });
	await adapter.prepareWorkflow?.("work-item:example", {} as any);
	assert.deepEqual(calls, ["submit:true", "branch:true", "begin:true", "final:true", "activate:true"]);
});

test("resume prepares stopped tasks from current dependency state", async () => {
	const tasks: any[] = [task("first", "integrated"), task("second", "cancelled", ["first"]), task("third", "failed", ["second"])];
	const item: any = { id: "example", planning: { revision: 1 }, delivery: { baseBranch: "main", featureBranch: "feature/example" }, tasks: tasks.map(({ id }) => ({ id })), integrationUnits: [], evaluations: [] };
	const updates: Array<[string, string]> = [];
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async submitPlanning() {},
			async beginExecution() { return item; },
			async ensureFinalEvaluations() { return []; },
			async activateDraftTasks() { return []; },
			async read() { return item; },
			async readTask(_workItemId: string, id: string) { return tasks.find((entry) => entry.id === id); },
			async updateTask(_workItemId: string, id: string, update: any) { updates.push([id, update.status]); tasks.find((entry) => entry.id === id).status = update.status; },
		},
		mutex: { async run(_owner: string, operation: () => Promise<unknown>) { return operation(); } },
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), prepareFeatureBranch: async () => {} });
	await adapter.controlWorkflow("work-item:example", "resume", {} as any);
	assert.deepEqual(updates, [["second", "ready"], ["third", "blocked"]]);
});

test("renders a review-fix loop as one checkpoint step with phase and iteration", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "final-review" }] };
	const evaluation: any = { id: "final-review", type: "combined-review", checkpoint: "final-e2e", scope: { workItem: "example" }, status: "planned", required: true, attempt: 1, methods: [], loop: { state: "rereviewing", iteration: 2, maxIterations: 3 } };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.length, 1);
	assert.match(snapshot.steps[0]!.title, /Review loop final-review · re-reviewing #2/);
	assert.equal(snapshot.steps[0]!.status, "ready");
});

test("stop ignores reported agents whose process already exited", async () => {
	const reported = { id: "reviewer", workItemId: "example", state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited" }] };
	let reads = 0;
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: { async read() { return { id: "example", planning: { revision: 1 }, tasks: [], evaluations: [] }; } },
		agents: { async list() { return [reported]; }, async get() { reads++; return reported; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	await adapter.controlWorkflow("work-item:example", "stop", {} as any);
	assert.equal(reads, 0, "settled agents are not sent through process signaling");
	const result = await adapter.controlSubagent(reported.id, "stop", {} as any) as any;
	assert.equal(result.signaled, false);
});

test("derives task, integration, and evaluation steps without mutating canonical state", async () => {
	let tasks: any[] = [task("first", "ready"), task("second", "blocked", ["first"])];
	let evaluation: any = { id: "review", status: "planned", scope: { integrationUnit: "delivery" } };
	let agents: any[] = [];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, delivery: { baseBranch: "main", featureBranch: "feature/example" }, tasks: [{ id: "first" }, { id: "second" }], executionStages: [{ id: "delivery", tasks: ["first", "second"] }], integrationUnits: [{ id: "delivery", tasks: ["first", "second"] }], evaluations: [{ id: "review" }] };
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: { async read() { return item; }, async activateDraftTasks() { throw new Error("snapshot must be read-only"); }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); }, async readEvaluation() { return evaluation; } },
		agents: { async list() { return agents; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.deepEqual(snapshot.steps.map((step) => [step.kind, step.status]), [["task", "ready"], ["task", "pending"], ["evaluation", "pending"]]);

	tasks = [task("first", "integrated"), task("second", "ready", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:second"))?.status, "ready");

	tasks = [task("first", "contribution_complete"), task("second", "contribution_complete", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:first"))?.status, "ready");

	tasks = [task("first", "merged"), task("second", "merged", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "ready");
	evaluation = { ...evaluation, status: "passed" };
	agents = [{ id: "old-review", state: "reported", evaluationId: "review", updatedAt: new Date(0).toISOString(), attempts: [{ id: "attempt", state: "exited" }], currentAttemptId: "attempt" }];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.status, "done", "canonical completion wins over a stale reported agent");
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "done");
});

test("derives a mixed task/evaluation staged graph from explicit true dependencies", async () => {
	const tasks: any[] = [task("implement", "merged", [], "build")];
	const evaluations: any = [
		{ id: "focused-check", type: "deterministic", status: "planned", scope: { workItem: "mixed" }, stageId: "verify", dependsOn: ["implement"] },
	];
	const item: any = { id: "mixed", title: "Mixed", planning: { revision: 1 }, tasks: [{ id: "implement" }], executionStages: [
		{ id: "build", tasks: ["implement"], nodes: [{ kind: "task", id: "implement" }] },
		{ id: "verify", tasks: [], nodes: [{ kind: "evaluation", id: "focused-check" }] },
	], integrationUnits: [], evaluations: [{ id: "focused-check" }] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readTask() { return tasks[0]; }, async readEvaluation() { return evaluations[0]; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:mixed", {} as any);
	const evaluation = snapshot.steps.find((step) => step.ref.endsWith("evaluation:focused-check"))!;
	assert.deepEqual(evaluation.dependsOn, ["work-item:mixed/task:implement"]);
	assert.equal(snapshot.stages?.[1]?.parallel, false);
	assert.equal(snapshot.stages?.[1]?.nodes[0], "evaluation:focused-check");
});

test("derives singleton repository execution and parallel stage merge barriers", async () => {
	const tasks: any[] = [task("first", "ready", [], "serial"), task("left", "ready", ["first"], "parallel"), task("right", "ready", ["first"], "parallel")];
	const item: any = { id: "topology", title: "Topology", planning: { revision: 1 }, tasks: tasks.map(({ id }) => ({ id })), executionStages: [{ id: "serial", tasks: ["first"] }, { id: "parallel", tasks: ["left", "right"] }], integrationUnits: [], evaluations: [] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async activateDraftTasks() { return []; }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:topology", {} as any);
	const first = snapshot.steps.find((step) => step.ref.endsWith("task:first"))!;
	assert.equal(first.parallelism, "serial"); assert.deepEqual(first.resourceClaims, ["feature-branch"]);
	tasks[0].status = "merged";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	for (const id of ["left", "right"]) { const step = snapshot.steps.find((candidate) => candidate.ref.endsWith(`task:${id}`))!; assert.equal(step.status, "ready"); assert.equal(step.parallelism, "allowed"); assert.deepEqual(step.resourceClaims, [id]); }
	tasks[1].status = "contribution_complete";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.status, "pending");
	tasks[2].status = "contribution_complete";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.status, "ready");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.kind, "merge");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:right"))?.status, "pending");
});

test("final branch review follows an adopted semantic journey gate instead of a fixed evaluation id", async () => {
	const tasks: any[] = [task("implementation", "merged")];
	const item: any = {
		id: "legacy", title: "Legacy", planning: { revision: 1 }, tasks: [{ id: "implementation" }],
		executionStages: [{ id: "delivery", tasks: ["implementation"] }], integrationUnits: [],
		evaluations: [{ id: "planned-journey" }, { id: "final-branch-review" }],
	};
	let journeyStatus = "planned";
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async read() { return item; },
			async readTask() { return tasks[0]; },
			async readEvaluation(_workItemId: string, id: string) {
				return id === "planned-journey"
					? { id, type: "e2e", scope: { workItem: "legacy" }, status: journeyStatus }
					: { id, type: "combined-review", checkpoint: "final-review", scope: { workItem: "legacy" }, status: "planned" };
			},
		},
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:legacy", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:planned-journey"))?.status, "ready");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:final-branch-review"))?.status, "pending");
	journeyStatus = "passed";
	snapshot = await adapter.snapshot("work-item:legacy", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:final-branch-review"))?.status, "ready");
});

test("does not render exited or reported evaluation agents as running", async () => {
	const tasks: any[] = [task("first", "merged")];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [{ id: "first" }], executionStages: [{ id: "delivery", tasks: ["first"] }], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", status: "planned", scope: { workItem: "example" } };
	let agent: any = { id: "reviewer", state: "running", evaluationId: "review", updatedAt: new Date().toISOString(), currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "running" }] };
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: { async read() { return item; }, async activateDraftTasks() { return []; }, async readTask() { return tasks[0]; }, async readEvaluation() { return evaluation; } },
		agents: { async list() { return [agent]; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "running");

	agent = { ...agent, state: "reported", attempts: [{ id: "attempt", state: "exited" }] };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "attention");
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.detail, "result pending reconciliation");

	agent = { ...agent, state: "running" };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "attention");
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.detail, "stale process state");

	evaluation.loop = { state: "fixing", iteration: 1, maxIterations: 2 };
	agent = { ...agent, state: "running", attempts: [{ id: "attempt", state: "running" }] };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "running", "active fixer wins over the ready loop label");
});
