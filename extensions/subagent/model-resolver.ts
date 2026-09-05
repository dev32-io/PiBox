import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { activeModelTierLists } from "../model-tier-list-profiles/profiles.js";
import type { HarnessEffort, ModelRoutingConfig, ModelTier, TierModelRouteConfig } from "./types.js";

export interface ExplicitModelOverride {
	/** Concrete model id, optionally prefixed with provider/. */
	model: string;
	effort?: HarnessEffort;
}

export interface ModelResolutionRequest {
	tier: ModelTier;
	override?: ExplicitModelOverride;
	/** Override only the first configured tier route's effort. Later routes retain their configured effort. */
	primaryEffort?: HarnessEffort;
	/** Explicit model requests are strict unless fallback is deliberately enabled. */
	allowFallback?: boolean;
	/** @deprecated Use allowFallback. Retained for managed callers that already set strict explicitly. */
	strict?: boolean;
	/** Direct user launches may select any uniquely matching registered model. */
	allowUnconfiguredOverride?: boolean;
}

export interface RequestedModelRoute {
	tier: ModelTier;
	override?: ExplicitModelOverride;
	primaryEffort?: HarnessEffort;
	allowFallback: boolean;
}

interface AttemptRoute {
	provider?: string;
	model: string;
	effort?: ModelThinkingLevel;
}

export interface RequestedModelAttempt extends AttemptRoute {
	kind: "requested";
	status: "override_not_configured" | "model_ambiguous" | "model_missing" | "effort_unsupported";
}

export interface FallbackModelAttempt extends AttemptRoute {
	kind: "fallback";
	status: "model_missing" | "effort_unsupported";
}

export interface SelectedModelAttempt extends AttemptRoute {
	kind: "selected";
	provider: string;
	effort: ModelThinkingLevel;
	status: "selected";
	fallback: boolean;
}

export type ModelAttempt = RequestedModelAttempt | FallbackModelAttempt | SelectedModelAttempt;

interface ParsedRoute {
	configured: TierModelRouteConfig;
	provider: string;
	model: string;
	effort: HarnessEffort;
}

interface Candidate {
	route: ParsedRoute;
	effort: HarnessEffort;
	kind: "requested" | "fallback";
	/** An available requested model with an explicitly requested unsupported effort must not be hidden by substitution. */
	failOnUnsupportedEffort: boolean;
}

export interface SelectedModelRoute {
	provider: string;
	model: string;
	effort: ModelThinkingLevel;
}

export interface ResolvedSubagentModel {
	status: "resolved";
	requested: RequestedModelRoute;
	selected: SelectedModelRoute;
	route: TierModelRouteConfig;
	model: Model<Api>;
	effort: ModelThinkingLevel;
	fallbackUsed: boolean;
	/** Ordered usable same-tier routes for the launch coordinator. */
	candidates: SelectedModelRoute[];
	attempts: ModelAttempt[];
}

export interface UnresolvedSubagentModel {
	status: "waiting_model";
	requested: RequestedModelRoute;
	attempts: ModelAttempt[];
}

export type SubagentModelResolution = ResolvedSubagentModel | UnresolvedSubagentModel;

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
	if (suffixEffort && effort && suffixEffort !== effort) {
		throw new Error(`Conflicting model efforts: ${suffixEffort} in ${model} and separate effort ${effort}`);
	}
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

function fallbackEnabled(request: ModelResolutionRequest): boolean {
	if (!request.override) return true;
	if (request.override && request.tier === "local") return false;
	if (request.allowFallback !== undefined) return request.allowFallback;
	return request.strict === false;
}

function candidates(config: ModelRoutingConfig, request: ModelResolutionRequest): Candidate[] {
	const modelTiers = activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers;
	const routes = (modelTiers[request.tier] ?? []).map(parseRoute);
	if (!request.override) {
		return routes.map((route, index) => ({
			route,
			effort: index === 0 ? request.primaryEffort ?? route.effort : route.effort,
			kind: index === 0 ? "requested" : "fallback",
			failOnUnsupportedEffort: index === 0 && request.primaryEffort !== undefined,
		}));
	}
	const matched = new Set<string>();
	// `local` is a provider-isolated route group, not another capability tier.
	// Never let model-name collisions promote a paid route into a local launch,
	// or a local route into an ordinary managed/dynamic launch.
	const crossTierRoutes = request.tier === "local"
		? []
		: Object.entries(modelTiers)
			.filter(([tier]) => tier !== request.tier && tier !== "local")
			.flatMap(([, tierRoutes]) => tierRoutes.map(parseRoute));
	const orderedRoutes = [...routes, ...crossTierRoutes];
	const matching = orderedRoutes.filter((route) => {
		const key = `${route.provider}/${route.model}`;
		if (!routeMatchesOverride(route, request.override!.model) || matched.has(key)) return false;
		matched.add(key);
		return true;
	});
	const explicit = matching.map((route): Candidate => ({
		route,
		effort: request.override!.effort ?? route.effort,
		kind: "requested",
		failOnUnsupportedEffort: request.override!.effort !== undefined,
	}));
	if (!fallbackEnabled(request)) return explicit;
	const seen = new Set(explicit.map(({ route }) => `${route.provider}/${route.model}`));
	return [
		...explicit,
		...routes
			.filter((route) => !seen.has(`${route.provider}/${route.model}`))
			.map((route): Candidate => ({ route, effort: route.effort, kind: "fallback", failOnUnsupportedEffort: false })),
	];
}

export function resolveSubagentModel(
	config: ModelRoutingConfig,
	availableModels: readonly Model<Api>[],
	request: ModelResolutionRequest,
): SubagentModelResolution {
	if (request.override && request.primaryEffort) throw new Error("primaryEffort cannot be combined with an explicit model override");
	if (request.strict === true && request.allowFallback === true) throw new Error("strict and allowFallback cannot both be enabled");

	const attempts: ModelAttempt[] = [];
	const resolvedCandidates: SelectedModelRoute[] = [];
	const requested: RequestedModelRoute = {
		tier: request.tier,
		...(request.override ? { override: request.override } : {}),
		...(request.primaryEffort ? { primaryEffort: request.primaryEffort } : {}),
		allowFallback: fallbackEnabled(request),
	};
	let selectedCandidates = candidates(config, request);
	const modelTiers = activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers;
	const overrideSearchRoutes = request.tier === "local"
		? modelTiers.local
		: Object.entries(modelTiers).filter(([tier]) => tier !== "local").flatMap(([, routes]) => routes);
	const overrideConfigured = request.override
		? overrideSearchRoutes.map(parseRoute).some((route) => routeMatchesOverride(route, request.override!.model))
		: true;
	if (request.override && !overrideConfigured) {
		const availableOverrideModels = request.allowUnconfiguredOverride
			? availableModels.filter((model) => {
				if (request.tier === "local" ? model.provider !== "local-llm" : model.provider === "local-llm") return false;
				return model.id === request.override!.model || `${model.provider}/${model.id}` === request.override!.model;
			})
			: [];
		if (availableOverrideModels.length === 1) {
			const selected = availableOverrideModels[0]!;
			const effort = request.override.effort ?? "off";
			const route: ParsedRoute = {
				configured: `${selected.provider}/${selected.id}#${effort}`,
				provider: selected.provider,
				model: selected.id,
				effort,
			};
			const explicit: Candidate = {
				route,
				effort,
				kind: "requested",
				failOnUnsupportedEffort: request.override.effort !== undefined,
			};
			selectedCandidates = fallbackEnabled(request) ? [explicit, ...selectedCandidates] : [explicit];
		} else if (availableOverrideModels.length > 1) {
			attempts.push({ kind: "requested", model: request.override.model, ...(request.override.effort ? { effort: request.override.effort } : {}), status: "model_ambiguous" });
		} else {
			attempts.push({
				kind: "requested",
				model: request.override.model,
				...(request.override.effort ? { effort: request.override.effort } : {}),
				status: request.allowUnconfiguredOverride ? "model_missing" : "override_not_configured",
			});
		}
	}

	for (let index = 0; index < selectedCandidates.length; index += 1) {
		const candidate = selectedCandidates[index]!;
		const { route, effort } = candidate;
		const model = availableModels.find((item) => item.provider === route.provider && item.id === route.model);
		if (!model) {
			attempts.push({ kind: candidate.kind, provider: route.provider, model: route.model, effort, status: "model_missing" });
			continue;
		}
		if (!supportsEffort(model, effort)) {
			attempts.push({ kind: candidate.kind, provider: route.provider, model: route.model, effort, status: "effort_unsupported" });
			if (candidate.failOnUnsupportedEffort) return { status: "waiting_model", requested, attempts };
			continue;
		}
		const fallback = candidate.kind === "fallback";
		attempts.push({ kind: "selected", provider: route.provider, model: route.model, effort, status: "selected", fallback });
		const selected = { provider: route.provider, model: route.model, effort };
		resolvedCandidates.push(selected);
		for (const remaining of selectedCandidates.slice(index + 1)) {
			const alternate = availableModels.find((item) => item.provider === remaining.route.provider && item.id === remaining.route.model);
			if (alternate && supportsEffort(alternate, remaining.effort)) {
				resolvedCandidates.push({ provider: remaining.route.provider, model: remaining.route.model, effort: remaining.effort });
			}
		}
		return {
			status: "resolved",
			requested,
			selected,
			route: route.configured,
			model,
			effort,
			fallbackUsed: fallback,
			candidates: resolvedCandidates,
			attempts,
		};
	}

	return { status: "waiting_model", requested, attempts };
}
