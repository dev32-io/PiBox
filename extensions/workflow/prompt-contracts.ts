export type PromptSurfaceCategory = "orchestrator" | "skill" | "agent" | "dynamic" | "protocol" | "fallback" | "tool-pointer";
export interface PromptSurface { id: string; category: PromptSurfaceCategory; source: string; completion: "none" | "workflow_compile" }

export const BUILT_IN_PROMPT_SURFACES: PromptSurface[] = [
	{ id: "orchestrator-contract", category: "orchestrator", source: "prompt/orchestrator-routing.md", completion: "none" },
	...["product-discussion", "shape-story", "plan-delivery", "workflow-run", "distill"].map((id): PromptSurface => ({ id, category: "skill", source: `skills/${id}/SKILL.md`, completion: id === "shape-story" || id === "plan-delivery" ? "workflow_compile" : "none" })),
	...["general-purpose", "explorer", "knowledge-distiller", "plan-critic", "implementer", "code-reviewer", "e2e-tester", "repair-implementer"].map((id): PromptSurface => ({ id, category: "agent", source: `agent-definitions/${id}.md`, completion: "none" })),
	{ id: "implementation-context", category: "dynamic", source: "prompt/implementation-context.md", completion: "none" },
	{ id: "review-context", category: "dynamic", source: "prompt/review-context.md", completion: "none" },
	{ id: "workflow-task-agent", category: "protocol", source: "prompt/workflow-task-agent.md", completion: "none" },
	{ id: "workflow-review-agent", category: "protocol", source: "prompt/workflow-review-agent.md", completion: "none" },
	{ id: "workflow-repair-agent", category: "protocol", source: "prompt/workflow-repair-agent.md", completion: "none" },
	{ id: "missing-agent-fallback", category: "fallback", source: "prompt/default-agent.md", completion: "none" },
	{ id: "orchestrator-tool-pointers", category: "tool-pointer", source: "extensions/workflow/index.ts#registerTool", completion: "none" },
	{ id: "task-clarify-pointer", category: "tool-pointer", source: "extensions/workflow/worker-capabilities.ts#registerWorkerCapabilities", completion: "none" },
];
