import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { EFFORT_LEVELS, loadEffortConfig, type EffortConfig } from "./config.js";

export function supportedLevels(model: Model<any>): ModelThinkingLevel[] {
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

export function configuredLevel(config: EffortConfig, model: Model<any>): ModelThinkingLevel {
	const explicit = config.models[`${model.provider}/${model.id}`] ?? config.models[model.id];
	// Local servers vary in how much reasoning they can sustain; keep them
	// conservative unless the user/repository selected this model explicitly.
	return explicit ?? (model.provider === "local-llm" ? "off" : config.default);
}

async function chooseEffort(ctx: ExtensionCommandContext, levels: ModelThinkingLevel[]): Promise<ModelThinkingLevel | undefined> {
	const current = ctx.thinkingLevel ?? "off";
	if (ctx.mode !== "tui") return (await ctx.ui.select("Reasoning effort", levels)) as ModelThinkingLevel | undefined;
	return ctx.ui.custom<ModelThinkingLevel | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Reasoning effort")), 1, 0));
		const list = new SelectList(levels.map((level) => ({ value: level, label: level })), levels.length, selectTheme(theme));
		const currentIndex = levels.indexOf(current);
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => done(item.value as ModelThinkingLevel);
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
		};
	});
}


function selectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
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
			const selected = await chooseEffort(ctx, available);
			if (!selected) return;
			pi.setThinkingLevel(selected);
		},
	});
}
