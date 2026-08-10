import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HarnessConfig, ModelCandidateConfig } from "./types.js";

export interface ModelResolutionRequest {
	candidates: ModelCandidateConfig[];
	minimumCapabilityRank?: number;
	strict?: boolean;
}

export interface ModelAttempt {
	alias: string;
	provider?: string;
	model?: string;
	effort: ModelThinkingLevel;
	status: "selected" | "alias_missing" | "below_minimum_rank" | "model_missing" | "effort_unsupported";
}

export interface ResolvedHarnessModel {
	status: "resolved";
	requested: ModelCandidateConfig;
	alias: string;
	model: Model<Api>;
	effort: ModelThinkingLevel;
	capabilityRank: number;
	fallbackUsed: boolean;
	attempts: ModelAttempt[];
}

export interface UnresolvedHarnessModel {
	status: "waiting_model";
	requested?: ModelCandidateConfig;
	attempts: ModelAttempt[];
}

export type HarnessModelResolution = ResolvedHarnessModel | UnresolvedHarnessModel;

export function supportsEffort(model: Model<Api>, effort: ModelThinkingLevel): boolean {
	if (effort === "off") return model.thinkingLevelMap?.off !== null;
	if (!model.reasoning) return false;
	return model.thinkingLevelMap?.[effort] !== null;
}

export function resolveHarnessModel(
	config: HarnessConfig,
	availableModels: readonly Model<Api>[],
	request: ModelResolutionRequest,
): HarnessModelResolution {
	const candidates = request.strict ? request.candidates.slice(0, 1) : request.candidates;
	const attempts: ModelAttempt[] = [];
	const requested = request.candidates[0];

	for (const candidate of candidates) {
		const alias = config.models[candidate.model];
		if (!alias) {
			attempts.push({ alias: candidate.model, effort: candidate.effort, status: "alias_missing" });
			continue;
		}
		if (alias.capabilityRank < (request.minimumCapabilityRank ?? 0)) {
			attempts.push({
				alias: candidate.model,
				provider: alias.provider,
				model: alias.model,
				effort: candidate.effort,
				status: "below_minimum_rank",
			});
			continue;
		}
		const model = availableModels.find((item) => item.provider === alias.provider && item.id === alias.model);
		if (!model) {
			attempts.push({
				alias: candidate.model,
				provider: alias.provider,
				model: alias.model,
				effort: candidate.effort,
				status: "model_missing",
			});
			continue;
		}
		if (!supportsEffort(model, candidate.effort)) {
			attempts.push({
				alias: candidate.model,
				provider: alias.provider,
				model: alias.model,
				effort: candidate.effort,
				status: "effort_unsupported",
			});
			continue;
		}
		attempts.push({
			alias: candidate.model,
			provider: alias.provider,
			model: alias.model,
			effort: candidate.effort,
			status: "selected",
		});
		return {
			status: "resolved",
			...(requested ? { requested } : { requested: candidate }),
			alias: candidate.model,
			model,
			effort: candidate.effort,
			capabilityRank: alias.capabilityRank,
			fallbackUsed: candidate !== requested,
			attempts,
		};
	}

	return { status: "waiting_model", ...(requested ? { requested } : {}), attempts };
}
