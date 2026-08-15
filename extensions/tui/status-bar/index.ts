import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_STATUS_BAR_CONFIG, normalizeStatusBarConfig } from "./config.js";
import { GitPoller } from "./git.js";
import { renderStatusBar } from "./layout.js";
import { collectSessionMetrics } from "./metrics.js";

export default function statusBar(pi: ExtensionAPI): void {
	const config = normalizeStatusBarConfig(DEFAULT_STATUS_BAR_CONFIG);
	let poller: GitPoller | undefined;
	let activeTui: TUI | undefined;
	let clockTimer: ReturnType<typeof setInterval> | undefined;

	const stop = () => {
		poller?.stop();
		poller = undefined;
		if (clockTimer) clearInterval(clockTimer);
		clockTimer = undefined;
		activeTui = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;

		poller = new GitPoller(pi, ctx.cwd, config.git, () => activeTui?.requestRender());
		poller.start();
		clockTimer = setInterval(() => activeTui?.requestRender(), 30_000);

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => poller?.requestRefresh());
			return {
				render(width: number): string[] {
					const extensionStatuses = footerData.getExtensionStatuses();
					const visualCompanionStatus = extensionStatuses.get("visual-companion");
					const subagentStatuses = extensionStatuses.get("subagent-dashboard")?.split("\n").filter(Boolean);
					return renderStatusBar(width, {
						ctx,
						theme,
						thinkingLevel: pi.getThinkingLevel(),
						metrics: collectSessionMetrics(ctx),
						git: poller?.getSnapshot() ?? {
							insideWorkTree: false,
							staged: 0,
							modified: 0,
							untracked: 0,
							ahead: 0,
							behind: 0,
						},
						config,
						...(visualCompanionStatus ? { visualCompanionStatus } : {}),
						...(subagentStatuses?.length ? { subagentStatuses } : {}),
					});
				},
				invalidate(): void {},
				dispose(): void {
					unsubscribeBranch();
					if (activeTui === tui) activeTui = undefined;
				},
			};
		});
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") poller?.requestRefresh();
	});
	pi.on("user_bash", () => poller?.requestRefresh());
	pi.on("session_shutdown", stop);
}
