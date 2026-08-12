import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EFFORT_LEVELS, loadEffortConfig, type EffortConfig } from "./config.js";

function supportedLevels(model: Model<any>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return EFFORT_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

/** Pick the closest supported level, preferring the less expensive option on a tie. */
function safeLevel(model: Model<any>, requested: ModelThinkingLevel): ModelThinkingLevel {
	const supported = supportedLevels(model);
	if (supported.includes(requested)) return requested;
	const requestedIndex = EFFORT_LEVELS.indexOf(requested);
	return supported.reduce((closest, candidate) => {
		const candidateDistance = Math.abs(EFFORT_LEVELS.indexOf(candidate) - requestedIndex);
		const closestDistance = Math.abs(EFFORT_LEVELS.indexOf(closest) - requestedIndex);
		return candidateDistance < closestDistance ? candidate : closest;
	});
}

function configuredLevel(config: EffortConfig, model: Model<any>): ModelThinkingLevel {
	return config.models[`${model.provider}/${model.id}`] ?? config.models[model.id] ?? config.default;
}

export default function effort(pi: ExtensionAPI): void {
	let config: EffortConfig;

	const applyDefault = (model: Model<any>) => {
		pi.setThinkingLevel(safeLevel(model, configuredLevel(config, model)));
	};

	pi.on("session_start", (_event, ctx) => {
		config = loadEffortConfig(ctx.cwd);
		if (ctx.model) applyDefault(ctx.model);
	});

	pi.on("model_select", (event) => applyDefault(event.model));

	pi.registerCommand("effort", {
		description: "Choose the current model's reasoning effort",
		handler: async (args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model is active.", "error");
				return;
			}
			const model = ctx.model;
			const available = supportedLevels(model);
			const requested = args.trim().toLowerCase() as ModelThinkingLevel;
			if (requested) {
				if (!EFFORT_LEVELS.includes(requested)) {
					ctx.ui.notify(`Unknown effort: ${args.trim()}. Available: ${available.join(", ")}`, "error");
					return;
				}
				const selected = safeLevel(model, requested);
				pi.setThinkingLevel(selected);
				ctx.ui.notify(selected === requested ? `Effort: ${selected}` : `Effort: ${selected} (${requested} is unsupported by this model)`, "info");
				return;
			}
			const selected = await ctx.ui.select("Reasoning effort", available.map((level) => level === pi.getThinkingLevel() ? `${level} (current)` : level));
			if (!selected) return;
			pi.setThinkingLevel(selected.replace(" (current)", "") as ModelThinkingLevel);
		},
	});
}
