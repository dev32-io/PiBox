import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAgentProgressSegments, type AgentProgress } from "./agent-progress.js";
import type { RuntimeOwner } from "./api.js";
import { shortSubagentTitle } from "./presentation.js";
import type { SubagentUiAgentProjection, SubagentUiRouting } from "./ui-projection.js";

export const SUBAGENT_DISPLAY_ENV = "PIBOX_SUBAGENT_DISPLAY";
export const MAX_SUBAGENT_DISPLAY_RECORD_BYTES = 16 * 1024;

export type SubagentDisplayFrame =
	| { readonly type: "display_ready" }
	| { readonly type: "assistant_start" }
	| { readonly type: "assistant_end"; readonly error?: string }
	| { readonly type: "tool_start"; readonly toolCallId: string; readonly toolName: string; readonly args?: Readonly<Record<string, unknown>>; readonly argsText?: string; readonly truncated?: boolean }
	| { readonly type: "tool_end"; readonly toolCallId: string; readonly toolName: string; readonly text: string; readonly isError: boolean; readonly truncated?: boolean };

export interface SubagentDisplayEvent {
	readonly owner: RuntimeOwner;
	readonly agentId: string;
	readonly attemptId: string;
	readonly frame: SubagentDisplayFrame;
}

export type SubagentDisplayListener = (event: SubagentDisplayEvent) => void;

export interface SubagentDisplaySubscription {
	unsubscribe(): void;
}

const DISPLAY_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
	bash: ["command", "timeout"], read: ["path", "offset", "limit"], write: ["path", "content"],
	edit: ["path", "edits"], grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
	find: ["pattern", "path", "limit"], ls: ["path", "limit"],
};

/** Accept only bounded bridge frames. Rich protocol faults never enter lifecycle validation. */
export function parseSubagentDisplayFrame(value: unknown): SubagentDisplayFrame | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	let parsed: SubagentDisplayFrame | undefined;
	if (frame.type === "display_ready") parsed = { type: "display_ready" };
	else if (frame.type === "assistant_start") parsed = { type: "assistant_start" };
	else if (frame.type === "assistant_end" && (frame.error === undefined || typeof frame.error === "string")) {
		parsed = { type: "assistant_end", ...(frame.error ? { error: frame.error } : {}) };
	} else if (frame.type === "tool_start" && validDisplayIdentifier(frame.toolCallId, 128) && validDisplayToolName(frame.toolName)) {
		if (frame.args !== undefined && !validDisplayArgs(frame.toolName, frame.args)) return undefined;
		if (frame.argsText !== undefined && typeof frame.argsText !== "string") return undefined;
		if (frame.truncated !== undefined && typeof frame.truncated !== "boolean") return undefined;
		parsed = {
			type: "tool_start", toolCallId: frame.toolCallId, toolName: frame.toolName,
			...(frame.args ? { args: frame.args as Record<string, unknown> } : {}),
			...(frame.argsText ? { argsText: frame.argsText } : {}),
			...(frame.truncated === true ? { truncated: true } : {}),
		};
	} else if (frame.type === "tool_end" && validDisplayIdentifier(frame.toolCallId, 128) && validDisplayToolName(frame.toolName) && typeof frame.text === "string" && typeof frame.isError === "boolean") {
		if (frame.truncated !== undefined && typeof frame.truncated !== "boolean") return undefined;
		parsed = { type: "tool_end", toolCallId: frame.toolCallId, toolName: frame.toolName, text: frame.text, isError: frame.isError, ...(frame.truncated === true ? { truncated: true } : {}) };
	}
	if (!parsed) return undefined;
	try {
		return Buffer.byteLength(JSON.stringify({ type: "display", frame: parsed }) + "\n", "utf8") <= MAX_SUBAGENT_DISPLAY_RECORD_BYTES ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function validDisplayIdentifier(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validDisplayToolName(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,32}$/.test(value);
}

function validDisplayArgs(toolName: string, value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = DISPLAY_ARG_KEYS[toolName];
	if (!keys) return false;
	const args = value as Record<string, unknown>;
	if (Object.keys(args).some((key) => !keys.includes(key))) return false;
	for (const [key, entry] of Object.entries(args)) {
		if (key === "edits") {
			if (!Array.isArray(entry) || entry.length > 4 || entry.some((edit) => !edit || typeof edit !== "object" || Array.isArray(edit) || Object.keys(edit).some((editKey) => editKey !== "oldText" && editKey !== "newText") || typeof (edit as Record<string, unknown>).oldText !== "string" || typeof (edit as Record<string, unknown>).newText !== "string")) return false;
		} else if (!(typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)))) return false;
	}
	return true;
}

export const SUBAGENT_STARTING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SUBAGENT_RUNNING_FRAMES = ["·", "•", "●", "•"] as const;
export const SUBAGENT_STOPPING_FRAMES = ["◐", "◓", "◑", "◒"] as const;
// Match the working-row animation cadence so footer, inline, and workflow
// activity indicators feel synchronized.
export const SUBAGENT_ANIMATION_INTERVAL_MS = 90;
export const SUBAGENT_PULSE_FRAMES = SUBAGENT_RUNNING_FRAMES;
export const SUBAGENT_PULSE_INTERVAL_MS = SUBAGENT_ANIMATION_INTERVAL_MS;

export type SubagentIndicatorState = "starting" | "running" | "stopping";

export function subagentIndicatorFrame(state: SubagentIndicatorState, frame: number): string {
	const frames = state === "starting" ? SUBAGENT_STARTING_FRAMES : state === "stopping" ? SUBAGENT_STOPPING_FRAMES : SUBAGENT_RUNNING_FRAMES;
	return frames[Math.abs(Math.floor(frame)) % frames.length]!;
}

export function currentSubagentIndicator(state: SubagentIndicatorState, now = Date.now()): string {
	return subagentIndicatorFrame(state, Math.floor(now / SUBAGENT_ANIMATION_INTERVAL_MS));
}

/** Compatibility aliases for existing running-state consumers. */
export function subagentPulseDot(frame: number): string {
	return subagentIndicatorFrame("running", frame);
}

export function currentSubagentPulseDot(now = Date.now()): string {
	return currentSubagentIndicator("running", now);
}

export function formatSubagentRoute(tier: string | undefined, resolved?: { provider: string; model: string; effort: string }): string {
	const label = tier ? `${tier[0]?.toUpperCase()}${tier.slice(1)}` : "Configured";
	if (!resolved) return label;
	return `${label} (${resolved.provider}/${resolved.model}#${resolved.effort})`;
}

/** Defense-in-depth for restored or externally projected display metadata. */
export function sanitizeSubagentTitle(value: unknown): string | undefined {
	return typeof value === "string" ? shortSubagentTitle(value) : undefined;
}

function routingFailureReason(routing: SubagentUiRouting): string | undefined {
	const failed = routing.attempts.find((attempt) => attempt.status !== "selected");
	if (!failed) return undefined;
	const reasons: Record<string, string> = {
		override_not_configured: "not configured",
		model_ambiguous: "model ambiguous",
		model_missing: "model unavailable",
		effort_unsupported: "effort unsupported",
	};
	return reasons[failed.status] ?? failed.status.replaceAll("_", " ");
}

export function formatSubagentFallback(routing: SubagentUiRouting | undefined): string | undefined {
	if (!routing?.fallbackUsed) return undefined;
	const requestedModel = routing.requested.model ?? `${routing.requested.tier} tier`;
	const requested = `${requestedModel}${routing.requested.effort ? `#${routing.requested.effort}` : ""}`;
	const selected = `${routing.selected.provider}/${routing.selected.model}#${routing.selected.effort}`;
	const reason = routingFailureReason(routing);
	return `Fallback ${requested} → ${selected}${reason ? ` (${reason})` : ""}`;
}

export interface SubagentLiveStatus {
	agent?: string;
	title?: string;
	tier?: string;
	routing?: SubagentUiRouting;
	resolved?: { provider: string; model: string; effort: string; fast?: boolean };
	fast?: boolean;
	progress?: AgentProgress;
	processStatus?: "starting" | "active";
	lifecycle?: SubagentIndicatorState;
	/** Launch time used before the first semantic progress projection arrives. */
	startedAt?: string | number;
}

export type SubagentStatusTone = "text" | "warning" | "muted" | "accent" | "error" | "dim";
export interface SubagentStatusSegment {
	text: string;
	tone: SubagentStatusTone;
}

function fastLabel(status: SubagentLiveStatus): string {
	return status.fast === true || status.resolved?.fast === true ? "Fast" : "";
}

/** Stable identity, Fast, and route lead; elapsed stays beside the route before
 * fallback and counters, with the currently executing tool always last. */
export function subagentStatusSegments(status: SubagentLiveStatus, now = Date.now()): SubagentStatusSegment[] {
	const segments: SubagentStatusSegment[] = [];
	if (status.agent) segments.push({ text: status.agent, tone: "text" });
	const title = sanitizeSubagentTitle(status.title);
	if (title) segments.push({ text: title, tone: "accent" });
	if (fastLabel(status)) segments.push({ text: "Fast", tone: "warning" });
	if (status.tier || status.resolved) segments.push({ text: formatSubagentRoute(status.tier, status.resolved), tone: "muted" });
	const progress = formatAgentProgressSegments(status.progress, now, {
		...(status.startedAt !== undefined ? { fallbackStartedAt: status.startedAt } : {}),
		...(status.processStatus ? { processStatus: status.processStatus } : {}),
	});
	if (progress.elapsed) segments.push({ text: progress.elapsed, tone: "muted" });
	const fallback = formatSubagentFallback(status.routing);
	if (fallback) segments.push({ text: fallback, tone: "warning" });
	for (const text of progress.metrics) {
		segments.push({ text, tone: / error(?:s)?$/.test(text) ? "error" : "muted" });
	}
	if (progress.activeTool) segments.push({ text: progress.activeTool, tone: "accent" });
	return segments;
}

export function formatSubagentLiveStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return subagentStatusSegments(status, now).map(({ text }) => text).join(" · ");
}

export function renderSubagentLiveStatus(status: SubagentLiveStatus, theme: Theme, now = Date.now()): string {
	const divider = theme.fg("dim", " · ");
	return subagentStatusSegments(status, now).map(({ text, tone }) => theme.fg(tone, text)).join(divider);
}

export function formatInlineSubagentStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return formatSubagentLiveStatus(status, now);
}

export function formatBackgroundSubagentStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return formatSubagentLiveStatus(status, now);
}

/** Width-independent semantic footer text; the status bar owns final truncation. */
export function formatSubagentFooterProjection(agent: SubagentUiAgentProjection, now = Date.now()): string {
	return formatSubagentLiveStatus({
		agent: agent.agent,
		...(agent.title ? { title: agent.title } : {}),
		...(agent.tier ? { tier: agent.tier } : {}),
		...(agent.routing ? { routing: agent.routing } : {}),
		resolved: { provider: agent.provider, model: agent.model, effort: agent.effort },
		fast: agent.fast,
		...(agent.progress ? { progress: agent.progress } : {}),
		startedAt: agent.startedAt,
		processStatus: agent.state === "launching" ? "starting" : "active",
		lifecycle: agent.state === "launching" ? "starting" : agent.state === "stopping" ? "stopping" : "running",
	}, now);
}

export function renderSubagentFooterProjection(agent: SubagentUiAgentProjection, theme: Theme, now = Date.now()): string {
	return renderSubagentLiveStatus({
		agent: agent.agent,
		...(agent.title ? { title: agent.title } : {}),
		...(agent.tier ? { tier: agent.tier } : {}),
		...(agent.routing ? { routing: agent.routing } : {}),
		resolved: { provider: agent.provider, model: agent.model, effort: agent.effort },
		fast: agent.fast,
		...(agent.progress ? { progress: agent.progress } : {}),
		startedAt: agent.startedAt,
		processStatus: agent.state === "launching" ? "starting" : "active",
		lifecycle: agent.state === "launching" ? "starting" : agent.state === "stopping" ? "stopping" : "running",
	}, theme, now);
}
