import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getKeybindings } from "@earendil-works/pi-tui";
import { discoverStartupCounts, type StartupCounts } from "./discovery.js";
import { renderStartup, type StartupKeys } from "./layout.js";

export default function startup(pi: ExtensionAPI): void {
	let counts: StartupCounts | undefined;
	let activeTui: TUI | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		counts = discoverStartupCounts(ctx);
		const keybindings = getKeybindings();
		const keys: StartupKeys = {
			model: keybindings.getKeys("app.model.cycleForward")[0] ?? "ctrl+p",
			thinking: keybindings.getKeys("app.thinking.cycle")[0] ?? "shift+tab",
		};
		ctx.ui.setHeader((tui, theme) => {
			activeTui = tui;
			return {
				render: (width) => renderStartup(theme, counts ?? { models: 0, components: 5 }, keys, width),
				invalidate(): void {},
				dispose(): void {
					if (activeTui === tui) activeTui = undefined;
				},
			};
		});
	});

	pi.on("before_agent_start", (event) => {
		if (counts) counts.contextFiles = event.systemPromptOptions.contextFiles?.length ?? 0;
		activeTui?.requestRender();
	});
	pi.on("session_shutdown", () => {
		counts = undefined;
		activeTui = undefined;
	});
}
