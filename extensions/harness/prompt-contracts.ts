export type PromptSurfaceCategory = "orchestrator" | "skill" | "role" | "dynamic" | "protocol" | "fallback" | "tool-pointer";

export interface PromptSurface {
	id: string;
	category: PromptSurfaceCategory;
	source: string;
	completion: "none" | "task_complete" | "evaluation_complete" | "planning_submit" | "work_item_complete";
}

export const BUILT_IN_PROMPT_SURFACES: PromptSurface[] = [
	{ id: "orchestrator-contract", category: "orchestrator", source: "extensions/harness/index.ts#ORCHESTRATOR_CONTRACT", completion: "none" },
	...[
		"harness-research", "harness-plan", "harness-execute", "harness-evaluate", "harness-recover", "harness-init",
	].map((id): PromptSurface => ({ id, category: "skill", source: `skills/${id}/SKILL.md`, completion: id === "harness-plan" ? "planning_submit" : id === "harness-evaluate" ? "work_item_complete" : "none" })),
	...[
		"explorer", "researcher", "plan-critic", "implementer", "test-implementer", "spec-reviewer", "quality-reviewer", "e2e-tester", "repair-implementer",
	].map((id): PromptSurface => ({ id, category: "role", source: `extensions/harness/roles/${id}.md`, completion: id.includes("reviewer") || id === "e2e-tester" ? "evaluation_complete" : id.includes("implementer") ? "task_complete" : "none" })),
	{ id: "supervised-task", category: "dynamic", source: "extensions/harness/supervisor.ts#taskPrompt", completion: "task_complete" },
	{ id: "planned-evaluator", category: "dynamic", source: "extensions/harness/index.ts#evaluation_launch", completion: "evaluation_complete" },
	{ id: "task-protocol-nudge", category: "protocol", source: "extensions/harness/supervisor.ts#taskPrompt", completion: "task_complete" },
	{ id: "evaluation-protocol-nudge", category: "protocol", source: "extensions/harness/index.ts#evaluation_launch", completion: "evaluation_complete" },
	{ id: "missing-role-fallback", category: "fallback", source: "extensions/harness/direct-agent.ts#runDirectAgent", completion: "none" },
	{ id: "orchestrator-tool-pointers", category: "tool-pointer", source: "extensions/harness/index.ts#registerTool", completion: "none" },
	{ id: "worker-tool-pointers", category: "tool-pointer", source: "extensions/harness/worker-capabilities.ts#registerWorkerCapabilities", completion: "task_complete" },
	{ id: "evaluator-tool-pointers", category: "tool-pointer", source: "extensions/harness/evaluator-capabilities.ts#registerEvaluatorCapabilities", completion: "evaluation_complete" },
];
