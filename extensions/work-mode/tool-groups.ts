export const WORKFLOW_RUNTIME_TOOL_NAMES = ["workflow_start", "workflow_control"] as const;
export const WORKFLOW_AUTHORING_TOOL_NAMES = [
	"resource_list",
	"resource_read",
	"story_write",
	"e2e_write",
	"task_write",
	"stage_write",
	"resource_delete",
	"workflow_compile",
	"workflow_status",
	"workflow_init",
] as const;

/** Fixed provider-facing order used whenever the workflow capability is loaded. */
export const WORKFLOW_TOOL_NAMES = [...WORKFLOW_RUNTIME_TOOL_NAMES, ...WORKFLOW_AUTHORING_TOOL_NAMES] as const;
export const WORKFLOW_TOOL_NAME_SET: ReadonlySet<string> = new Set(WORKFLOW_TOOL_NAMES);
