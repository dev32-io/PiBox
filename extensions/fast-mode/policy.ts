import type { Model } from "@earendil-works/pi-ai";

export const FAST_MODE_ENTRY_TYPE = "pibox-fast-mode";
export const FAST_MODE_STATUS_KEY = "fast-mode";
export const FAST_MODE_CHILD_ENV = "PIBOX_FAST_CHILD_ENABLED";
/** Cross-extension policy propagation. Pi loads each extension through an
 * isolated module graph, so launchers must not rely on a shared singleton. */
export const FAST_MODE_POLICY_EVENT = "pibox:fast-mode-policy";

export const SUBAGENT_FAST_LIMITS = ["off", "low", "medium", "high", "max"] as const;
export type SubagentFastLimit = (typeof SUBAGENT_FAST_LIMITS)[number];
export type FastCapabilityTier = "low" | "medium" | "high" | "max" | "local";

export interface FastModePolicy {
	main: boolean;
	subagents: SubagentFastLimit;
}

export interface FastModeSettings {
	main?: boolean;
	subagents?: SubagentFastLimit;
}

export interface FastModeStatus {
	mainAvailable: boolean;
	mainEnabled: boolean;
	subagents: SubagentFastLimit;
}

export const DEFAULT_FAST_MODE_POLICY: FastModePolicy = Object.freeze({ main: false, subagents: "off" });

const TIER_RANK: Record<Exclude<FastCapabilityTier, "local">, number> = {
	low: 0,
	medium: 1,
	high: 2,
	max: 3,
};

// OpenAI's ChatGPT Fast-mode documentation currently names GPT-5.4, GPT-5.5,
// and GPT-5.6. Keep this deliberately explicit: generic OpenAI-compatible
// providers and unadvertised model variants must never receive service_tier.
const CHATGPT_FAST_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFastModePolicy(value: unknown): FastModePolicy | undefined {
	if (!isRecord(value) || typeof value.main !== "boolean" || !SUBAGENT_FAST_LIMITS.includes(value.subagents as SubagentFastLimit)) return undefined;
	return { main: value.main, subagents: value.subagents as SubagentFastLimit };
}

export function resolveFastModeDefaults(value: unknown): FastModePolicy {
	if (!isRecord(value)) return { ...DEFAULT_FAST_MODE_POLICY };
	return {
		main: typeof value.main === "boolean" ? value.main : DEFAULT_FAST_MODE_POLICY.main,
		subagents: SUBAGENT_FAST_LIMITS.includes(value.subagents as SubagentFastLimit)
			? value.subagents as SubagentFastLimit
			: DEFAULT_FAST_MODE_POLICY.subagents,
	};
}

export function isFastCapabilityTier(value: unknown): value is FastCapabilityTier {
	return value === "low" || value === "medium" || value === "high" || value === "max" || value === "local";
}

export function subagentFastEnabled(limit: SubagentFastLimit, tier: unknown): boolean {
	if (!isFastCapabilityTier(tier) || tier === "local" || limit === "off") return false;
	return TIER_RANK[tier] <= TIER_RANK[limit];
}

export function isChatGptFastRoute(provider: string | undefined, model: string | undefined, api = "openai-codex-responses"): boolean {
	return provider === "openai-codex" && api === "openai-codex-responses" && Boolean(model && CHATGPT_FAST_MODELS.has(model));
}

export function isChatGptFastEligible(model: Model<any> | undefined): boolean {
	return Boolean(model && isChatGptFastRoute(model.provider, model.id, model.api));
}

export function projectFastModeStatus(policy: FastModePolicy, model: Model<any> | undefined): FastModeStatus {
	const mainAvailable = isChatGptFastEligible(model);
	return { mainAvailable, mainEnabled: mainAvailable && policy.main, subagents: policy.subagents };
}

export function serializeFastModeStatus(status: FastModeStatus): string {
	return JSON.stringify(status);
}

export function parseFastModeStatus(value: string | undefined): FastModeStatus | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!isRecord(parsed) || typeof parsed.mainAvailable !== "boolean" || typeof parsed.mainEnabled !== "boolean" || !SUBAGENT_FAST_LIMITS.includes(parsed.subagents as SubagentFastLimit)) return undefined;
		return {
			mainAvailable: parsed.mainAvailable,
			mainEnabled: parsed.mainEnabled,
			subagents: parsed.subagents as SubagentFastLimit,
		};
	} catch {
		return undefined;
	}
}

export function withFastServiceTier(payload: unknown, enabled: boolean, model: Model<any> | undefined): unknown | undefined {
	if (!enabled || !isChatGptFastEligible(model) || !isRecord(payload)) return undefined;
	return { ...payload, service_tier: "priority" };
}
