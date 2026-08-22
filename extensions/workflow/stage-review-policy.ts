import { HarnessError } from "./errors.js";
import type { StageReviewPolicy } from "./types.js";

const SUBSTANTIVE_POLICY_LENGTH = 20;

/** Legacy omission remains a required medium review; only an explicit skip opts out. */
export function stageReviewRequired(policy: StageReviewPolicy | undefined): boolean {
	return policy?.mode !== "skip";
}

export function stageReviewTier(policy: StageReviewPolicy | undefined): "medium" | "high" {
	return policy?.mode === "skip" ? "medium" : policy?.tier ?? "medium";
}

export function validateStageReviewPolicy(policy: StageReviewPolicy | undefined, label: string): void {
	if (!policy) return;
	const raw = policy as unknown as Record<string, unknown>;
	if (raw.mode !== undefined && raw.mode !== "required" && raw.mode !== "skip") throw new HarnessError("INVALID_ARTIFACT", `${label} has an unsupported review mode`);
	if (raw.mode === "skip") {
		if (typeof raw.rationale !== "string" || raw.rationale.trim().length < SUBSTANTIVE_POLICY_LENGTH) throw new HarnessError("INVALID_ARTIFACT", `${label} skip policy requires a substantive rationale`);
		if (raw.tier !== undefined || raw.focus !== undefined) throw new HarnessError("INVALID_ARTIFACT", `${label} skip policy cannot declare tier or focus`);
		return;
	}
	if (raw.tier !== "medium" && raw.tier !== "high") throw new HarnessError("INVALID_ARTIFACT", `${label} requires medium or high review tier`);
	if (raw.tier === "high" && ((typeof raw.rationale !== "string" ? 0 : raw.rationale.trim().length) < SUBSTANTIVE_POLICY_LENGTH || (!Array.isArray(raw.focus) ? "" : raw.focus.join(" ")).trim().length < SUBSTANTIVE_POLICY_LENGTH)) {
		throw new HarnessError("INVALID_ARTIFACT", `${label} high policy requires substantive rationale and focus`);
	}
}
