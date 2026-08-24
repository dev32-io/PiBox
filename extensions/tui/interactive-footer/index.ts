import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInteractiveFooterItem } from "./registry.js";
import type { InteractiveFooterRegistration } from "./types.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof LEVELS)[number];

const LABELS: Record<Effort, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

function effortForLabel(label: string): Effort | undefined {
	return LEVELS.find((level) => LABELS[level] === label);
}

export default function interactiveFooter(pi: ExtensionAPI): void {
	let registration: InteractiveFooterRegistration | undefined;
	pi.on("session_start", () => {
		registration?.unregister();
		registration = registerInteractiveFooterItem({
			id: "effort",
			section: "settings",
			order: 20,
			status: () => ({ label: "Effort", value: LABELS[pi.getThinkingLevel() as Effort] ?? pi.getThinkingLevel(), valueTone: "accent" }),
			dialog: () => ({
				title: "Effort",
				description: "Set the reasoning effort for the active model. Unsupported levels are clamped by Pi.",
				rows: [{
					kind: "setting",
					id: "effort",
					label: "Reasoning effort",
					value: () => LABELS[pi.getThinkingLevel() as Effort] ?? pi.getThinkingLevel(),
					values: LEVELS.map((level) => LABELS[level]),
					setValue(value) {
						const effort = effortForLabel(value);
						if (effort) pi.setThinkingLevel(effort);
						registration?.changed();
					},
				}],
			}),
		});
	});
	pi.on("thinking_level_select", () => registration?.changed());
	pi.on("model_select", () => registration?.changed());
	pi.on("session_shutdown", () => {
		registration?.unregister();
		registration = undefined;
	});
}

export * from "./controller.js";
export * from "./dialog.js";
export * from "./registry.js";
export * from "./types.js";
