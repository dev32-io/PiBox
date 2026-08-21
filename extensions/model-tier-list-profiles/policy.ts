export const MODEL_TIER_PROFILE_ENTRY_TYPE = "pibox-model-tier-list-profile";
export const MODEL_TIER_PROFILE_STATUS_KEY = "tier-profile";
export const MODEL_TIER_PROFILE_EVENT = "pibox:model-tier-list-profile";

export interface ModelTierProfilePolicy {
	profile: string;
}

export interface ModelTierProfileStatus {
	profile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeModelTierProfilePolicy(value: unknown): ModelTierProfilePolicy | undefined {
	if (!isRecord(value) || typeof value.profile !== "string" || !value.profile.trim()) return undefined;
	return { profile: value.profile.trim() };
}

export function serializeModelTierProfileStatus(status: ModelTierProfileStatus): string {
	return JSON.stringify(status);
}

export function parseModelTierProfileStatus(value: string | undefined): ModelTierProfileStatus | undefined {
	if (!value) return undefined;
	try {
		return normalizeModelTierProfilePolicy(JSON.parse(value)) as ModelTierProfileStatus | undefined;
	} catch {
		return undefined;
	}
}
