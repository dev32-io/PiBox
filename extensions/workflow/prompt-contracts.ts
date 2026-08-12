export type PromptSurfaceCategory = "orchestrator" | "skill" | "role" | "dynamic" | "protocol" | "fallback" | "tool-pointer";

export interface PromptSurface {
	id: string;
	category: PromptSurfaceCategory;
	source: string;
	completion: "none" | "task_complete" | "evaluation_complete" | "exploration_complete" | "workflow_transition:submit" | "work_item_complete";
}

export const BUILT_IN_PROMPT_SURFACES: PromptSurface[] = [
	{ id: "orchestrator-contract", category: "orchestrator", source: "extensions/workflow/index.ts#ORCHESTRATOR_CONTRACT", completion: "none" },
	...[
		"workflow-discover", "workflow-plan", "workflow-run",
	].map((id): PromptSurface => ({ id, category: "skill", source: `skills/${id}/SKILL.md`, completion: id === "workflow-plan" ? "workflow_transition:submit" : id === "workflow-run" ? "work_item_complete" : "none" })),
	...[
		"explorer", "researcher", "plan-critic", "implementer", "test-implementer", "spec-reviewer", "quality-reviewer", "e2e-tester", "repair-implementer",
	].map((id): PromptSurface => ({ id, category: "role", source: `extensions/workflow/roles/${id}.md`, completion: id.includes("reviewer") || id === "e2e-tester" ? "evaluation_complete" : id.includes("implementer") ? "task_complete" : "none" })),
	{ id: "supervised-task", category: "dynamic", source: "extensions/workflow/supervisor.ts#taskPrompt", completion: "task_complete" },
	{ id: "planned-evaluator", category: "dynamic", source: "extensions/workflow/index.ts#launchManagedEvaluation", completion: "evaluation_complete" },
	{ id: "typed-explorer", category: "dynamic", source: "extensions/workflow/index.ts#exploration_launch", completion: "exploration_complete" },
	{ id: "task-protocol-nudge", category: "protocol", source: "extensions/workflow/supervisor.ts#taskPrompt", completion: "task_complete" },
	{ id: "evaluation-protocol-nudge", category: "protocol", source: "extensions/workflow/index.ts#launchManagedEvaluation", completion: "evaluation_complete" },
	{ id: "exploration-protocol-nudge", category: "protocol", source: "extensions/workflow/index.ts#exploration_launch", completion: "exploration_complete" },
	{ id: "missing-role-fallback", category: "fallback", source: "extensions/workflow-runtime/direct-agent.ts#runDirectAgent", completion: "none" },
	{ id: "orchestrator-tool-pointers", category: "tool-pointer", source: "extensions/workflow/index.ts#registerTool", completion: "none" },
	{ id: "worker-tool-pointers", category: "tool-pointer", source: "extensions/workflow/worker-capabilities.ts#registerWorkerCapabilities", completion: "task_complete" },
	{ id: "evaluator-tool-pointers", category: "tool-pointer", source: "extensions/workflow/evaluator-capabilities.ts#registerEvaluatorCapabilities", completion: "evaluation_complete" },
	{ id: "explorer-tool-pointers", category: "tool-pointer", source: "extensions/workflow/exploration-capabilities.ts#registerExplorationCapabilities", completion: "exploration_complete" },
];
