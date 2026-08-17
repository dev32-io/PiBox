import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CapabilityTier, HarnessConfig, HarnessEffort, TierModelRouteConfig } from "./types.js";

export interface ExplicitModelOverride {
	/** Configured concrete model id, optionally prefixed with provider/. */
	model: string;
	effort?: HarnessEffort;
}

export interface ModelResolutionRequest {
	tier: CapabilityTier;
	override?: ExplicitModelOverride;
	strict?: boolean;
}

export interface ModelAttempt {
	provider?: string;
	model: string;
	effort?: ModelThinkingLevel;
	status: "override_not_configured" | "model_missing" | "effort_unsupported" | "selected";
}

interface ParsedRoute {
	configured: TierModelRouteConfig;
	provider: string;
	model: string;
	effort: HarnessEffort;
}

export interface ResolvedHarnessModel {
	status: "resolved";
	requested: { tier: CapabilityTier; override?: ExplicitModelOverride };
	route: TierModelRouteConfig;
	model: Model<Api>;
	effort: ModelThinkingLevel;
	fallbackUsed: boolean;
	/** Ordered usable same-tier routes for the launch coordinator. */
	candidates: Array<{ provider: string; model: string; effort: ModelThinkingLevel }>;
	attempts: ModelAttempt[];
}

export interface UnresolvedHarnessModel {
	status: "waiting_model";
	requested: { tier: CapabilityTier; override?: ExplicitModelOverride };
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

function parseRoute(configured: TierModelRouteConfig): ParsedRoute {
	const effortSeparator = configured.lastIndexOf("#");
	const providerSeparator = configured.indexOf("/");
	return {
		configured,
		provider: configured.slice(0, providerSeparator),
		model: configured.slice(providerSeparator + 1, effortSeparator),
		effort: configured.slice(effortSeparator + 1) as HarnessEffort,
	};
}

function routeMatchesOverride(route: ParsedRoute, model: string): boolean {
	return route.model === model || `${route.provider}/${route.model}` === model;
}

function candidates(config: HarnessConfig, request: ModelResolutionRequest): Array<{ route: ParsedRoute; effort: HarnessEffort; override: boolean }> {
	const routes = (config.modelTiers[request.tier] ?? []).map(parseRoute);
	if (!request.override) return routes.map((route) => ({ route, effort: route.effort, override: false }));
	const matched = new Set<string>();
	const orderedRoutes = [
		...routes,
		...Object.entries(config.modelTiers).filter(([tier]) => tier !== request.tier).flatMap(([, tierRoutes]) => tierRoutes.map(parseRoute)),
	];
	const matching = orderedRoutes.filter((route) => {
		const key = `${route.provider}/${route.model}`;
		if (!routeMatchesOverride(route, request.override!.model) || matched.has(key)) return false;
		matched.add(key);
		return true;
	});
	const explicit = matching.map((route) => ({ route, effort: request.override!.effort ?? route.effort, override: true }));
	if (request.strict) return explicit;
	const seen = new Set(explicit.map(({ route }) => `${route.provider}/${route.model}`));
	return [...explicit, ...routes.filter((route) => !seen.has(`${route.provider}/${route.model}`)).map((route) => ({ route, effort: route.effort, override: false }))];
}

export function resolveHarnessModel(
	config: HarnessConfig,
	availableModels: readonly Model<Api>[],
	request: ModelResolutionRequest,
): HarnessModelResolution {
	const attempts: ModelAttempt[] = [];
	const resolvedCandidates: Array<{ provider: string; model: string; effort: ModelThinkingLevel }> = [];
	const requested = { tier: request.tier, ...(request.override ? { override: request.override } : {}) };
	const configured = candidates(config, request);
	const overrideConfigured = request.override
		? Object.values(config.modelTiers).flat().map(parseRoute).some((route) => routeMatchesOverride(route, request.override!.model))
		: true;
	if (request.override && !overrideConfigured) attempts.push({ model: request.override.model, ...(request.override.effort ? { effort: request.override.effort } : {}), status: "override_not_configured" });

	for (let index = 0; index < configured.length; index += 1) {
		const candidate = configured[index]!;
		const { route, effort } = candidate;
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
		resolvedCandidates.push({ provider: route.provider, model: route.model, effort });
		// Candidates are assembled below; the first usable route remains the public selection.
		for (const remaining of configured.slice(index + 1)) {
			const alternate = availableModels.find((item) => item.provider === remaining.route.provider && item.id === remaining.route.model);
			if (alternate && supportsEffort(alternate, remaining.effort)) resolvedCandidates.push({ provider: remaining.route.provider, model: remaining.route.model, effort: remaining.effort });
		}
		return {
			status: "resolved",
			requested,
			route: route.configured,
			model,
			effort,
			fallbackUsed: index > 0 || Boolean(request.override && !candidate.override),
			candidates: resolvedCandidates,
			attempts,
		};
	}

	return { status: "waiting_model", requested, attempts };
}
