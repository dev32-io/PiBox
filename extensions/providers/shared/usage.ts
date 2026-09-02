import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface UsageWindow {
	/** Percentage already used, when the provider reports a limit and usage. */
	usedPercent: number;
	resetAt?: number;
	durationMs?: number;
}

export interface UsageSnapshot {
	provider: string;
	windows: UsageWindow[];
	observedAt: number;
	stale?: boolean;
	capacity?: { retryAfterAt?: number };
}

export const USAGE_STATUS_PREFIX = "provider-usage:";

function finiteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
	const number = finiteNumber(value);
	if (number === undefined || number <= 0) return undefined;
	return number < 100_000_000_000 ? number * 1_000 : number;
}

export function normalizeWindows(input: unknown): UsageWindow[] {
	if (!Array.isArray(input)) return [];
	return input.flatMap((item): UsageWindow[] => {
		if (!item || typeof item !== "object") return [];
		const value = item as Record<string, unknown>;
		const usedPercent = finiteNumber(value.usedPercent ?? value.used_percent ?? value.percent);
		if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return [];
		const resetAt = epochMilliseconds(value.resetAt ?? value.reset_at ?? value.resetsAt ?? value.resets_at);
		const durationMs = finiteNumber(value.durationMs ?? value.duration_ms)
			?? (finiteNumber(value.windowDurationMins ?? value.window_duration_mins) !== undefined
				? finiteNumber(value.windowDurationMins ?? value.window_duration_mins)! * 60_000
				: finiteNumber(value.limit_window_seconds) !== undefined
					? finiteNumber(value.limit_window_seconds)! * 1_000
					: undefined);
		return [{ usedPercent, ...(resetAt !== undefined ? { resetAt } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }];
	});
}

export function publishUsage(ctx: ExtensionContext, snapshot: UsageSnapshot): void {
	if (!ctx.hasUI) return;
	// This channel contains observations only; credentials and request headers are
	// never persisted in footer status state.
	ctx.ui.setStatus(`${USAGE_STATUS_PREFIX}${snapshot.provider}`, JSON.stringify(snapshot));
}

export function clearUsage(ctx: ExtensionContext, provider: string): void {
	if (ctx.hasUI) ctx.ui.setStatus(`${USAGE_STATUS_PREFIX}${provider}`, undefined);
}

export function readUsageStatus(status: string | undefined): UsageSnapshot | undefined {
	if (!status) return undefined;
	try {
		const value = JSON.parse(status) as UsageSnapshot;
		const windows = normalizeWindows(value.windows);
		return typeof value.provider === "string" && windows.length ? { ...value, windows } : undefined;
	} catch {
		return undefined;
	}
}

export function formatReset(resetAt: number, now = Date.now()): string {
	const date = new Date(resetAt);
	if (!Number.isFinite(date.getTime())) return "";
	const hour = date.getHours();
	const clock = `${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")}${hour >= 12 ? "PM" : "AM"}`;
	const sameDay = date.toDateString() === new Date(now).toDateString();
	return sameDay ? clock : `${date.toLocaleDateString([], { weekday: "short" })} ${clock}`;
}

export function formatUsageSnapshot(snapshot: UsageSnapshot, now = Date.now()): string {
	const prefix = snapshot.stale ? "~" : "";
	return snapshot.windows
		.map((window) => `${prefix}${Math.round(100 - window.usedPercent)}%${window.resetAt ? ` ${formatReset(window.resetAt, now)}` : ""}`)
		.join(" · ");
}
