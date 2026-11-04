import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "./config.js";
import type { GitSnapshot } from "./git.js";
import type { SessionMetrics } from "./metrics.js";
import { permissionModeDisplay, renderPermissionMode } from "../../permissions/display.js";
import {
	ICON_EFFORT, ICON_FAST, ICON_FOLDER, ICON_PERMISSIONS, ICON_POWERLINE_ARROW, ICON_POWERLINE_BACK, ICON_POWERLINE_BRANCH, ICON_POWERLINE_CAP,
	ICON_POWERLINE_END, ICON_SERVICE_DATABASE, ICON_SERVICE_SEARCH, ICON_SERVICE_SERVER, ICON_SERVICE_VIEW, ICON_TIER, ICON_TOKENS,
} from "../icons.js";
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
	if (hasAnsiTheme(data.theme)) {
		const percent = usage && usage.percent !== null ? Math.max(0, usage.percent) : undefined;
		return gaugePill(percent, formatTokens(contextWindow), gaugeWidth, data);
	}
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

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface Shade {
	fg: string;
	bg: string;
}

/** Theme-token color usable as foreground or background. */
function tokenShade(theme: Theme, token: ThemeColor): Shade {
	const fg = theme.getFgAnsi(token);
	return { fg, bg: backgroundOf(fg) };
}

/**
 * Fixed dark pill shades (rattle's slate family, like the header's dark/light
 * text): no theme token is dark enough to sit under light text as a pill body.
 */
function fixedShade(red: number, green: number, blue: number): Shade {
	return { fg: `\x1b[38;2;${red};${green};${blue}m`, bg: `\x1b[48;2;${red};${green};${blue}m` };
}

const SHADE_SERVICE = fixedShade(30, 44, 53); // #1E2C35
const SHADE_SETTING = fixedShade(38, 54, 63); // #26363F, also the gauge track

/** Rounded pill: cap, body on `shade`, end cap. The body brings its own foreground. */
function pill(shade: Shade, body: string): string {
	return `${shade.fg}${ICON_POWERLINE_CAP}${shade.bg}${body}${RESET}${shade.fg}${ICON_POWERLINE_END}${RESET}`;
}

/**
 * Context gauge: a pill whose background fills left to right with usage. The
 * left edge is square; filled cells use the accent (amber/red past the
 * thresholds) with dark text, the rest a dark track with muted text.
 */
function gaugePill(percent: number | undefined, windowText: string, minWidth: number, data: StatusRenderData): string {
	const { theme, config } = data;
	const label = percent === undefined ? "—" : `${percent.toFixed(1)}%`;
	const cells = [...` ${label} / ${windowText} `];
	while (cells.length < minWidth) cells.push(" ");
	const clamped = Math.min(100, percent ?? 0);
	const filled = Math.round((clamped / 100) * cells.length);
	const fill = tokenShade(theme, clamped >= config.errorPercent ? "error" : clamped >= config.warningPercent ? "warning" : "accent");
	const track = SHADE_SETTING;
	const body = (filled > 0 ? `${fill.bg}${DARK_TEXT}${cells.slice(0, filled).join("")}` : "")
		+ (filled < cells.length ? `${track.bg}${theme.getFgAnsi("muted")}${cells.slice(filled).join("")}` : "");
	return `${body}${RESET}${(filled >= cells.length ? fill : track).fg}${ICON_POWERLINE_END}${RESET}`;
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

function capitalize(value: string): string {
	return value ? `${value[0]!.toUpperCase()}${value.slice(1).toLowerCase()}` : value;
}

/** What a settings or service pill shows; `plain` is the text fallback for hosts without ANSI theme access. */
interface PillSpec {
	kind: "setting" | "service";
	icon: string;
	label: string;
	value?: string;
	valueToken: ThemeColor;
	/** Alarm settings (permission Bypass) keep a warning-colored pill even when unselected. */
	alarm?: boolean;
}

interface InteractiveSegment {
	id: string;
	plain: string;
	pill: PillSpec;
}

function renderPill(spec: PillSpec, selected: boolean, theme: Theme): string {
	if (selected || spec.alarm) {
		const value = spec.value ? ` ${spec.kind === "setting" ? BOLD : ""}${spec.value}` : "";
		return pill(tokenShade(theme, selected ? "accent" : "warning"), `${DARK_TEXT}${spec.icon} ${spec.label}${value}`);
	}
	const service = spec.kind === "service";
	const value = spec.value ? ` ${theme.getFgAnsi(spec.valueToken)}${spec.value}` : "";
	return pill(service ? SHADE_SERVICE : SHADE_SETTING, `${theme.getFgAnsi(service ? "muted" : "dim")}${spec.icon} ${spec.label}${value}`);
}

function interactiveText(segment: InteractiveSegment, data: StatusRenderData, selected: boolean): string {
	if (hasAnsiTheme(data.theme)) return renderPill(segment.pill, selected, data.theme);
	return selected ? `${data.theme.fg("accent", "›")} ${segment.plain}` : segment.plain;
}

function settingSegment(id: string, pillSpec: Omit<PillSpec, "kind">, plain: string): InteractiveSegment {
	return { id, plain, pill: { kind: "setting", ...pillSpec } };
}

function labeledPlain(label: string, value: string, token: ThemeColor, theme: Theme): string {
	return `${theme.fg("dim", `${label}:`)} ${theme.fg(token, value)}`;
}

function permissionSegment(data: StatusRenderData): InteractiveSegment {
	const { value, token } = permissionModeDisplay(data.permissionMode);
	return settingSegment("permissions", { icon: ICON_PERMISSIONS, label: "Permissions", value, valueToken: token, alarm: data.permissionMode === "bypass" }, renderPermissionMode(data.permissionMode, data.theme));
}

function effortSegment(data: StatusRenderData): InteractiveSegment {
	const level = data.thinkingLevel || "off";
	const labels: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
	const colors: Record<string, "dim" | "muted" | "warning" | "success" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax"> = {
		off: "dim", minimal: "muted", low: "warning", medium: "success", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
	};
	const value = labels[level] ?? capitalize(level);
	const token = colors[level] ?? "muted";
	return settingSegment("effort", { icon: ICON_EFFORT, label: "Effort", value, valueToken: token }, labeledPlain("Effort", value, token, data.theme));
}

function tierProfileSegment(data: StatusRenderData): InteractiveSegment | undefined {
	if (!data.tierProfile) return undefined;
	const value = capitalize(data.tierProfile.profile);
	return settingSegment("tier-profile", { icon: ICON_TIER, label: "Tier", value, valueToken: "muted" }, labeledPlain("Tier", value, "muted", data.theme));
}

function fastModeSegment(data: StatusRenderData): InteractiveSegment | undefined {
	const status = data.fastMode;
	if (!status) return undefined;
	const scopes: string[] = [];
	if (status.mainEnabled) scopes.push("Main");
	if (status.subagents !== "off") {
		const labels = { low: "Low", medium: "Med", high: "High", max: "Max" } as const;
		scopes.push(`Sub≤${labels[status.subagents]}`);
	}
	if (scopes.length === 0 && !status.mainAvailable) return undefined;
	const value = scopes.length > 0 ? scopes.join("+") : "Off";
	const token = scopes.length > 0 ? "warning" : "dim";
	return settingSegment("fast-mode", { icon: ICON_FAST, label: "Fast", value, valueToken: token }, labeledPlain("Fast", value, token, data.theme));
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

/**
 * Session stats as a back-chain: blocks joined by left-pointing arrows, each
 * arrow in the next block's color on the previous block's background, ending in
 * a rounded cap. Darker blocks first; the cost block is the lighter slate.
 */
function statsChain(data: StatusRenderData): string {
	const { metrics, theme } = data;
	const [dim, muted] = [theme.getFgAnsi("dim"), theme.getFgAnsi("muted")];
	const cached = metrics.cacheRead + metrics.cacheWrite;
	const cacheRate = metrics.cacheHitPercent === undefined ? "" : ` ${dim}~${Math.round(metrics.cacheHitPercent)}%`;
	const cost = costSegment(data) ? `$${(metrics.cost ?? 0).toFixed(2)}` : "";
	const blocks: Array<{ shade: Shade; text: string }> = [
		{ shade: SHADE_SERVICE, text: `${muted}${ICON_TOKENS} ${formatTokens(metrics.input + metrics.output + cached)}${cacheRate}` },
		{ shade: SHADE_SETTING, text: `${dim}↑${muted}${formatTokens(metrics.input)} ${dim}↓${muted}${formatTokens(metrics.output)}` },
		...(cost ? [{ shade: tokenShade(theme, "borderMuted"), text: `${theme.getFgAnsi("text")}${cost}` }] : []),
	];
	return blocks.map(({ shade, text }, index) => `${shade.fg}${index === 0 ? RESET_BG : blocks[index - 1]!.shade.bg}${ICON_POWERLINE_BACK}${shade.bg} ${text}`).join("")
		+ `${RESET}${blocks.at(-1)!.shade.fg}${ICON_POWERLINE_END}${RESET}`;
}

/** Row parts for a left-aligned group: pills sit one space apart, plain segments keep │ dividers. */
function interactiveParts(segments: InteractiveSegment[], data: StatusRenderData, selectedId?: string): string[] {
	const texts = segments.map((segment) => interactiveText(segment, data, segment.id === selectedId));
	if (hasAnsiTheme(data.theme)) return texts;
	const divider = separator(data.theme);
	return texts.flatMap((text, index) => index === 0 ? [text] : [divider, text]);
}

/**
 * Greedy prefix that fits `available` columns. Pills measure their real width
 * (identical selected or not); the plain layout also reserves the two-column
 * selection marker so entering footer mode never hides the selected element.
 */
function fitInteractiveSegments(segments: InteractiveSegment[], available: number, data: StatusRenderData): InteractiveSegment[] {
	const pills = hasAnsiTheme(data.theme);
	const gap = pills ? 1 : visibleWidth(` ${separator(data.theme)} `);
	const fitted: InteractiveSegment[] = [];
	let used = 0;
	for (const segment of segments) {
		const extra = (fitted.length > 0 ? gap : 0) + visibleWidth(interactiveText(segment, data, false)) + (pills ? 0 : 2);
		if (used + extra > available) break;
		fitted.push(segment);
		used += extra;
	}
	return fitted;
}

function fitLeftInteractiveSegments(segments: InteractiveSegment[], rightParts: string[], width: number, data: StatusRenderData): InteractiveSegment[] {
	const contentWidth = Math.max(0, width - 2);
	const right = rightParts.filter(Boolean).join(" ");
	if (visibleWidth(right) >= contentWidth) return [];
	return fitInteractiveSegments(segments, Math.max(0, contentWidth - visibleWidth(right) - (right ? 1 : 0)), data);
}

function fitServiceSegments(services: InteractiveSegment[], width: number, data: StatusRenderData): InteractiveSegment[] {
	const fitted = fitInteractiveSegments(services, Math.max(0, width - 2), data);
	// Keep the first service reachable when even one full segment cannot fit;
	// buildRow will safely truncate that one visible segment.
	return fitted.length > 0 ? fitted : services.slice(0, 1);
}

const SERVICE_ICONS: Array<[RegExp, string]> = [[/mem0/i, ICON_SERVICE_DATABASE], [/searx/i, ICON_SERVICE_SEARCH], [/visual/i, ICON_SERVICE_VIEW]];
const SERVICE_STATES: Record<string, ThemeColor> = { "●": "success", "○": "dim", "◌": "warning", "!": "error" };

/** Adapt a service status ("● Mem0", possibly themed) into a pill: the leading state glyph becomes the value. */
function serviceSegment(service: ServiceStatusSegment): InteractiveSegment {
	const text = service.text.replace(/\x1b\[[0-9;]*m/g, "");
	const state = /^([●○◌!]) (.*)$/.exec(text);
	const label = state ? state[2]! : text;
	const icon = SERVICE_ICONS.find(([pattern]) => pattern.test(`${service.id} ${label}`))?.[1] ?? ICON_SERVICE_SERVER;
	return { id: service.id, plain: service.text, pill: { kind: "service", icon, label, ...(state ? { value: state[1]! } : {}), valueToken: state ? SERVICE_STATES[state[1]!]! : "muted" } };
}

export function renderStatusBarLayout(width: number, data: StatusRenderData): StatusBarLayout {
	if (width <= 0) return { lines: [], interactiveRows: [] };
	const mode = layoutMode(width, data.config);
	const divider = separator(data.theme);
	const pills = hasAnsiTheme(data.theme);
	const piMark = workModeMark(data);
	const model = modelSegment(data);
	const row1LeftCandidates = pills
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
	let row2Right = pills ? [statsChain(data)] : [tokenSegment(data), ...(costSegment(data) ? [divider, costSegment(data)] : [])];
	const baseSegments: InteractiveSegment[] = [permissionSegment(data), effortSegment(data)];
	const tierProfile = tierProfileSegment(data);
	const profileSegments = [...baseSegments, ...(tierProfile ? [tierProfile] : [])];
	const fastMode = fastModeSegment(data);
	const allSegments = [...profileSegments, ...(fastMode ? [fastMode] : [])];
	const fitSettings = (right: string[]) => {
		const chosen = mode !== "narrow" && rowFits(interactiveParts(allSegments, data), right, width)
			? allSegments
			: mode !== "narrow" && rowFits(interactiveParts(profileSegments, data), right, width) ? profileSegments : baseSegments;
		return fitLeftInteractiveSegments(chosen, right, width, data);
	};
	let visibleSettings = fitSettings(row2Right);
	// Pill layout: settings are interactive, so stats yield when Permissions and Effort do not both fit beside them.
	if (pills && visibleSettings.length < baseSegments.length) {
		row2Right = [];
		visibleSettings = fitSettings(row2Right);
	}
	const row2 = buildRow(interactiveParts(visibleSettings, data, data.selectedInteractiveId), row2Right, width);
	const lines = ["", row1, data.theme.fg("dim", "─".repeat(width)), row2];
	const interactiveRows: string[][] = width >= 5 ? [["work-mode"]] : [];
	if (visibleSettings.length > 0) interactiveRows.push(visibleSettings.map((segment) => segment.id));
	if (data.serviceStatuses?.length) {
		const services = data.serviceStatuses.map((status, index) => serviceSegment(typeof status === "string" ? { id: `service:${index}`, text: status } : status));
		const visibleServices = fitServiceSegments(services, width, data);
		const parts = interactiveParts(visibleServices, data, data.selectedInteractiveId);
		lines.push(buildRow([parts.join(" ")], [], width));
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
