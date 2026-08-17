import assert from "node:assert/strict";
import test from "node:test";
import { HarnessError } from "../errors.js";
import { resolveStageMode, taskExecutionTopology, validateExecutionTopology } from "../execution-topology.js";

function task(id: string, dependsOn: string[] = [], resourceClaims: string[] = [], runtime?: any): any {
	return { id, dependsOn, execution: { resourceClaims }, runtime };
}
function item(stages: any[], tasks: any[], delivery: any = { workingBranch: "feature/example" }): any {
	return { id: "example", executionStages: stages, delivery, tasks: tasks.map((entry) => ({ id: entry.id })) };
}
function invalid(fn: () => void, message: string): void {
	assert.throws(fn, (error: unknown) => error instanceof HarnessError && error.code === "INVALID_ARTIFACT" && error.message.includes(message));
}

test("resolves explicit modes and legacy topology", () => {
	assert.equal(resolveStageMode({ id: "one", tasks: ["a"] }), "sequential");
	assert.equal(resolveStageMode({ id: "many", tasks: ["a", "b"] }), "concurrent");
	assert.equal(resolveStageMode({ id: "explicit", mode: "sequential", tasks: ["a", "b"] }), "sequential");
	assert.equal(resolveStageMode({ id: "explicit", mode: "concurrent", tasks: ["a"] }), "concurrent");

	const sequential = taskExecutionTopology(item([{ id: "stage", tasks: ["a", "b"], mode: "sequential" }], [task("a"), task("b")]), task("b"));
	assert.equal(sequential.mode, "sequential");
	assert.equal(sequential.isolation, "repository");
	assert.equal(sequential.parallelism, "serial");
	const concurrent = taskExecutionTopology(item([{ id: "stage", tasks: ["a", "b"] }], [task("a"), task("b")]), task("a"));
	assert.equal(concurrent.mode, "concurrent");
	assert.equal(concurrent.isolation, "worktree");
	assert.equal(concurrent.parallelism, "allowed");
});

test("retains persisted recovery isolation over the resolved stage", () => {
	const recovered = taskExecutionTopology(item([{ id: "stage", tasks: ["a", "b"], mode: "sequential" }], [task("a"), task("b", [], [], { executionMode: "worktree", branch: "harness/example/b" })]), task("b", [], [], { executionMode: "worktree", branch: "harness/example/b" }));
	assert.equal(recovered.mode, "sequential");
	assert.equal(recovered.isolation, "worktree");
});

test("checks claims only for concurrent stages and validates dependency placement", () => {
	assert.doesNotThrow(() => validateExecutionTopology(item([{ id: "stage", mode: "sequential", tasks: ["a", "b"] }], [task("a", [], ["shared"]), task("b", ["a"], ["shared"])]), [task("a", [], ["shared"]), task("b", ["a"], ["shared"])]));
	invalid(() => validateExecutionTopology(item([{ id: "stage", mode: "concurrent", tasks: ["a", "b"] }], [task("a", [], ["shared"]), task("b", [], ["shared"])]), [task("a", [], ["shared"]), task("b", [], ["shared"])]), "conflicting resource claim");
	invalid(() => validateExecutionTopology(item([{ id: "stage", mode: "concurrent", tasks: ["a", "b"] }], [task("a"), task("b", ["a"])]), [task("a"), task("b", ["a"])]), "same-stage dependency");
	invalid(() => validateExecutionTopology(item([{ id: "stage", mode: "sequential", tasks: ["a", "b"] }], [task("a", ["b"]), task("b")]), [task("a", ["b"]), task("b")]), "declares a before its dependency");
});

test("requires dependencies to be scheduled in an earlier stage", () => {
	invalid(() => validateExecutionTopology(item([{ id: "first", tasks: ["b"] }, { id: "second", tasks: ["a"] }], [task("a"), task("b", ["a"])]), [task("a"), task("b", ["a"])]), "earlier execution stage");
	invalid(() => validateExecutionTopology(item([{ id: "stage", tasks: ["a"] }], [task("a", ["missing"])]), [task("a", ["missing"])]), "unknown or unscheduled");
});
