import assert from "node:assert/strict";
import test from "node:test";
import { plannerBoundariesBenchmarkSuite } from "../suites/planner-boundaries/suite.js";

const expectedScenarios = [
	"coherent-feature-lanes",
	"independent-agent-fanout",
	"expand-migrate-contract",
	"shared-state-machine",
	"cross-platform-context-limits",
];

test("planner suite replaces old planning scenarios with agent-boundary cases", () => {
	assert.equal(plannerBoundariesBenchmarkSuite.version, "1.0.0");
	assert.deepEqual(plannerBoundariesBenchmarkSuite.scenarios.map((scenario) => scenario.id), expectedScenarios);
	assert.deepEqual(plannerBoundariesBenchmarkSuite.conditions.map((condition) => condition.id), ["current-skill"]);
});

test("planner suite loads the current skill and requires a bounded JSON plan sketch", () => {
	const scenario = plannerBoundariesBenchmarkSuite.scenarios[0]!;
	const condition = plannerBoundariesBenchmarkSuite.conditions[0]!;
	const built = plannerBoundariesBenchmarkSuite.buildPrompt(scenario, condition);
	assert.match(built.instruction, /Tasks are fresh-agent boundaries/);
	assert.doesNotMatch(built.instruction, /fresh-worker|coherent actors/i);
	assert.match(built.prompt, /Every required step ID must appear in exactly one task/);
	assert.match(built.prompt, /"mode": "sequential\|concurrent"/);
});

test("planner scorer rewards coherent lanes and safe concurrency", () => {
	const scenario = plannerBoundariesBenchmarkSuite.scenarios.find((entry) => entry.id === "coherent-feature-lanes")!;
	const parsed = plannerBoundariesBenchmarkSuite.parse(JSON.stringify({
		tasks: [
			{ id: "platform", goal: "Build companion platform", covers: ["P1", "P2", "P3"], dependsOn: [], stageId: "foundations" },
			{ id: "data", goal: "Build Story Board data surface", covers: ["D1", "D2", "D3"], dependsOn: [], stageId: "foundations" },
			{ id: "browser", goal: "Build browser experience", covers: ["U1", "U2"], dependsOn: ["platform", "data"], stageId: "experience" },
		],
		stages: [
			{ id: "foundations", mode: "concurrent", tasks: ["platform", "data"], review: "required" },
			{ id: "experience", mode: "sequential", tasks: ["browser"], review: "skip" },
		],
		rationale: "Three coherent fresh-agent boundaries with parallel foundations.",
	}));
	const score = plannerBoundariesBenchmarkSuite.score(scenario, parsed);
	assert.equal(score.passed, true);
	assert.equal(score.normalized, 100);
});

test("planner scorer rejects implementation-step over-decomposition", () => {
	const scenario = plannerBoundariesBenchmarkSuite.scenarios.find((entry) => entry.id === "shared-state-machine")!;
	const tasks = ["S1", "S2", "S3", "S4", "S5", "K1"].map((step, index) => ({ id: `task-${step.toLowerCase()}`, goal: `Implement ${step}`, covers: [step], dependsOn: [], stageId: `stage-${index}` }));
	const parsed = plannerBoundariesBenchmarkSuite.parse(JSON.stringify({
		tasks,
		stages: tasks.map((task, index) => ({ id: `stage-${index}`, mode: "sequential", tasks: [task.id], review: "skip" })),
		rationale: "One task per implementation step.",
	}));
	const score = plannerBoundariesBenchmarkSuite.score(scenario, parsed);
	assert.equal(score.passed, false);
	assert.ok(score.normalized < 80);
});
