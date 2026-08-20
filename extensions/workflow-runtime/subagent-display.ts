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
	processStatus?: "starting" | "active";
	/** Launch time used before the first semantic progress projection arrives. */
	startedAt?: string | number;
}

function formatSubagentProgress(status: SubagentLiveStatus, now: number, showActive = true): string {
	return formatAgentProgress(status.progress, now, {
		...(status.startedAt !== undefined ? { fallbackStartedAt: status.startedAt } : {}),
		...(status.processStatus ? { processStatus: status.processStatus } : {}),
		showStarting: true,
		showActive,
	});
}

function fastLabel(status: SubagentLiveStatus): string {
	return status.fast === true || status.resolved?.fast === true ? "Fast" : "";
}

/** Inline rows lead with volatile progress; keep Fast ahead of the long route so
 * width truncation cannot silently hide the premium request marker. */
export function formatInlineSubagentStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return [formatSubagentProgress(status, now, false), fastLabel(status), formatSubagentRoute(status.tier, status.resolved)].filter(Boolean).join(" · ");
}

/** Footer rows lead with route metadata and retain explicit process activity. */
export function formatBackgroundSubagentStatus(status: SubagentLiveStatus, now = Date.now()): string {
	return [formatSubagentRoute(status.tier, status.resolved), fastLabel(status), formatSubagentProgress(status, now)].filter(Boolean).join(" · ");
}
