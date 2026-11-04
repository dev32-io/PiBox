import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "./config.js";
import type { GitSnapshot } from "./git.js";
import type { SessionMetrics } from "./metrics.js";
import { renderPermissionMode } from "../../permissions/display.js";
import { ICON_FOLDER, ICON_POWERLINE_ARROW, ICON_POWERLINE_BRANCH, ICON_POWERLINE_CAP } from "../icons.js";
import { formatCwd, formatGit } from "./segments/format.js";
import { formatUsageSnapshot, type UsageSnapshot } from "../../providers/shared/usage.js";
import type { FastModeStatus } from "../../fast-mode/policy.js";
import type { ModelTierProfileStatus } from "../../model-tier-list-profiles/policy.js";
import { currentSubagentIndicator, renderSubagentFooterProjection } from "../../subagent/display.js";
import type { SubagentUiProjection } from "../../subagent/ui-projection.js";
import { DEFAULT_WORK_MODE, WORK_MODE_ICONS, type PiBoxWorkMode } from "../../work-mode/policy.js";

export type LayoutMode = "wide" | "medium" | "narrow";

export interface ServiceStatusSegment {
	id: string;
	text: string;
}

export interface StatusRenderData {
	ctx: ExtensionContext;
	usage?: UsageSnapshot;
	theme: Theme;
	thinkingLevel: string;
	permissionMode: "enforce" | "bypass";
	workMode?: PiBoxWorkMode;
	tierProfile?: ModelTierProfileStatus;
	fastMode?: FastModeStatus;
	metrics: SessionMetrics;
	git: GitSnapshot;
	config: StatusBarConfig;
	serviceStatuses?: Array<string | ServiceStatusSegment>;
	subagents?: SubagentUiProjection;
	selectedInteractiveId?: string;
	/** Deterministic render clock for animation and elapsed live-agent time. */
	now?: number;
}

export interface StatusBarLayout {
	lines: string[];
	interactiveRows: string[][];
}

export function layoutMode(width: number, config: StatusBarConfig): LayoutMode {
	if (width >= config.wideBreakpoint) return "wide";
	if (width >= config.mediumBreakpoint) return "medium";
	return "narrow";
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function separator(theme: Theme): string {
	return theme.fg("dim", "│");
}

function workModeMark(data: StatusRenderData): string {
	const icon = data.theme.fg("accent", WORK_MODE_ICONS[data.workMode ?? DEFAULT_WORK_MODE]);
	return data.selectedInteractiveId === "work-mode" ? `${data.theme.fg("accent", "›")} ${icon}` : icon;
}

function buildRow(leftParts: string[], rightParts: string[], width: number): string {
	if (width <= 0) return "";
	if (width < 2) return " ".repeat(width);
	const contentWidth = Math.max(0, width - 2);
	const left = leftParts.filter(Boolean).join(" ");
	const right = rightParts.filter(Boolean).join(" ");
	if (!right) {
		const fitted = truncateToWidth(left, contentWidth, "");
		return ` ${fitted}${" ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)))} `;
	}
	if (visibleWidth(right) >= contentWidth) return ` ${truncateToWidth(right, contentWidth, "")} `;
	const maxLeft = Math.max(0, contentWidth - visibleWidth(right) - 1);
	const fittedLeft = truncateToWidth(left, maxLeft, "");
	const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(fittedLeft) - visibleWidth(right)));
	return truncateToWidth(` ${fittedLeft}${gap}${right} `, width, "");
}

function rgb(red: number, green: number, blue: number, text: string): string {
	return `\x1b[38;2;${Math.round(red)};${Math.round(green)};${Math.round(blue)}m${text}\x1b[0m`;
}

function gauge(percent: number, width: number, theme: Theme, config: StatusBarConfig): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	let result = "";
	for (let index = 0; index < width; index++) {
		if (index >= filled) {
			result += rgb(49, 80, 93, "▋");
			continue;
		}
		if (clamped >= config.errorPercent) {
			result += theme.fg("error", "▋");
			continue;
		}
		if (clamped >= config.warningPercent) {
			result += theme.fg("warning", "▋");
			continue;
		}
		const position = width <= 1 ? 0 : index / (width - 1);
		const firstHalf = position <= 0.55;
		const local = firstHalf ? position / 0.55 : (position - 0.55) / 0.45;
		const start = firstHalf ? [49, 80, 93] : [85, 181, 199];
		const end = firstHalf ? [85, 181, 199] : [109, 143, 232];
		result += rgb(
			(start[0] ?? 0) + ((end[0] ?? 0) - (start[0] ?? 0)) * local,
			(start[1] ?? 0) + ((end[1] ?? 0) - (start[1] ?? 0)) * local,
			(start[2] ?? 0) + ((end[2] ?? 0) - (start[2] ?? 0)) * local,
			"▋",
		);
	}
	return result;
}

function contextSegment(data: StatusRenderData, mode: LayoutMode): string {
	const usage = data.ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? data.ctx.model?.contextWindow;
	if (!contextWindow) return data.theme.fg("dim", "ctx —");
	const gaugeWidth = mode === "narrow" ? 8 : mode === "medium" ? data.config.mediumGaugeWidth : data.config.wideGaugeWidth;
	if (!usage || usage.percent === null) {
		return `${gauge(0, gaugeWidth, data.theme, data.config)} ${data.theme.fg("dim", `— / ${formatTokens(contextWindow)}`)}`;
	}
	const percent = Math.max(0, usage.percent);
	const color = percent >= data.config.errorPercent ? "error" : percent >= data.config.warningPercent ? "warning" : "muted";
	return `${gauge(percent, gaugeWidth, data.theme, data.config)} ${data.theme.fg(color, `${percent.toFixed(1)}%`)} ${data.theme.fg("dim", `/ ${formatTokens(contextWindow)}`)}`;
}

function quotaSegment(data: StatusRenderData, mode: LayoutMode, width: number, context: string): string {
	if (!data.usage?.windows.length || mode === "narrow") return "";
	if ((mode === "medium" && width < 100) || (mode === "wide" && width < 120)) return "";
	const text = formatUsageSnapshot(data.usage);
	// Never let buildRow partially truncate the optional quota area. The existing
	// context segment remains complete and the entire suffix disappears instead.
	if (visibleWidth(context) + visibleWidth(text) + 3 > Math.max(0, width - 2)) return "";
	return data.usage.stale ? data.theme.fg("dim", text) : data.theme.fg("muted", text);
}

function modelSegment(data: StatusRenderData): string {
	const model = data.ctx.model;
	if (!model) return data.theme.fg("warning", "no-model");
	let name = model.name || model.id;
	if (name.startsWith("Claude ")) name = name.slice(7);
	return `${data.theme.fg("text", name)} ${data.theme.fg("dim", `(${model.provider})`)}`;
}

interface PowerlineBlock {
	/** Theme token whose foreground color becomes the block background. */
	color: ThemeColor;
	/** Block body; may carry its own foreground escapes, otherwise dark text. */
	text: string;
	/** Light text for darker blocks. */
	light?: boolean;
}

const RESET_FG = "\x1b[39m";
const RESET_BG = "\x1b[49m";
const DARK_TEXT = "\x1b[38;2;11;17;22m";
const LIGHT_TEXT = "\x1b[38;2;220;231;236m";
const SOFT_TEXT = "\x1b[38;2;178;195;204m";

/** Turn a theme foreground escape into the matching background escape. */
function backgroundOf(foreground: string): string {
	return foreground.replace(/\[38;/g, "[48;").replace(/\[3([0-7])m/g, "[4$1m").replace(/\[9([0-7])m/g, "[10$1m");
}

function hasAnsiTheme(theme: Theme): boolean {
	return typeof theme.getFgAnsi === "function";
}

/**
 * One continuous oh-my-zsh agnoster-style chain: a rounded cap, then filled
 * blocks, each ending in a hard powerline arrow drawn in its own color on the
 * next block's background. Hosts without ANSI theme access get plain text.
 */
function powerline(theme: Theme, blocks: PowerlineBlock[]): string {
	const visible = blocks.filter((block) => block.text);
	if (visible.length === 0) return "";
	if (!hasAnsiTheme(theme)) return visible.map((block) => block.text).join(" ");
	const fg = visible.map((block) => theme.getFgAnsi(block.color));
	const bg = fg.map(backgroundOf);
	const cap = `${fg[0]}${ICON_POWERLINE_CAP}${RESET_FG}`;
	return cap + visible.map((block, index) => {
		const next = index + 1 < visible.length ? bg[index + 1] : RESET_BG;
		const text = block.light ? LIGHT_TEXT : DARK_TEXT;
		return `${bg[index]}${text}${index === 0 ? "" : " "}${block.text}${text} ${fg[index]}${next}${ICON_POWERLINE_ARROW}${RESET_FG}`;
	}).join("") + RESET_BG;
}

function modelBlockText(data: StatusRenderData): string {
	const model = data.ctx.model;
	if (!model) return "no-model";
	let name = model.name || model.id;
	if (name.startsWith("Claude ")) name = name.slice(7);
	return `${LIGHT_TEXT}${name} ${SOFT_TEXT}${model.provider}`;
}

/** π (work mode) → model → cwd → git, as one chain; trailing blocks drop first when narrow. */
function headerChain(data: StatusRenderData, mode: LayoutMode, depth: number): string {
	const path = formatCwd(data.ctx.cwd, mode === "wide");
	const status = formatGit(data.git);
	const dirty = data.git.staged + data.git.modified + data.git.untracked > 0;
	const blocks: PowerlineBlock[] = [
		{ color: "accent", text: WORK_MODE_ICONS[data.workMode ?? DEFAULT_WORK_MODE] },
		{ color: "borderMuted", text: modelBlockText(data), light: true },
		{ color: "border", text: `${ICON_FOLDER} ${path}` },
		...(status ? [{ color: (dirty ? "warning" : "success") as ThemeColor, text: `${ICON_POWERLINE_BRANCH} ${status}` }] : []),
	];
	const chain = powerline(data.theme, blocks.slice(0, depth));
	return data.selectedInteractiveId === "work-mode" ? `${data.theme.fg("accent", "›")} ${chain}` : chain;
}

function permissionSegment(data: StatusRenderData): string {
	return renderPermissionMode(data.permissionMode, data.theme);
}

function capitalize(value: string): string {
	return value ? `${value[0]!.toUpperCase()}${value.slice(1).toLowerCase()}` : value;
}

function effortSegment(data: StatusRenderData): string {
	const level = data.thinkingLevel || "off";
	const labels: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
	const colors: Record<string, "dim" | "muted" | "warning" | "success" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax"> = {
		off: "dim", minimal: "muted", low: "warning", medium: "success", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
	};
	return `${data.theme.fg("dim", "Effort:")} ${data.theme.fg(colors[level] ?? "muted", labels[level] ?? capitalize(level))}`;
}

function tierProfileSegment(data: StatusRenderData): string {
	if (!data.tierProfile) return "";
	return `${data.theme.fg("dim", "Tier:")} ${data.theme.fg("muted", capitalize(data.tierProfile.profile))}`;
}

function fastModeSegment(data: StatusRenderData): string {
	const status = data.fastMode;
	if (!status) return "";
	const scopes: string[] = [];
	if (status.mainEnabled) scopes.push("Main");
	if (status.subagents !== "off") {
		const labels = { low: "Low", medium: "Med", high: "High", max: "Max" } as const;
		scopes.push(`Sub≤${labels[status.subagents]}`);
	}
	if (scopes.length === 0 && !status.mainAvailable) return "";
	const value = scopes.length > 0 ? scopes.join("+") : "Off";
	return `${data.theme.fg("dim", "Fast:")} ${data.theme.fg(scopes.length > 0 ? "warning" : "dim", value)}`;
}

function rowFits(leftParts: string[], rightParts: string[], width: number): boolean {
	const contentWidth = Math.max(0, width - 2);
	const left = leftParts.filter(Boolean).join(" ");
	const right = rightParts.filter(Boolean).join(" ");
	return visibleWidth(left) + visibleWidth(right) + (left && right ? 1 : 0) <= contentWidth;
}

function tokenSegment(data: StatusRenderData): string {
	const { metrics, theme } = data;
	const cached = metrics.cacheRead + metrics.cacheWrite;
	const total = metrics.input + metrics.output + cached;
	const cacheRate = metrics.cacheHitPercent === undefined ? "" : ` ~${Math.round(metrics.cacheHitPercent)}%`;
	return [
		`${theme.fg("dim", "T:")} ${theme.fg("muted", formatTokens(total))}`,
		`${theme.fg("dim", "(")}${theme.fg("muted", formatTokens(cached))}${theme.fg("dim", ` cached${cacheRate})`)}`,
		`${theme.fg("dim", "↑")} ${theme.fg("muted", formatTokens(metrics.input))}`,
		`${theme.fg("dim", "↓")} ${theme.fg("muted", formatTokens(metrics.output))}`,
	].join(" ");
}

function costSegment(data: StatusRenderData): string {
	const rates = data.ctx.model?.cost;
	const hasRates = !!rates && rates.input + rates.output + rates.cacheRead + rates.cacheWrite > 0;
	if (data.metrics.cost === undefined && !hasRates) return "";
	return data.theme.fg("muted", `$${(data.metrics.cost ?? 0).toFixed(2)}`);
}

interface InteractiveSegment {
	id: string;
	text: string;
}

function decorateInteractiveSegment(segment: InteractiveSegment, data: StatusRenderData): string {
	return segment.id === data.selectedInteractiveId ? `${data.theme.fg("accent", "›")} ${segment.text}` : segment.text;
}

function segmentTexts(segments: InteractiveSegment[], divider: string): string[] {
	return segments.flatMap((segment, index) => index === 0 ? [segment.text] : [divider, segment.text]);
}

function fitLeftInteractiveSegments(segments: InteractiveSegment[], rightParts: string[], width: number, divider: string): InteractiveSegment[] {
	const contentWidth = Math.max(0, width - 2);
	const right = rightParts.filter(Boolean).join(" ");
	if (visibleWidth(right) >= contentWidth) return [];
	const available = Math.max(0, contentWidth - visibleWidth(right) - (right ? 1 : 0));
	const fitted: InteractiveSegment[] = [];
	let used = 0;
	for (const segment of segments) {
		// Reserve the two-column selection marker even while inactive so entering
		// footer mode cannot make the selected element disappear.
		const extra = (fitted.length > 0 ? visibleWidth(` ${divider} `) : 0) + visibleWidth(segment.text) + 2;
		if (used + extra > available) break;
		fitted.push(segment);
		used += extra;
	}
	return fitted;
}

function fitServiceSegments(services: ServiceStatusSegment[], width: number, divider: string): ServiceStatusSegment[] {
	const contentWidth = Math.max(0, width - 2);
	const fitted: ServiceStatusSegment[] = [];
	let used = 0;
	for (const service of services) {
		// Reserve the selection marker for every service so moving selection does
		// not make an otherwise reachable trailing service disappear.
		const extra = (fitted.length > 0 ? visibleWidth(` ${divider} `) : 0) + visibleWidth(service.text) + 2;
		if (used + extra > contentWidth) break;
		fitted.push(service);
		used += extra;
	}
	// Keep the first service reachable when even one full segment cannot fit;
	// buildRow will safely truncate that one visible segment.
	return fitted.length > 0 ? fitted : services.slice(0, 1);
}

export function renderStatusBarLayout(width: number, data: StatusRenderData): StatusBarLayout {
	if (width <= 0) return { lines: [], interactiveRows: [] };
	const mode = layoutMode(width, data.config);
	const divider = separator(data.theme);
	const piMark = workModeMark(data);
	const model = modelSegment(data);
	const row1LeftCandidates = hasAnsiTheme(data.theme)
		? [4, 3, 2, 1].map((depth) => [headerChain(data, mode, depth)])
		: [
			[piMark, divider, model, divider, formatCwd(data.ctx.cwd, mode === "wide"), formatGit(data.git) ?? ""],
			[piMark, divider, model, divider, formatCwd(data.ctx.cwd, mode === "wide")],
			[piMark, divider, model],
			[piMark],
		];
	const context = contextSegment(data, mode);
	const quota = quotaSegment(data, mode, width, context);
	let row1Right = [context, ...(quota ? [separator(data.theme), quota] : [])];
	let row1Left = row1LeftCandidates.find((candidate) => rowFits(candidate, row1Right, width)) ?? row1LeftCandidates.at(-1)!;
	if (!rowFits(row1Left, row1Right, width)) row1Right = [];
	const row1 = buildRow(row1Left, row1Right, width);
	const row2Right = [tokenSegment(data), ...(costSegment(data) ? [divider, costSegment(data)] : [])];
	const baseSegments: InteractiveSegment[] = [
		{ id: "permissions", text: permissionSegment(data) },
		{ id: "effort", text: effortSegment(data) },
	];
	const tierProfile = tierProfileSegment(data);
	const profileSegments = [...baseSegments, ...(tierProfile ? [{ id: "tier-profile", text: tierProfile }] : [])];
	const fastMode = fastModeSegment(data);
	const allSegments = [...profileSegments, ...(fastMode ? [{ id: "fast-mode", text: fastMode }] : [])];
	const chosenSegments = mode !== "narrow" && rowFits(segmentTexts(allSegments, divider), row2Right, width)
		? allSegments
		: mode !== "narrow" && rowFits(segmentTexts(profileSegments, divider), row2Right, width) ? profileSegments : baseSegments;
	const visibleSettings = fitLeftInteractiveSegments(chosenSegments, row2Right, width, divider);
	const row2Left = segmentTexts(visibleSettings.map((segment) => ({ ...segment, text: decorateInteractiveSegment(segment, data) })), divider);
	const row2 = buildRow(row2Left, row2Right, width);
	const lines = ["", row1, data.theme.fg("dim", "─".repeat(width)), row2];
	const interactiveRows: string[][] = width >= 5 ? [["work-mode"]] : [];
	if (visibleSettings.length > 0) interactiveRows.push(visibleSettings.map((segment) => segment.id));
	if (data.serviceStatuses?.length) {
		const services = data.serviceStatuses.map((status, index): ServiceStatusSegment => typeof status === "string" ? { id: `service:${index}`, text: status } : status);
		const visibleServices = fitServiceSegments(services, width, divider);
		lines.push(buildRow([visibleServices.map((service) => decorateInteractiveSegment(service, data)).join(` ${divider} `)], [], width));
		interactiveRows.push(visibleServices.map((service) => service.id));
	}
	if (data.subagents) {
		for (const agent of data.subagents.agents.filter((candidate) => !candidate.workflow)) {
			const lifecycle = agent.state === "launching" ? "starting" : agent.state === "stopping" ? "stopping" : "running";
			const tone = lifecycle === "starting" ? "muted" : lifecycle === "stopping" ? "warning" : "accent";
			const now = data.now ?? Date.now();
			const icon = data.theme.fg(tone, currentSubagentIndicator(lifecycle, now));
			lines.push(buildRow([`${icon} ${renderSubagentFooterProjection(agent, data.theme, now)}`], [], width));
		}
		if (data.subagents.overflow > 0) lines.push(buildRow([data.theme.fg("dim", `… +${data.subagents.overflow} more subagent${data.subagents.overflow === 1 ? "" : "s"}`)], [], width));
	}
	return { lines, interactiveRows };
}

export function renderStatusBar(width: number, data: StatusRenderData): string[] {
	return renderStatusBarLayout(width, data).lines;
}
