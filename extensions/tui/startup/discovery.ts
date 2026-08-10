import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface StartupCounts {
	models: number;
	components: number;
	contextFiles?: number;
}

export function discoverStartupCounts(ctx: ExtensionContext): StartupCounts {
	return {
		models: ctx.scopedModels.length > 0 ? ctx.scopedModels.length : ctx.modelRegistry.getAvailable().length,
		components: 5,
	};
}
