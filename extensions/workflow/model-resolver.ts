import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CapabilityTier, Deliberation, HarnessConfig, HarnessEffort, TierModelRouteConfig } from "./types.js";

export interface ExplicitModelOverride {
	/** Configured concrete model id, optionally prefixed with provider/. */
	model: string;
	effort?: HarnessEffort;
}

export interface ModelResolutionRequest {
	tier: CapabilityTier;
	deliberation: Deliberation;
	override?: ExplicitModelOverride;
	strict?: boolean;
}

export interface ModelAttempt {
	provider?: string;
	model: string;
	effort?: ModelThinkingLevel;
	status: "profile_unsupported" | "override_not_configured" | "model_missing" | "effort_unsupported" | "selected";
}

export interface ResolvedHarnessModel {
	status: "resolved";
	requested: { tier: CapabilityTier; deliberation: Deliberation; override?: ExplicitModelOverride };
	route: TierModelRouteConfig;
	model: Model<Api>;
	effort: ModelThinkingLevel;
	fallbackUsed: boolean;
	attempts: ModelAttempt[];
}

export interface UnresolvedHarnessModel {
	status: "waiting_model";
	requested: { tier: CapabilityTier; deliberation: Deliberation; override?: ExplicitModelOverride };
	attempts: ModelAttempt[];
}

export type HarnessModelResolution = ResolvedHarnessModel | UnresolvedHarnessModel;

export function supportsEffort(model: Model<Api>, effort: ModelThinkingLevel): boolean {
	const mapped = model.thinkingLevelMap?.[effort];
	if (effort === "off") return mapped !== null;
	if (!model.reasoning || mapped === null) return false;
	if (effort === "xhigh" || effort === "max") return mapped !== undefined;
	return true;
}

function routeMatchesOverride(route: TierModelRouteConfig, model: string): boolean {
	return route.model === model || `${route.provider}/${route.model}` === model;
}

function candidates(config: HarnessConfig, request: ModelResolutionRequest): Array<{ route: TierModelRouteConfig; effort: HarnessEffort | undefined; override: boolean }> {
	const routes = config.modelTiers[request.tier] ?? [];
	if (!request.override) return routes.map((route) => ({ route, effort: route.effort[request.deliberation], override: false }));
	const matched = new Set<string>();
	const orderedRoutes = [...routes, ...Object.entries(config.modelTiers).filter(([tier]) => tier !== request.tier).flatMap(([, tierRoutes]) => tierRoutes)];
	const matching = orderedRoutes.filter((route) => {
		const key = `${route.provider}/${route.model}`;
		if (!routeMatchesOverride(route, request.override!.model) || matched.has(key)) return false;
		matched.add(key);
		return true;
	});
	const explicit = matching.map((route) => ({ route, effort: request.override!.effort ?? route.effort[request.deliberation], override: true }));
	if (request.strict) return explicit;
	const seen = new Set(explicit.map(({ route }) => `${route.provider}/${route.model}`));
	return [...explicit, ...routes.filter((route) => !seen.has(`${route.provider}/${route.model}`)).map((route) => ({ route, effort: route.effort[request.deliberation], override: false }))];
}

export function resolveHarnessModel(
	config: HarnessConfig,
	availableModels: readonly Model<Api>[],
	request: ModelResolutionRequest,
): HarnessModelResolution {
	const attempts: ModelAttempt[] = [];
	const requested = { tier: request.tier, deliberation: request.deliberation, ...(request.override ? { override: request.override } : {}) };
	const configured = candidates(config, request);
	const overrideConfigured = request.override ? Object.values(config.modelTiers).flat().some((route) => routeMatchesOverride(route, request.override!.model)) : true;
	if (request.override && !overrideConfigured) attempts.push({ model: request.override.model, ...(request.override.effort ? { effort: request.override.effort } : {}), status: "override_not_configured" });

	for (let index = 0; index < configured.length; index += 1) {
		const candidate = configured[index]!;
		const { route, effort } = candidate;
		if (!effort) {
			attempts.push({ provider: route.provider, model: route.model, status: "profile_unsupported" });
			continue;
		}
		const model = availableModels.find((item) => item.provider === route.provider && item.id === route.model);
		if (!model) {
			attempts.push({ provider: route.provider, model: route.model, effort, status: "model_missing" });
			continue;
		}
		if (!supportsEffort(model, effort)) {
			attempts.push({ provider: route.provider, model: route.model, effort, status: "effort_unsupported" });
			continue;
		}
		attempts.push({ provider: route.provider, model: route.model, effort, status: "selected" });
		return {
			status: "resolved",
			requested,
			route,
			model,
			effort,
			fallbackUsed: index > 0 || Boolean(request.override && !candidate.override),
			attempts,
		};
	}

	return { status: "waiting_model", requested, attempts };
}
