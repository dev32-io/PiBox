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
