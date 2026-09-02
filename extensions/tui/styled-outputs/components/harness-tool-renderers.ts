import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { currentSubagentIndicator, renderSubagentLiveStatus } from "../../../subagent/display.js";
import { getSubagentUiProjectionRegistry, type SubagentUiAgentProjection, type SubagentUiAgentRef } from "../../../subagent/ui-projection.js";

const EXACT_HARNESS_TOOLS = new Set(["memory_adapter", "wait"]);

export function isHarnessTool(name: string): boolean {
	return EXACT_HARNESS_TOOLS.has(name) || /^(resource|workflow|subagent|story|e2e|task|stage|evaluation|distill)_/.test(name);
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
		case "resource_delete": return { action: "Delete resource", target: args.ref };
		case "story_write": return { action: args.ref ? "Update story" : "Create story", target: args.ref ?? [args.id, args.title].filter(Boolean).join(" · ") };
		case "e2e_write": return { action: args.ref ? "Update E2E case" : "Create E2E case", target: args.ref ?? [args.story, args.id, args.title].filter(Boolean).join(" · ") };
		case "task_write": return { action: args.ref ? "Update task" : "Create task", target: args.ref ?? [args.story, args.id, args.title].filter(Boolean).join(" · ") };
		case "stage_write": return { action: args.ref ? "Update stage" : "Create stage", target: args.ref ?? [args.story, args.id].filter(Boolean).join(" · ") };
		case "distill_prepare": return { action: "Preview distillation", target: [args.baseline && `${args.baseline}..`, args.target ?? "HEAD", args.since && `since ${args.since}`].filter(Boolean).join("") };
		case "distill_collect": return { action: "Collect distillation", target: compact(args.previewToken, 12) };
		case "distill_read": return { action: args.runId ? "Read distillation" : "List distillations", target: [args.runId, args.path].filter(Boolean).join(" · ") };
		case "distill_record": return { action: `Record distillation ${args.category ?? "artifact"}`, target: [args.runId, args.id].filter(Boolean).join(" · ") };
		case "distill_compare": return { action: "Compare distilled knowledge", target: `${args.claims?.length ?? 0} claim(s)` };
		case "distill_instruction_check": return { action: "Measure instruction burden", target: args.targetPath };
		case "memory_adapter": {
			switch (args.action) {
				case "status": return { action: "Inspect memory status" };
				case "remember": return { action: "Remember", target: compact(args.memory, 72) };
				case "recall": return { action: "Recall memories", target: args.query && `“${compact(args.query, 56)}”` };
				case "list": return { action: "List memories", target: args.type };
				case "get": return { action: "Read memory", target: args.id };
				case "update": return { action: "Update memory", target: args.id };
				case "delete": return { action: "Delete memory", target: args.id };
				case "history": return { action: "Read memory history", target: args.id };
				case "audit": return { action: "Audit memories" };
				default: return { action: "Use memory adapter" };
			}
		}
		case "workflow_start": return { action: "Start workflow", target: args.ref };
		case "workflow_control": return { action: `${words(args.action ?? "control")} workflow`, target: args.ref };
		case "workflow_status": return { action: "Inspect workflow status" };
		case "workflow_compile": return { action: "Compile workflow", target: args.ref };
		case "workflow_init": return { action: "Initialize workflow", target: args.profile };
		case "subagent_spawn": return { action: args.agent ?? "Subagent", target: compact(args.task, 78) };
		case "subagent_status": return { action: "Inspect subagents" };
		case "subagent_control": return { action: `${words(args.action ?? "control")} subagent`, target: args.agentId };
		case "subagent_continue": return { action: "Continue subagent", target: args.agentId };
		case "task_clarify": return { action: args.findText ? "Search task context" : "Read task context", target: args.section };
		default: return { action: words(name), target: args.ref ?? args.workItemId ?? args.taskId ?? args.evaluationId };
	}
}

export type SubagentProjectionLookup = (ref: SubagentUiAgentRef) => SubagentUiAgentProjection | undefined;

const defaultSubagentLookup: SubagentProjectionLookup = (ref) => getSubagentUiProjectionRegistry().lookup(ref);

function subagentUiRef(details: Record<string, any> | undefined): SubagentUiAgentRef | undefined {
	const ref = details?.uiRef;
	const owner = ref?.owner;
	if (!ref || typeof ref.agentId !== "string" || !owner || typeof owner.sessionId !== "string" || typeof owner.processInstanceId !== "string" || typeof owner.activationId !== "string") return undefined;
	return ref as SubagentUiAgentRef;
}

function projectionDetails(details: Record<string, any> | undefined, projection: SubagentUiAgentProjection): Record<string, any> {
	return {
		...details,
		agentId: projection.agentId,
		agent: projection.agent,
		state: projection.state,
		...(projection.tier ? { tier: projection.tier } : {}),
		resolved: {
			provider: projection.provider,
			model: projection.model,
			effort: projection.effort,
			fast: projection.fast,
			startedAt: projection.startedAt,
		},
		fast: projection.fast,
		progress: projection.progress,
		processStatus: ["launching", "running", "stopping"].includes(projection.state)
			? (projection.progress?.processStartedAt ? "active" : "starting")
			: undefined,
	};
}

function waitTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function formatWaitDuration(milliseconds: number, roundUp = false): string {
	const bounded = Math.max(0, milliseconds);
	if (bounded < 1_000) return `${Math.round(bounded)}ms`;
	const seconds = (roundUp ? Math.ceil : Math.floor)(bounded / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

class WaitCallComponent implements Component {
	constructor(
		private readonly args: Record<string, any>,
		private readonly theme: Theme,
		private readonly partial: boolean,
		private readonly error: boolean,
		private readonly details?: Record<string, any>,
		private readonly now: () => number = Date.now,
	) {}

	render(width: number): string[] {
		const now = this.now();
		const startedAt = waitTimestamp(this.details?.startedAt) ?? now;
		const elapsedMs = typeof this.details?.elapsedMs === "number"
			? Math.max(0, this.details.elapsedMs)
			: Math.max(0, now - startedAt);
		const durationMs = typeof this.args.durationMs === "number"
			? this.args.durationMs
			: typeof this.details?.durationMs === "number" ? this.details.durationMs : undefined;
		const event = typeof this.args.event === "string"
			? this.args.event
			: typeof this.details?.event === "string" ? this.details.event : undefined;
		const icon = this.partial
			? this.theme.fg("accent", currentSubagentIndicator("starting", now))
			: this.error ? this.theme.fg("error", "✗") : this.theme.fg("success", "✓");

		let action: string;
		let target: string | undefined;
		let detail: string | undefined;
		if (this.error) {
			action = "Wait failed";
			target = event ?? (durationMs !== undefined ? formatWaitDuration(durationMs, true) : undefined);
		} else if (this.partial && durationMs !== undefined) {
			const remainingMs = Math.max(0, durationMs - elapsedMs);
			action = "Waiting";
			target = `${formatWaitDuration(remainingMs, true)} remaining`;
			detail = `Timer · ${formatWaitDuration(durationMs, true)} total · ${formatWaitDuration(elapsedMs)} elapsed`;
		} else if (this.partial) {
			action = event === "subagent_settled" ? "Waiting for next subagent settlement" : "Waiting for event";
			const pendingCount = typeof this.details?.pendingCount === "number" ? this.details.pendingCount : undefined;
			const pending = pendingCount === undefined ? "" : ` · ${pendingCount} subagent${pendingCount === 1 ? "" : "s"} pending`;
			detail = `Event: ${event ?? "unknown"} · ${formatWaitDuration(elapsedMs)} elapsed${pending}`;
		} else if (durationMs !== undefined) {
			action = "Waited";
			target = formatWaitDuration(elapsedMs || durationMs);
		} else {
			action = "Event received";
			target = event;
		}

		const headline = `${icon} ${this.theme.bold(this.theme.fg("toolTitle", action))}${target ? ` ${this.theme.fg("dim", target)}` : ""}`;
		const lines = [truncateToWidth(headline, width, "…")];
		if (detail) lines.push(truncateToWidth(`${this.theme.fg("dim", "└─")} ${this.theme.fg("muted", detail)}`, width, "…"));
		return lines;
	}

	invalidate(): void {}
}

class HarnessCallComponent implements Component {
	constructor(
		private readonly name: string,
		private readonly args: Record<string, any>,
		private readonly theme: Theme,
		private readonly partial: boolean,
		private readonly error: boolean,
		private readonly details?: Record<string, any>,
		private readonly now: () => number = Date.now,
		private readonly lookup: SubagentProjectionLookup = defaultSubagentLookup,
	) {}

	render(width: number): string[] {
		const ref = subagentUiRef(this.details);
		const projection = ref ? this.lookup(ref) : undefined;
		const details = projection ? projectionDetails(this.details, projection) : this.details;
		const rawLabel = callLabel(this.name, this.args);
		// Harness arguments are model-controlled and may contain newlines. Keep the
		// transcript row single-line and bounded without changing the tool payload.
		const label = { action: compact(rawLabel.action, 72), ...(rawLabel.target ? { target: compact(rawLabel.target, 96) } : {}) };
		const indicatorState = details?.processStatus === "active" || details?.progress?.processStartedAt ? "running" : "starting";
		const icon = this.partial
			? this.theme.fg(indicatorState === "starting" ? "muted" : "accent", currentSubagentIndicator(indicatorState, this.now()))
			: this.error ? this.theme.fg("error", "✗") : this.theme.fg("success", "✓");
		const headline = `${icon} ${this.theme.bold(this.theme.fg("toolTitle", label.action))}${label.target ? ` ${this.theme.fg("dim", label.target)}` : ""}`;
		const isSubagent = this.name === "subagent_spawn" || this.name === "subagent_continue";
		const isDetachedBackgroundReceipt = this.name === "subagent_spawn" && this.args.mode === "background" && !this.partial && Boolean(ref) && !projection;
		const showSubagentStatus = isSubagent && !isDetachedBackgroundReceipt && (this.partial || Boolean(details?.terminal) || Boolean(projection) || Boolean(details?.resolved));
		if (!this.partial && !showSubagentStatus) return [truncateToWidth(headline, width, "…")];
		const state = showSubagentStatus
			? renderSubagentLiveStatus({
				// The headline already identifies the agent; keep only route and progress
				// in this inline continuation row. Footer projections retain identity.
				tier: details?.tier ?? this.args.tier,
				resolved: details?.resolved,
				fast: details?.fast,
				progress: details?.progress,
				processStatus: details?.processStatus,
				startedAt: details?.resolved?.startedAt ?? details?.progress?.startedAt,
			}, this.theme, this.now())
			: this.theme.fg("muted", "running");
		return [truncateToWidth(headline, width, "…"), truncateToWidth(`${this.theme.fg("dim", "└─")} ${state}`, width, "…")];
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
	const ref = compact(scalar(item.ref) ?? scalar(item.id) ?? scalar(item.name) ?? scalar(item.type) ?? "resource", 72);
	const titleValue = scalar(item.title) ?? scalar(item.summary) ?? scalar(item.role);
	const stateValue = scalar(item.state) ?? scalar(item.status) ?? scalar(item.verdict) ?? scalar(item.action);
	const title = titleValue ? compact(titleValue, 120) : undefined;
	const state = stateValue ? compact(stateValue, 48) : undefined;
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
	for (const key of ["ref", "id", "title", "type", "phase", "state", "status", "verdict", "revision", "count", "returned", "total", "commit", "branch", "agentId", "runId"]) {
		const value = scalar(source?.[key]);
		if (value !== undefined) fields.push([words(key), value]);
	}
	return fields.slice(0, 6);
}

function appendTreeRows(container: Container, rows: string[], theme: Theme, expanded: boolean, collapsedLimit = 6): void {
	const shown = expanded ? rows : rows.slice(0, collapsedLimit);
	shown.forEach((row, index) => {
		const last = index === shown.length - 1 && shown.length === rows.length;
		const rendered = expanded ? row : compact(row, 180);
		container.addChild(new Text(`${theme.fg("dim", last ? "└─" : "├─")} ${theme.fg("muted", rendered)}`, 0, 0));
	});
	if (rows.length > shown.length) {
		const toggle = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
		container.addChild(new Text(`${theme.fg("dim", "└─")} ${theme.fg("dim", `… +${rows.length - shown.length} more lines (${toggle} to expand)`)}`, 0, 0));
	}
}

function outputRows(text: string): string[] {
	const rows = text.replace(/\r\n?/g, "\n").split("\n");
	while (rows.length > 0 && rows[0]!.trim() === "") rows.shift();
	while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop();
	return rows;
}

/** Render prose/code output as a block: shell padding plus original line indentation. */
function appendOutputBlock(container: Container, text: string, theme: Theme, expanded: boolean, collapsedLimit: number): void {
	const rows = outputRows(text);
	if (rows.length === 0) return;
	const shown = expanded ? rows : rows.slice(0, collapsedLimit);
	container.addChild(new Text(theme.fg("muted", shown.join("\n")), 2, 0));
	if (rows.length > shown.length) {
		const toggle = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
		container.addChild(new Text(theme.fg("dim", `… +${rows.length - shown.length} more lines (${toggle} to expand)`), 2, 0));
	}
}

export function renderHarnessToolCall(name: string, args: Record<string, any>, theme: Theme, partial: boolean, error: boolean, details?: Record<string, any>, now: () => number = Date.now, lookup: SubagentProjectionLookup = defaultSubagentLookup): Component {
	if (name === "wait") return new WaitCallComponent(args, theme, partial, error, details, now);
	return new HarnessCallComponent(name, args, theme, partial, error, details, now, lookup);
}

function memoryRecordLabel(record: any): string {
	if (!record || typeof record !== "object") return compact(String(record), 120);
	const id = scalar(record.id) ?? "memory";
	const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
	const type = scalar(metadata.type);
	const status = scalar(metadata.status);
	const memory = compact(record.memory, 110);
	return [id, type, status && status !== "active" ? status : undefined, memory].filter(Boolean).join(" · ");
}

function renderMemoryToolResult(result: any, expanded: boolean, theme: Theme, error: boolean): Component {
	const component = new Container();
	const details = result?.details ?? {};
	const action = scalar(details.action) ?? "memory";
	const records = Array.isArray(details.records) ? details.records : [];
	const findings = Array.isArray(details.findings) ? details.findings : [];
	const history = Array.isArray(details.history) ? details.history : [];
	const record = details.record && typeof details.record === "object" ? details.record : undefined;
	const repository = details.repository && typeof details.repository === "object" ? details.repository : undefined;
	const status = error ? theme.fg("error", "Error") : theme.fg("success", "Done");
	const metadata: string[] = [];
	if (action === "status") metadata.push(details.healthy ? "running" : "stopped or unhealthy");
	else if (action === "audit") {
		metadata.push(`${scalar(details.checked) ?? 0} checked`, `${findings.length} finding${findings.length === 1 ? "" : "s"}`);
		if (details.bounded) metadata.push("bounded");
	} else if (action === "history") metadata.push(`${history.length} event${history.length === 1 ? "" : "s"}`);
	else if (records.length > 0 || action === "recall" || action === "list" || action === "remember") metadata.push(`${records.length} memor${records.length === 1 ? "y" : "ies"}`);
	else if (record) metadata.push(scalar(record.id) ?? "1 memory");
	else if (action === "delete") metadata.push(scalar(details.id) ?? scalar(details.requestedId) ?? "deleted");
	else if (action === "update") metadata.push(scalar(details.requestedId) ?? "updated");
	if (action === "status" && repository?.repoId) metadata.push(`repo ${String(repository.repoId).slice(0, 12)}`);
	const suffix = metadata.length ? `${theme.fg("dim", " · ")}${theme.fg("muted", metadata.join(" · "))}` : "";
	component.addChild(new Text(`${theme.fg("dim", "└─")} ${status}${suffix}`, 0, 0));

	if (error) {
		const lines = firstText(result).split("\n").map((line) => line.trim()).filter(Boolean);
		if (lines.length) appendTreeRows(component, lines, theme, expanded, 4);
		return component;
	}
	if (findings.length) {
		appendTreeRows(component, findings.map((finding: any) => {
			const reasons = Array.isArray(finding?.reasons) ? finding.reasons.map(String).join("; ") : "review required";
			return `${scalar(finding?.id) ?? "memory"} · ${compact(reasons, 120)}`;
		}), theme, expanded);
		return component;
	}
	const memoryRows = record ? [record] : records;
	if (memoryRows.length) {
		appendTreeRows(component, memoryRows.map(memoryRecordLabel), theme, expanded, 5);
		return component;
	}
	if (history.length) {
		appendTreeRows(component, history.map(itemLabel), theme, expanded, 6);
		return component;
	}
	return component;
}

function renderWaitToolResult(result: any, expanded: boolean, theme: Theme, error: boolean): Component {
	const component = new Container();
	const details = result?.details ?? {};
	const text = firstText(result);
	if (error) {
		component.addChild(new Text(`${theme.fg("dim", "└─")} ${theme.fg("error", "Error")}`, 0, 0));
		const rows = outputRows(text).filter((row) => row.trim());
		if (rows.length) appendTreeRows(component, rows, theme, expanded, 4);
		return component;
	}

	const elapsedMs = typeof details.elapsedMs === "number"
		? Math.max(0, details.elapsedMs)
		: typeof details.durationMs === "number" ? Math.max(0, details.durationMs) : 0;
	if (details.kind === "time") {
		component.addChild(new Text(
			`${theme.fg("dim", "└─")} ${theme.fg("success", "Timer complete")}${theme.fg("dim", " · ")}${theme.fg("muted", `${formatWaitDuration(elapsedMs)} elapsed`)}`,
			0,
			0,
		));
		return component;
	}

	const settlements = Array.isArray(details.settlements) ? details.settlements : [];
	const count = settlements.length;
	const countLabel = `${count} settlement${count === 1 ? "" : "s"}`;
	component.addChild(new Text(
		`${theme.fg("dim", "└─")} ${theme.fg("success", "Event received")}${theme.fg("dim", " · ")}${theme.fg("muted", `${details.event ?? "event"} · ${countLabel} · ${formatWaitDuration(elapsedMs)} elapsed`)}`,
		0,
		0,
	));
	if (count > 0) {
		appendTreeRows(component, settlements.map((settlement: any) => {
			const identity = [compact(scalar(settlement?.agent) ?? "subagent", 48), compact(scalar(settlement?.status) ?? "settled", 32), compact(scalar(settlement?.agentId) ?? "", 48)].filter(Boolean).join(" · ");
			const summary = expanded ? compact(scalar(settlement?.summary) ?? "", 120) : "";
			return summary ? `${identity} · ${summary}` : identity;
		}), theme, expanded, 5);
	}
	return component;
}

function renderHarnessToolResultSnapshot(name: string, result: any, expanded: boolean, theme: Theme, error: boolean): Component {
	if (name === "memory_adapter") return renderMemoryToolResult(result, expanded, theme, error);
	if (name === "wait") return renderWaitToolResult(result, expanded, theme, error);
	const component = new Container();
	const text = firstText(result);
	// A returned subagent report is prose and often contains code, file excerpts,
	// or nested command output. Never reinterpret an embedded JSON example as the
	// tool payload, and retain every line's original indentation.
	const subagentForeground = name === "subagent_spawn" || name === "subagent_continue";
	const payload = subagentForeground ? undefined : parsePayload(text);
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
	appendOutputBlock(component, text, theme, expanded, subagentForeground ? 10 : 4);
	return component;
}

class ProjectionAwareHarnessResultComponent implements Component {
	constructor(
		private readonly name: string,
		private readonly result: any,
		private readonly expanded: boolean,
		private readonly theme: Theme,
		private readonly error: boolean,
		private readonly ref: SubagentUiAgentRef,
		private readonly lookup: SubagentProjectionLookup,
	) {}

	render(width: number): string[] {
		const projection = this.lookup(this.ref);
		const details = projection
			? projectionDetails(this.result?.details, projection)
			: this.name === "subagent_spawn"
				? { ...this.result?.details, state: "launched" }
				: this.result?.details;
		return renderHarnessToolResultSnapshot(this.name, { ...this.result, details }, this.expanded, this.theme, this.error).render(width);
	}

	invalidate(): void {}
}

export function renderHarnessToolResult(name: string, result: any, expanded: boolean, theme: Theme, error: boolean, lookup: SubagentProjectionLookup = defaultSubagentLookup): Component {
	const ref = subagentUiRef(result?.details);
	if (ref && (name === "subagent_spawn" || name === "subagent_continue")) {
		return new ProjectionAwareHarnessResultComponent(name, result, expanded, theme, error, ref, lookup);
	}
	return renderHarnessToolResultSnapshot(name, result, expanded, theme, error);
}
