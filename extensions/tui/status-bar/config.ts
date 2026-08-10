export interface GitConfig {
	enabled: boolean;
	refreshMode: "poll" | "manual";
	pollIntervalMs: number;
	commandTimeoutMs: number;
	includeUntracked: boolean;
}

export interface StatusBarConfig {
	wideBreakpoint: number;
	mediumBreakpoint: number;
	wideGaugeWidth: number;
	mediumGaugeWidth: number;
	warningPercent: number;
	errorPercent: number;
	git: GitConfig;
}

export const MIN_GIT_POLL_INTERVAL_MS = 2_000;

export const DEFAULT_STATUS_BAR_CONFIG: Readonly<StatusBarConfig> = {
	wideBreakpoint: 110,
	mediumBreakpoint: 72,
	wideGaugeWidth: 18,
	mediumGaugeWidth: 10,
	warningPercent: 70,
	errorPercent: 90,
	git: {
		enabled: true,
		refreshMode: "poll",
		pollIntervalMs: 10_000,
		commandTimeoutMs: 3_000,
		includeUntracked: true,
	},
};

export function normalizeStatusBarConfig(input: Partial<StatusBarConfig> = {}): StatusBarConfig {
	const git = { ...DEFAULT_STATUS_BAR_CONFIG.git, ...input.git };
	git.pollIntervalMs = Math.max(MIN_GIT_POLL_INTERVAL_MS, Math.floor(git.pollIntervalMs));
	git.commandTimeoutMs = Math.max(250, Math.floor(git.commandTimeoutMs));
	return {
		...DEFAULT_STATUS_BAR_CONFIG,
		...input,
		wideBreakpoint: Math.max(80, Math.floor(input.wideBreakpoint ?? DEFAULT_STATUS_BAR_CONFIG.wideBreakpoint)),
		mediumBreakpoint: Math.max(40, Math.floor(input.mediumBreakpoint ?? DEFAULT_STATUS_BAR_CONFIG.mediumBreakpoint)),
		wideGaugeWidth: Math.max(4, Math.floor(input.wideGaugeWidth ?? DEFAULT_STATUS_BAR_CONFIG.wideGaugeWidth)),
		mediumGaugeWidth: Math.max(4, Math.floor(input.mediumGaugeWidth ?? DEFAULT_STATUS_BAR_CONFIG.mediumGaugeWidth)),
		git,
	};
}
