import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HarnessConfig, HarnessEffort, ModelTier, TierModelRouteConfig } from "./types.js";

export interface ExplicitModelOverride {
	/** Configured concrete model id, optionally prefixed with provider/. */
	model: string;
	effort?: HarnessEffort;
}

export interface ModelResolutionRequest {
	tier: ModelTier;
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
	requested: { tier: ModelTier; override?: ExplicitModelOverride };
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
	requested: { tier: ModelTier; override?: ExplicitModelOverride };
	attempts: ModelAttempt[];
}

export type HarnessModelResolution = ResolvedHarnessModel | UnresolvedHarnessModel;

export function supportsEffort(model: Model<Api>, effort: ModelThinkingLevel): boolean {
	return getSupportedThinkingLevels(model).includes(effort);
}

const EFFORTS = new Set<HarnessEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Normalize the compact provider/model#effort notation accepted by direct subagent launches. */
export function normalizeExplicitModelOverride(model: string, effort?: HarnessEffort): ExplicitModelOverride {
	let normalizedModel = model.trim();
	let suffixEffort: HarnessEffort | undefined;
	const separator = normalizedModel.lastIndexOf("#");
	if (separator >= 0) {
		const suffix = normalizedModel.slice(separator + 1).toLowerCase() as HarnessEffort;
		if (separator === 0 || !EFFORTS.has(suffix)) throw new Error(`Unsupported model effort suffix in ${model}`);
		normalizedModel = normalizedModel.slice(0, separator);
		suffixEffort = suffix;
	}
	if (!normalizedModel) throw new Error("Model preference must not be empty");
	const selectedEffort = effort ?? suffixEffort;
	return { model: normalizedModel, ...(selectedEffort ? { effort: selectedEffort } : {}) };
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
	// `local` is a provider-isolated route group, not another capability tier.
	// Never let model-name collisions promote a paid route into a local launch,
	// or a local route into an ordinary managed/dynamic launch.
	const crossTierRoutes = request.tier === "local"
		? []
		: Object.entries(config.modelTiers)
			.filter(([tier]) => tier !== request.tier && tier !== "local")
			.flatMap(([, tierRoutes]) => tierRoutes.map(parseRoute));
	const orderedRoutes = [...routes, ...crossTierRoutes];
	const matching = orderedRoutes.filter((route) => {
		const key = `${route.provider}/${route.model}`;
		if (!routeMatchesOverride(route, request.override!.model) || matched.has(key)) return false;
		matched.add(key);
		return true;
	});
	const explicit = matching.map((route) => ({ route, effort: request.override!.effort ?? route.effort, override: true }));
	// An explicit local request is always strict. A bad model id or unsupported
	// effort must fail visibly rather than selecting another local or paid route.
	if (request.strict || request.tier === "local") return explicit;
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
	const overrideSearchRoutes = request.tier === "local"
		? config.modelTiers.local
		: Object.entries(config.modelTiers).filter(([tier]) => tier !== "local").flatMap(([, routes]) => routes);
	const overrideConfigured = request.override
		? overrideSearchRoutes.map(parseRoute).some((route) => routeMatchesOverride(route, request.override!.model))
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
