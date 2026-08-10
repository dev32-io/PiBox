import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "./config.js";
import type { GitSnapshot } from "./git.js";
import type { SessionMetrics } from "./metrics.js";
import { compactNumber, formatCwd, formatDuration, formatGit } from "./segments/format.js";

export type LayoutMode = "wide" | "medium" | "narrow";

interface Segment {
	text: string;
	priority: number;
}

export interface StatusRenderData {
	ctx: ExtensionContext;
	theme: Theme;
	thinkingLevel: string;
	metrics: SessionMetrics;
	git: GitSnapshot;
	config: StatusBarConfig;
}

export function layoutMode(width: number, config: StatusBarConfig): LayoutMode {
	if (width >= config.wideBreakpoint) return "wide";
	if (width >= config.mediumBreakpoint) return "medium";
	return "narrow";
}

function joinSegments(segments: Segment[]): string {
	return segments.map((segment) => segment.text).join(" · ");
}

function fitSegments(segments: Segment[], width: number): string {
	const kept = [...segments];
	while (kept.length > 1 && visibleWidth(joinSegments(kept)) > width) {
		let removalIndex = 0;
		for (let index = 1; index < kept.length; index++) {
			if ((kept[index]?.priority ?? 0) > (kept[removalIndex]?.priority ?? 0)) removalIndex = index;
		}
		kept.splice(removalIndex, 1);
	}
	return truncateToWidth(joinSegments(kept), width, "…");
}

function fitSides(left: Segment[], right: Segment[], width: number): string {
	let leftText = fitSegments(left, width);
	let rightText = fitSegments(right, width);
	while (visibleWidth(leftText) + visibleWidth(rightText) + 2 > width && left.length + right.length > 2) {
		const leftWorst = Math.max(...left.map((segment) => segment.priority));
		const rightWorst = Math.max(...right.map((segment) => segment.priority));
		if (rightWorst >= leftWorst && right.length > 1) right.splice(right.findIndex((s) => s.priority === rightWorst), 1);
		else if (left.length > 1) left.splice(left.findIndex((s) => s.priority === leftWorst), 1);
		leftText = joinSegments(left);
		rightText = joinSegments(right);
	}
	if (visibleWidth(rightText) >= width) return truncateToWidth(rightText, width, "…");
	const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
	leftText = truncateToWidth(leftText, availableLeft, "…");
	const gap = " ".repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)));
	return truncateToWidth(leftText + gap + rightText, width, "");
}

function rgb(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m${text}\x1b[0m`;
}

function gauge(percent: number, width: number, theme: Theme, config: StatusBarConfig): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	let output = "";
	for (let index = 0; index < width; index++) {
		if (index >= filled) output += theme.fg("dim", "░");
		else if (clamped >= config.errorPercent) output += theme.fg("error", "▋");
		else if (clamped >= config.warningPercent) output += theme.fg("warning", "▋");
		else {
			const ratio = width <= 1 ? 0 : index / (width - 1);
			output += rgb(49 + (109 - 49) * ratio, 80 + (143 - 80) * ratio, 93 + (232 - 93) * ratio, "▋");
		}
	}
	return output;
}

function modelLabel(data: StatusRenderData, includeProvider: boolean): string {
	const model = data.ctx.model;
	if (!model) return data.theme.fg("warning", "no model");
	const provider = includeProvider ? ` (${model.provider})` : "";
	return data.theme.fg("text", `${model.name || model.id}${provider}`);
}

function contextLabel(data: StatusRenderData, mode: LayoutMode): string {
	const usage = data.ctx.getContextUsage();
	if (!usage || usage.percent === null) return data.theme.fg("dim", "ctx —");
	const percent = Math.round(usage.percent);
	const color = percent >= data.config.errorPercent ? "error" : percent >= data.config.warningPercent ? "warning" : "accent";
	const window = compactNumber(usage.contextWindow);
	const tokens = usage.tokens === null ? undefined : compactNumber(usage.tokens);
	if (mode === "narrow") return data.theme.fg(color, `ctx ${percent}%`);
	const gaugeWidth = mode === "wide" ? data.config.wideGaugeWidth : data.config.mediumGaugeWidth;
	const detail = mode === "wide" ? ` · ${tokens === undefined ? "—" : tokens}/${window}` : "";
	return `${gauge(usage.percent, gaugeWidth, data.theme, data.config)} ${data.theme.fg(color, `${percent}%`)}${data.theme.fg("dim", detail)}`;
}

function usageSegments(data: StatusRenderData): Segment[] {
	const { metrics, theme } = data;
	const values: Segment[] = [
		{ text: theme.fg("muted", `↑${compactNumber(metrics.input)}`), priority: 1 },
		{ text: theme.fg("muted", `↓${compactNumber(metrics.output)}`), priority: 1 },
	];
	if (metrics.cacheRead > 0) {
		values.push({
			text: theme.fg("dim", `cache ${Math.round(metrics.cacheHitPercent ?? 0)}%/${compactNumber(metrics.cacheRead)}`),
			priority: 3,
		});
	}
	if (metrics.cost !== undefined) values.push({ text: theme.fg("muted", `$${metrics.cost.toFixed(3)}`), priority: 2 });
	return values;
}

export function renderStatusBar(width: number, data: StatusRenderData): string[] {
	if (width <= 0) return [];
	const mode = layoutMode(width, data.config);
	const { theme, metrics } = data;
	const git = formatGit(data.git);
	const thinking = theme.fg("muted", mode === "wide" ? `thinking ${data.thinkingLevel.toUpperCase()}` : data.thinkingLevel.toUpperCase());
	const project = theme.fg("muted", formatCwd(data.ctx.cwd, mode === "wide"));
	const sessionName = data.ctx.sessionManager.getSessionName();

	if (mode === "wide") {
		const firstLeft: Segment[] = [
			{ text: theme.fg("accent", "PiBox"), priority: 6 },
			{ text: modelLabel(data, true), priority: 0 },
			{ text: project, priority: 4 },
		];
		if (git) firstLeft.push({ text: theme.fg("success", git), priority: 3 });
		const secondLeft: Segment[] = [
			{ text: thinking, priority: 0 },
			{ text: theme.fg("dim", formatDuration(metrics.durationMs)), priority: 5 },
		];
		if (sessionName) secondLeft.push({ text: theme.fg("dim", sessionName), priority: 6 });
		return [
			fitSides(firstLeft, [{ text: contextLabel(data, mode), priority: 0 }], width),
			fitSides(secondLeft, usageSegments(data), width),
		];
	}

	if (mode === "medium") {
		const firstLeft: Segment[] = [
			{ text: modelLabel(data, false), priority: 0 },
			{ text: thinking, priority: 1 },
			{ text: project, priority: 3 },
		];
		if (git) firstLeft.push({ text: theme.fg("success", git), priority: 2 });
		return [fitSides(firstLeft, [{ text: contextLabel(data, mode), priority: 0 }], width), fitSegments(usageSegments(data), width)];
	}

	const first: Segment[] = [
		{ text: modelLabel(data, false), priority: 0 },
		{ text: thinking, priority: 1 },
		{ text: contextLabel(data, mode), priority: 0 },
	];
	const second: Segment[] = [{ text: theme.fg("muted", formatCwd(data.ctx.cwd)), priority: 0 }];
	if (git) second.push({ text: theme.fg("success", git), priority: 1 });
	second.push(...usageSegments(data));
	return [fitSegments(first, width), fitSegments(second, width)];
}
