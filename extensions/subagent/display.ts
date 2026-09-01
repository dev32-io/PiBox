import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAgentProgress, type AgentProgress } from "./agent-progress.js";
import type { SubagentUiAgentProjection } from "./ui-projection.js";

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

export interface SubagentLiveStatus {
	agent?: string;
	tier?: string;
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

/** Stable identity and route lead; increasingly volatile metrics follow, with
 * the currently executing tool last so tool transitions never move the prefix. */
export function subagentStatusSegments(status: SubagentLiveStatus, now = Date.now()): SubagentStatusSegment[] {
	const segments: SubagentStatusSegment[] = [];
	if (status.agent) segments.push({ text: status.agent, tone: "text" });
	if (fastLabel(status)) segments.push({ text: "Fast", tone: "warning" });
	if (status.tier || status.resolved) segments.push({ text: formatSubagentRoute(status.tier, status.resolved), tone: "muted" });
	const progress = formatAgentProgress(status.progress, now, {
		...(status.startedAt !== undefined ? { fallbackStartedAt: status.startedAt } : {}),
		...(status.processStatus ? { processStatus: status.processStatus } : {}),
	});
	if (progress) {
		const values = progress.split(" · ");
		for (const [index, text] of values.entries()) {
			const activeTool = status.progress?.activeTool;
			const isTool = Boolean(activeTool) && index === values.length - 1 && text === activeTool;
			const isError = / error(?:s)?$/.test(text);
			segments.push({ text, tone: isTool ? "accent" : isError ? "error" : "muted" });
		}
	}
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
		...(agent.tier ? { tier: agent.tier } : {}),
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
		...(agent.tier ? { tier: agent.tier } : {}),
		resolved: { provider: agent.provider, model: agent.model, effort: agent.effort },
		fast: agent.fast,
		...(agent.progress ? { progress: agent.progress } : {}),
		startedAt: agent.startedAt,
		processStatus: agent.state === "launching" ? "starting" : "active",
		lifecycle: agent.state === "launching" ? "starting" : agent.state === "stopping" ? "stopping" : "running",
	}, theme, now);
}
