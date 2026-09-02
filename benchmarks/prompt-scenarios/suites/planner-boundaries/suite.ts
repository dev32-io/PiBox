import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PromptBenchmarkSuite, PromptCondition, PromptScenario } from "../../types.js";
import { parsePlannerOutput, scorePlannerScenario, type PlannerBenchmarkOutput } from "./scorer.js";

const plannerSkillPath = fileURLToPath(new URL("../../../../skills/plan-delivery/SKILL.md", import.meta.url));
const plannerSkill = readFileSync(plannerSkillPath, "utf8").trim();

const currentSkill: PromptCondition = {
	id: "current-skill",
	role: "baseline",
	title: "Current plan-delivery skill",
	version: "1.0.0",
	description: "The current repository planner skill, loaded directly for each benchmark invocation.",
	render() {
		return { variantId: "current-skill@1.0.0", instruction: plannerSkill, sourceRefs: ["skills/plan-delivery/SKILL.md"] };
	},
};

const scenarios: PromptScenario[] = [
	{
		id: "coherent-feature-lanes",
		title: "Coherent feature lanes",
		description: "Collapse implementation steps into three context-coherent agent assignments while exposing platform and data work concurrently.",
		fixture: `A reviewed Visual Companion story has these required changes. P1 generalize the viewer registry; P2 build the shared shell and navigation; P3 wire one idempotent service lifecycle. These share backend/shell lifecycle invariants and nearby files. D1 define Story Board projections; D2 implement catalog/workspace/document/report readers; D3 add the lazy cache and HTTP API. These share canonical-artifact parsing, containment, and lazy-loading invariants. U1 render catalog, task, document, and report views; U2 complete responsive accessibility and keyboard behavior. These share the same browser assets and interaction model. Platform work P1-P3 and data work D1-D3 can start from the same base. Browser work U1-U2 needs the integrated shell and data API. Plan the tasks and stages.`,
		metadata: { expectations: { requiredSteps: ["P1", "P2", "P3", "D1", "D2", "D3", "U1", "U2"], together: [["P1", "P2", "P3"], ["D1", "D2", "D3"], ["U1", "U2"]], separate: [["P1", "D1", "U1"]], concurrent: [["P1", "D1"]], ordered: [["P1", "U1"], ["D1", "U1"]], minTasks: 3, maxTasks: 3 } },
	},
	{
		id: "independent-agent-fanout",
		title: "Independent agent fan-out",
		description: "Preserve four substantial independent assignments and place all of them in one concurrent stage.",
		fixture: `A reviewed maintenance story uses an already-stable plugin contract. A1 adds an S3 import adapter and focused contract tests under adapters/s3. B1 adds a Google Drive import adapter and focused contract tests under adapters/gdrive. C1 adds a read-only audit CLI under tools/audit. D1 adds an admin usage report under web/admin. The four contributions have disjoint files, no shared mutable fixture, no dependency on each other's implementation, and each is substantial enough for one fresh agent. Plan the tasks and stages.`,
		metadata: { expectations: { requiredSteps: ["A1", "B1", "C1", "D1"], separate: [["A1", "B1", "C1", "D1"]], concurrent: [["A1", "B1", "C1", "D1"]], minTasks: 4, maxTasks: 4 } },
	},
	{
		id: "expand-migrate-contract",
		title: "Expand, parallel migrate, contract",
		description: "Use durable-output barriers around parallel web and mobile migrations.",
		fixture: `A reviewed compatibility migration has these required changes. E1 introduces the versioned command contract and compatibility adapter, leaving the old contract usable. W1 migrates all web consumers and W2 adds focused web compatibility tests; they share one web context. M1 migrates all mobile consumers and M2 adds focused mobile compatibility tests; they share one mobile context. Web and mobile migration can proceed independently only after E1 is integrated. C1 removes the old contract and runs final compatibility checks only after both consumer groups are migrated. Plan the tasks and stages.`,
		metadata: { expectations: { requiredSteps: ["E1", "W1", "W2", "M1", "M2", "C1"], together: [["W1", "W2"], ["M1", "M2"]], separate: [["E1", "W1", "M1", "C1"]], concurrent: [["W1", "M1"]], ordered: [["E1", "W1"], ["E1", "M1"], ["W1", "C1"], ["M1", "C1"]], minTasks: 4, maxTasks: 4 } },
	},
	{
		id: "shared-state-machine",
		title: "Shared state-machine context",
		description: "Keep CRUD-like mutation branches together instead of decomposing one state machine into tiny tasks.",
		fixture: `A reviewed calendar mutation story requires S1 create mutations, S2 whole-series and occurrence updates, S3 scoped deletes, S4 authorization and revision gates, and S5 atomic rollback tests. All five changes live in the same mutation service and share recurrence identity, authorization, transaction, and rollback invariants. K1 independently updates an SDK adapter against an already-stable public command shape; it uses disjoint files and does not need the mutation implementation. The mutation service and SDK adapter can start from the same base. Plan the tasks and stages.`,
		metadata: { expectations: { requiredSteps: ["S1", "S2", "S3", "S4", "S5", "K1"], together: [["S1", "S2", "S3", "S4", "S5"]], separate: [["S1", "K1"]], concurrent: [["S1", "K1"]], minTasks: 2, maxTasks: 2 } },
	},
	{
		id: "cross-platform-context-limits",
		title: "Cross-platform context limits",
		description: "Split a broad story at coherent web, shared-mobile, Android, and iOS agent boundaries.",
		fixture: `A reviewed offline calendar experience has these required changes. F1 builds the shared mobile cache and retention policy; F2 adds its deterministic offline/recovery tests. W1 builds the web calendar controller and W2 renders the web calendar experience; these share web state and browser tests but do not consume the mobile cache. A1 builds Android presentation and platform tests using the integrated shared mobile cache. I1 builds iOS presentation and platform tests using the integrated shared mobile cache. Android and iOS use disjoint platform files and can proceed independently after F1-F2. The web and shared-mobile assignments can start from the same base. Plan the tasks and stages.`,
		metadata: { expectations: { requiredSteps: ["F1", "F2", "W1", "W2", "A1", "I1"], together: [["F1", "F2"], ["W1", "W2"]], separate: [["F1", "W1", "A1", "I1"]], concurrent: [["F1", "W1"], ["A1", "I1"]], ordered: [["F1", "A1"], ["F1", "I1"]], minTasks: 4, maxTasks: 4 } },
	},
];

const OUTPUT_GUIDANCE = `Return exactly one JSON object with this shape:
{
  "tasks": [{ "id": "kebab-case", "goal": "one coherent contribution", "covers": ["required step IDs"], "dependsOn": ["task IDs"], "stageId": "stage-id" }],
  "stages": [{ "id": "stage-id", "mode": "sequential|concurrent", "tasks": ["task IDs in execution order"], "review": "required|skip" }],
  "rationale": "brief explanation of the agent boundaries and concurrency"
}
Every required step ID must appear in exactly one task. Do not add implementation work that is absent from the scenario. This is a plan sketch benchmark: do not use tools, write resources, or execute the workflow.`;

export const plannerBoundariesBenchmarkSuite: PromptBenchmarkSuite<PlannerBenchmarkOutput> = {
	id: "planner-agent-boundaries",
	title: "Planner Agent-Boundary Benchmark",
	version: "1.0.0",
	scorerVersion: "agent-boundaries@1.0.0",
	description: "Tests whether the current planner skill chooses coherent fresh-agent tasks and safe concurrent stages.",
	baselineConditionId: "current-skill",
	conditions: [currentSkill],
	scenarios,
	buildPrompt(scenario, condition) {
		const rendered = condition.render(scenario);
		return { ...rendered, prompt: `You are completing one bounded planner prompt benchmark. Use only the supplied instruction and scenario.\n\n<planner-skill>\n${rendered.instruction}\n</planner-skill>\n\n<scenario>\n${scenario.fixture}\n</scenario>\n\n${OUTPUT_GUIDANCE}` };
	},
	parse: parsePlannerOutput,
	score: scorePlannerScenario,
};
