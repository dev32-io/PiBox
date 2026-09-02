import {
	DEFAULT_FAST_MODE_POLICY,
	FAST_MODE_CHILD_ENV,
	isChatGptFastRoute,
	subagentFastEnabled,
	type FastModePolicy,
} from "./policy.js";

let activePolicy: FastModePolicy = { ...DEFAULT_FAST_MODE_POLICY };

export function getActiveFastModePolicy(): FastModePolicy {
	return { ...activePolicy };
}

export function setActiveFastModePolicy(policy: FastModePolicy): void {
	activePolicy = { ...policy };
}

export function resetActiveFastModePolicy(): void {
	activePolicy = { ...DEFAULT_FAST_MODE_POLICY };
}

export function isSubagentFastActive(tier: unknown, route: { provider?: string; model?: string } | undefined): boolean {
	return subagentFastEnabled(activePolicy.subagents, tier) && isChatGptFastRoute(route?.provider, route?.model);
}

/** Child processes receive only their effective launch decision, never the
 * parent session's complete policy. The child's request hook still performs
 * its own provider/API/model check as a final fallback safety boundary. */
export function fastModeChildEnvironment(tier: unknown, route?: { provider?: string; model?: string }): Record<string, string> {
	return { [FAST_MODE_CHILD_ENV]: isSubagentFastActive(tier, route) ? "1" : "0" };
}
