import { SUBAGENT_ANIMATION_INTERVAL_MS } from "../../../subagent/display.js";

/** Running tool rows twinkle on the shared subagent clock so every row stays in phase. */
export const TOOL_RUNNING_FRAMES = ["·", "✢", "✶", "✻", "✽", "✻", "✶", "✢"] as const;
export const TOOL_RUNNING_STATIC_GLYPH = "✽";

export function toolRunningFrame(now = Date.now()): string {
	return TOOL_RUNNING_FRAMES[Math.floor(now / SUBAGENT_ANIMATION_INTERVAL_MS) % TOOL_RUNNING_FRAMES.length]!;
}

/** Final duration: 0.4s, 2.1s, 12s, 1m 05s. Sub-100ms work rounds up to 0.1s. */
export function formatToolDuration(milliseconds: number): string {
	const tenths = Math.max(1, Math.round(milliseconds / 100));
	if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
	return formatWholeSeconds(Math.round(milliseconds / 1_000));
}

/** Live elapsed time in whole seconds; omitted below one second to avoid a `0s` flash on quick tools. */
export function formatToolElapsed(milliseconds: number): string | undefined {
	const seconds = Math.floor(milliseconds / 1_000);
	return seconds >= 1 ? formatWholeSeconds(seconds) : undefined;
}

function formatWholeSeconds(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export interface ToolTiming {
	startedAt?: number;
	durationMs?: number;
	/** Set when the host ended the run while this row was still running; the elapsed clock stops here. */
	frozenAt?: number;
}

/**
 * Record row timing in renderer state (`ctx.state`). The start is captured when
 * execution starts; the end when the final result first renders. Rows that never
 * executed in this process (restored sessions) keep no start, so no duration is
 * invented. Pi >=1.1 supplies an authoritative `durationMs`, which wins.
 */
export function markToolTiming(
	state: Record<string, any> | undefined,
	row: { executionStarted?: boolean; isPartial: boolean; durationMs?: number },
	now = Date.now(),
): ToolTiming | undefined {
	if (!state) return undefined;
	const timing: ToolTiming = (state.piboxTiming ??= {});
	if (row.isPartial) {
		if (row.executionStarted === true && timing.startedAt === undefined) timing.startedAt = now;
	} else if (timing.durationMs === undefined) {
		if (typeof row.durationMs === "number" && Number.isFinite(row.durationMs)) timing.durationMs = Math.max(0, row.durationMs);
		else if (timing.startedAt !== undefined) timing.durationMs = Math.max(0, now - timing.startedAt);
	}
	return timing;
}

/** `Running… 12s` while in flight. */
export function runningStatus(timing: ToolTiming | undefined, now = Date.now()): string {
	const elapsed = timing?.startedAt === undefined ? undefined : formatToolElapsed((timing.frozenAt ?? now) - timing.startedAt);
	return elapsed ? `Running… ${elapsed}` : "Running…";
}

interface ActivityHost {
	readonly mode?: string;
	requestRender?(): void;
}

type Schedule = (callback: () => void, ms: number) => { unref?(): unknown };

/**
 * One render timer for every running tool row. It runs only while a running row
 * belongs to a fullscreen (alternate-screen) TUI: Pi >=1.0 renderers expose
 * `mode` ("fullscreen" | "regular") through the stable TUI reference handed to
 * each tool component. Unknown or regular mode keeps static glyphs, because
 * periodic redraws in main-screen mode flicker once rows reach scrollback.
 */
export class ToolActivityTracker {
	private readonly rows = new Map<string, { host: ActivityHost; timing?: ToolTiming | undefined }>();
	// Calls settled by host events stay out even if their discarded row re-renders as partial.
	private readonly settled = new Set<string>();
	private timer: ReturnType<Schedule> | undefined;

	constructor(
		private readonly schedule: Schedule = setInterval,
		private readonly cancel: (timer: any) => void = clearInterval,
	) {}

	get animating(): boolean {
		return this.timer !== undefined;
	}

	get runningCount(): number {
		return this.rows.size;
	}

	update(toolCallId: string, running: boolean, host?: ActivityHost, timing?: ToolTiming): void {
		if (running && host && !this.settled.has(toolCallId)) this.rows.set(toolCallId, { host, timing });
		else this.rows.delete(toolCallId);
		this.sync();
	}

	/** Host lifecycle (tool end, agent end) is authoritative over row render state. */
	settle(toolCallId?: string, now = Date.now()): void {
		const ids = toolCallId === undefined ? [...this.rows.keys()] : [toolCallId];
		for (const id of ids) {
			// A row that never got its own end keeps its last elapsed time instead of counting on.
			const timing = this.rows.get(id)?.timing;
			if (timing && timing.durationMs === undefined) timing.frozenAt ??= now;
			this.settled.add(id);
			this.rows.delete(id);
		}
		this.sync();
	}

	/** Session boundary: forget everything. */
	clear(): void {
		this.rows.clear();
		this.settled.clear();
		this.sync();
	}

	private fullscreenHost(): ActivityHost | undefined {
		for (const { host } of this.rows.values()) if (host.mode === "fullscreen") return host;
		return undefined;
	}

	private sync(): void {
		const active = this.fullscreenHost() !== undefined;
		if (active && !this.timer) {
			this.timer = this.schedule(() => this.tick(), SUBAGENT_ANIMATION_INTERVAL_MS);
			this.timer.unref?.();
		} else if (!active && this.timer) {
			this.cancel(this.timer);
			this.timer = undefined;
		}
	}

	private tick(): void {
		// A /settings switch to regular mode stops the animation on the next tick.
		this.sync();
		this.fullscreenHost()?.requestRender?.();
	}
}

const TRACKER_KEY = Symbol.for("pibox:styled-outputs:tool-activity");

export function toolActivity(): ToolActivityTracker {
	const root = globalThis as typeof globalThis & { [TRACKER_KEY]?: ToolActivityTracker };
	return (root[TRACKER_KEY] ??= new ToolActivityTracker());
}

/** /reload replaces the tracker so a stale module's timer cannot survive. */
export function resetToolActivity(): void {
	const root = globalThis as typeof globalThis & { [TRACKER_KEY]?: ToolActivityTracker };
	root[TRACKER_KEY]?.clear();
	root[TRACKER_KEY] = new ToolActivityTracker();
}

/** Static `✽` unless the shared fullscreen timer is driving redraws. */
export function runningGlyph(now = Date.now()): string {
	return toolActivity().animating ? toolRunningFrame(now) : TOOL_RUNNING_STATIC_GLYPH;
}
