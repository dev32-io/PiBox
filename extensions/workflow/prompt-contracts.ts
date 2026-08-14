export type PromptSurfaceCategory = "orchestrator" | "skill" | "agent" | "dynamic" | "protocol" | "fallback" | "tool-pointer";

export interface PromptSurface {
	id: string;
	category: PromptSurfaceCategory;
	source: string;
	completion: "none" | "task_complete" | "evaluation_complete" | "exploration_complete" | "workflow_transition:submit" | "work_item_complete";
}

export const BUILT_IN_PROMPT_SURFACES: PromptSurface[] = [
	{ id: "orchestrator-contract", category: "orchestrator", source: "prompt/orchestrator-routing.md", completion: "none" },
	...[
		"product-discussion", "shape-story", "plan-delivery", "workflow-run",
	].map((id): PromptSurface => ({ id, category: "skill", source: `skills/${id}/SKILL.md`, completion: id === "plan-delivery" ? "workflow_transition:submit" : id === "workflow-run" ? "work_item_complete" : "none" })),
	...[
		"explorer", "researcher", "plan-critic", "implementer", "test-implementer", "spec-reviewer", "quality-reviewer", "e2e-tester", "repair-implementer",
	].map((id): PromptSurface => ({ id, category: "agent", source: `agent-definitions/${id}.md`, completion: id.includes("reviewer") || id === "e2e-tester" ? "evaluation_complete" : id.includes("implementer") ? "task_complete" : "none" })),
	{ id: "supervised-task", category: "dynamic", source: "prompt/managed-task.md", completion: "task_complete" },
	{ id: "implementation-context", category: "dynamic", source: "prompt/implementation-context.md", completion: "none" },
	{ id: "review-context", category: "dynamic", source: "prompt/review-context.md", completion: "none" },
	{ id: "managed-repair", category: "dynamic", source: "prompt/managed-repair.md", completion: "none" },
	{ id: "orchestrator-responses", category: "dynamic", source: "prompt/orchestrator-responses.md", completion: "none" },
	{ id: "design-context-pointer", category: "dynamic", source: "prompt/design-context-pointer.md", completion: "none" },
	...[
		"workflow-completion", "default-workflow-completion", "workflow-completion-worktrees-retained", "workflow-completion-worktrees-none", "workflow-completion-continued-branch", "workflow-completion-created-branch", "workflow-completion-unknown-branch",
	].map((id): PromptSurface => ({ id, category: "dynamic", source: `prompt/${id}.md`, completion: "none" })),
	{ id: "planned-evaluator", category: "dynamic", source: "prompt/managed-evaluation.md", completion: "evaluation_complete" },
	{ id: "typed-explorer", category: "dynamic", source: "prompt/managed-exploration.md", completion: "exploration_complete" },
	{ id: "task-protocol-nudge", category: "protocol", source: "prompt/task-protocol-nudge.md", completion: "task_complete" },
	{ id: "evaluation-protocol-nudge", category: "protocol", source: "prompt/evaluation-protocol-nudge.md", completion: "evaluation_complete" },
	{ id: "exploration-protocol-nudge", category: "protocol", source: "prompt/exploration-protocol-nudge.md", completion: "exploration_complete" },
	{ id: "missing-agent-fallback", category: "fallback", source: "prompt/default-agent.md", completion: "none" },
	{ id: "orchestrator-tool-pointers", category: "tool-pointer", source: "extensions/workflow/index.ts#registerTool", completion: "none" },
	{ id: "progressive-workflow-reads", category: "tool-pointer", source: "extensions/workflow/progressive-disclosure.ts#paginateCatalog", completion: "none" },
	{ id: "worker-tool-pointers", category: "tool-pointer", source: "extensions/workflow/worker-capabilities.ts#registerWorkerCapabilities", completion: "task_complete" },
	{ id: "evaluator-tool-pointers", category: "tool-pointer", source: "extensions/workflow/evaluator-capabilities.ts#registerEvaluatorCapabilities", completion: "evaluation_complete" },
	{ id: "explorer-tool-pointers", category: "tool-pointer", source: "extensions/workflow/exploration-capabilities.ts#registerExplorationCapabilities", completion: "exploration_complete" },
];
