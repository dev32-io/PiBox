export const SUBAGENT_PULSE_FRAMES = ["·", "•", "●", "•"] as const;
export const SUBAGENT_PULSE_INTERVAL_MS = 650;

export function subagentPulseDot(frame: number): string {
	return SUBAGENT_PULSE_FRAMES[Math.abs(Math.floor(frame)) % SUBAGENT_PULSE_FRAMES.length]!;
}

export function currentSubagentPulseDot(now = Date.now()): string {
	return subagentPulseDot(Math.floor(now / SUBAGENT_PULSE_INTERVAL_MS));
}
