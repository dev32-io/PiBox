import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { currentSubagentPulseDot } from "../../../workflow-runtime/subagent-display.js";

const EXACT_HARNESS_TOOLS = new Set([
	"evidence_record", "finding_report", "work_item_complete", "task_integrate",
]);

export function isHarnessTool(name: string): boolean {
	return EXACT_HARNESS_TOOLS.has(name) || /^(resource|workflow|subagent|task|evaluation)_/.test(name);
}

function words(value: string): string {
	return value.split("_").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function compact(value: unknown, limit = 72): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function callLabel(name: string, args: Record<string, any>): { action: string; target?: string } {
	switch (name) {
		case "resource_list": return { action: "List resources", target: [args.type, args.parent, args.query && `“${compact(args.query, 32)}”`].filter(Boolean).join(" · ") || "all" };
		case "resource_read": return { action: "Read resource", target: args.ref };
		case "resource_write": return args.ref
			? { action: "Update resource", target: args.ref }
			: { action: "Create resource", target: [args.type, args.value?.title ?? args.value?.id, args.parent].filter(Boolean).join(" · ") };
		case "resource_delete": return { action: "Delete resource", target: args.ref };
		case "workflow_list": return { action: "List workflow resources", target: [args.resource, args.workItemId, args.query && `“${compact(args.query, 28)}”`].filter(Boolean).join(" · ") };
		case "workflow_get": return { action: "Read workflow resource", target: [args.ref, args.view].filter(Boolean).join(" · ") };
		case "workflow_schema": return { action: "Read workflow schema", target: [args.operation, args.resource].filter(Boolean).join(" · ") };
		case "workflow_plan_write": return { action: `${words(args.mode ?? "write")} plan`, target: args.target ?? args.plan?.id ?? args.plan?.title };
		case "workflow_create": return { action: "Create workflow resource", target: [args.resource, args.body?.id ?? args.body?.title, args.parent].filter(Boolean).join(" · ") };
		case "workflow_patch": return { action: "Update workflow resource", target: args.ref };
		case "workflow_delete": return { action: "Delete workflow resource", target: args.ref };
		case "workflow_apply_change": return { action: "Apply workflow change", target: `${args.operations?.length ?? 0} operation(s)` };
		case "workflow_transition": return { action: "Transition workflow", target: [args.ref, args.action].filter(Boolean).join(" · ") };
		case "workflow_start": return { action: "Start workflow", target: args.ref };
		case "workflow_control": return { action: `${words(args.action ?? "control")} workflow`, target: args.ref };
		case "workflow_checkpoint": return { action: "Decide checkpoint", target: [args.ref, args.action].filter(Boolean).join(" · ") };
		case "workflow_status": return { action: "Inspect workflow status" };
		case "workflow_init": return { action: "Initialize workflow", target: args.profile };
		case "subagent_spawn": return { action: args.agent ?? "Subagent", target: compact(args.task, 78) };
		case "subagent_status": return { action: "Inspect subagents" };
		case "subagent_control": return { action: `${words(args.action ?? "control")} subagent`, target: args.agentId };
		case "subagent_respond": return { action: "Respond to subagent", target: args.agentId };
		case "task_clarify": return { action: "Clarify task", target: args.ref ?? args.taskId };
		case "task_checkpoint": return { action: "Checkpoint task", target: args.summary };
		case "task_complete": return { action: "Complete task", target: args.summary };
		case "evaluation_complete": return { action: "Complete evaluation", target: args.verdict };
		case "evaluation_record": return { action: "Record evaluation", target: [args.evaluationId, args.verdict].filter(Boolean).join(" · ") };
		case "work_item_complete": return { action: "Complete work item", target: args.workItemId };
		default: return { action: words(name), target: args.ref ?? args.workItemId ?? args.taskId ?? args.evaluationId };
	}
}

class HarnessCallComponent implements Component {
	constructor(
		private readonly name: string,
		private readonly args: Record<string, any>,
		private readonly theme: Theme,
		private readonly partial: boolean,
		private readonly error: boolean,
	) {}

	render(width: number): string[] {
		const label = callLabel(this.name, this.args);
		const icon = this.partial
			? this.theme.fg("warning", currentSubagentPulseDot())
			: this.error ? this.theme.fg("error", "✗") : this.theme.fg("success", "✓");
		const headline = `${icon} ${this.theme.bold(this.theme.fg("toolTitle", label.action))}${label.target ? ` ${this.theme.fg("dim", label.target)}` : ""}`;
		if (!this.partial) return [truncateToWidth(headline, width, "…")];
		const mode = this.name === "subagent_spawn" ? this.args.mode ?? "background" : undefined;
		const route = this.name === "subagent_spawn"
			? this.args.model ? `${this.args.model}${this.args.effort ? `#${this.args.effort}` : ""}` : `${this.args.tier ?? "configured"} tier`
			: undefined;
		const state = ["running", mode, route].filter(Boolean).join(" · ");
		return [truncateToWidth(headline, width, "…"), truncateToWidth(`${this.theme.fg("dim", "└─")} ${this.theme.fg("muted", state)}`, width, "…")];
	}

	invalidate(): void {}
}

function firstText(result: any): string {
	return result?.content?.find((part: any) => part?.type === "text")?.text ?? "";
}

function parsePayload(text: string): any {
	const trimmed = text.trim();
	for (const opener of ["{", "["]) {
		const start = trimmed.indexOf(opener);
		if (start < 0) continue;
		const closer = opener === "{" ? "}" : "]";
		const end = trimmed.lastIndexOf(closer);
		if (end < start) continue;
		try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* keep trying */ }
	}
	return undefined;
}

function scalar(value: unknown): string | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function itemLabel(item: any): string {
	if (!item || typeof item !== "object") return compact(String(item));
	const ref = scalar(item.ref) ?? scalar(item.id) ?? scalar(item.name) ?? scalar(item.type) ?? "resource";
	const title = scalar(item.title) ?? scalar(item.summary) ?? scalar(item.role);
	const state = scalar(item.state) ?? scalar(item.status) ?? scalar(item.verdict) ?? scalar(item.action);
	return [ref, title && title !== ref ? title : undefined, state].filter(Boolean).join(" · ");
}

function structuredItems(payload: any): any[] {
	if (Array.isArray(payload)) return payload;
	for (const key of ["resources", "items", "children", "agents", "messages", "runs", "changes", "operations", "findings", "evidence", "affected"]) {
		if (Array.isArray(payload?.[key])) return payload[key];
	}
	return [];
}

function summaryFields(payload: any, details: any): Array<[string, string]> {
	const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : details && typeof details === "object" ? details : {};
	const fields: Array<[string, string]> = [];
	for (const key of ["ref", "id", "title", "type", "state", "status", "verdict", "revision", "count", "returned", "total", "commit", "branch", "agentId", "runId"]) {
		const value = scalar(source?.[key]);
		if (value !== undefined) fields.push([words(key), value]);
	}
	return fields.slice(0, 6);
}

function appendTreeRows(container: Container, rows: string[], theme: Theme, expanded: boolean): void {
	const shown = expanded ? rows : rows.slice(0, 6);
	shown.forEach((row, index) => {
		const last = index === shown.length - 1 && shown.length === rows.length;
		container.addChild(new Text(`${theme.fg("dim", last ? "└─" : "├─")} ${theme.fg("muted", row)}`, 0, 0));
	});
	if (rows.length > shown.length) container.addChild(new Text(`${theme.fg("dim", "└─")} ${theme.fg("dim", `… ${rows.length - shown.length} more`)}`, 0, 0));
}

export function renderHarnessToolCall(name: string, args: Record<string, any>, theme: Theme, partial: boolean, error: boolean): Component {
	return new HarnessCallComponent(name, args, theme, partial, error);
}

export function renderHarnessToolResult(name: string, result: any, expanded: boolean, theme: Theme, error: boolean): Component {
	const component = new Container();
	const text = firstText(result);
	const payload = parsePayload(text);
	const items = structuredItems(payload);
	const fields = summaryFields(payload, result?.details);
	const status = error ? theme.fg("error", "Error") : theme.fg("success", "Done");
	const resourceDiff = result?.details?.piboxResourceDiff as { action?: string; ref?: string; diff?: string } | undefined;
	const total = scalar(payload?.count) ?? scalar(payload?.total);
	const itemCount = items.length > 0 ? `${items.length}${total && total !== String(items.length) ? ` of ${total}` : ""} item${items.length === 1 && (!total || total === "1") ? "" : "s"}` : undefined;
	const commit = scalar(payload?.commit) ?? scalar(result?.details?.commit);
	const metadata = [
		resourceDiff?.action && resourceDiff.ref ? `${words(resourceDiff.action)} ${resourceDiff.ref}` : undefined,
		itemCount,
		commit ? `commit ${commit.slice(0, 12)}` : undefined,
	].filter(Boolean);
	const suffix = metadata.length > 0 ? `${theme.fg("dim", " · ")}${theme.fg("muted", metadata.join(" · "))}` : "";
	component.addChild(new Text(`${theme.fg("dim", "└─")} ${status}${suffix}`, 0, 0));
	if (resourceDiff?.diff) {
		const lines = renderDiff(resourceDiff.diff).split("\n");
		const shown = expanded ? lines : lines.slice(0, 12);
		for (const line of shown) component.addChild(new Text(line, 0, 0));
		if (lines.length > shown.length) component.addChild(new Text(theme.fg("dim", `… ${lines.length - shown.length} more diff lines`), 0, 0));
		return component;
	}
	if (items.length > 0) {
		appendTreeRows(component, items.map(itemLabel), theme, expanded);
		return component;
	}
	if (fields.length > 0) {
		appendTreeRows(component, fields.map(([key, value]) => `${key}: ${compact(value, 100)}`), theme, expanded);
		return component;
	}
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length > 0) appendTreeRows(component, expanded ? lines : lines.slice(0, 4), theme, expanded);
	return component;
}
