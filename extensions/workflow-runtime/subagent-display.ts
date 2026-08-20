import { formatAgentProgress, type AgentProgress } from "./agent-progress.js";

export const SUBAGENT_PULSE_FRAMES = ["·", "•", "●", "•"] as const;
// Match the working-row animation cadence so footer and inline activity
// indicators feel synchronized with the primary TUI status animation.
export const SUBAGENT_PULSE_INTERVAL_MS = 90;

export function subagentPulseDot(frame: number): string {
	return SUBAGENT_PULSE_FRAMES[Math.abs(Math.floor(frame)) % SUBAGENT_PULSE_FRAMES.length]!;
}

export function currentSubagentPulseDot(now = Date.now()): string {
	return subagentPulseDot(Math.floor(now / SUBAGENT_PULSE_INTERVAL_MS));
}

export function formatSubagentRoute(tier: string | undefined, resolved?: { provider: string; model: string; effort: string }): string {
	const label = tier ? `${tier[0]?.toUpperCase()}${tier.slice(1)}` : "Configured";
	if (!resolved) return label;
	return `${label} (${resolved.provider}/${resolved.model}#${resolved.effort})`;
}

export interface SubagentLiveStatus {
	tier?: string;
	resolved?: { provider: string; model: string; effort: string; fast?: boolean };
	fast?: boolean;
	progress?: AgentProgress;
	/** Launch time used before the first semantic progress projection arrives. */
	startedAt?: string | number;
}

function formatSubagentProgress(status: SubagentLiveStatus, now: number, showActive = true): string {
	return formatAgentProgress(status.progress, now, {
		...(status.startedAt !== undefined ? { fallbackStartedAt: status.startedAt } : {}),
		showStarting: true,
		showActive,
	});
}

function fastSuffix(status: SubagentLiveStatus): string {
	return status.fast === true || status.resolved?.fast === true ? " · Fast" : "";
}

/** Inline rows lead with volatile progress; the pulsing tool row already communicates active state. */
export function formatInlineSubagentStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return `${formatSubagentProgress(status, now, false)} · ${formatSubagentRoute(status.tier, status.resolved)}${fastSuffix(status)}`;
}

/** Footer rows lead with route metadata and retain explicit process activity. */
export function formatBackgroundSubagentStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return `${formatSubagentRoute(status.tier, status.resolved)} · ${formatSubagentProgress(status, now)}${fastSuffix(status)}`;
}
