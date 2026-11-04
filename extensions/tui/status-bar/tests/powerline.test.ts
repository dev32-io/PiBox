import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeStatusBarConfig } from "../config.js";
import { renderStatusBar, renderStatusBarLayout, type StatusRenderData } from "../layout.js";
import * as icons from "../../icons.js";

// Rattle's colors, so expected escapes are the real footer's.
const COLORS: Record<string, [number, number, number]> = {
	accent: [98, 184, 214], border: [71, 139, 199], borderMuted: [83, 101, 112], success: [79, 183, 167], warning: [214, 164, 95],
	error: [223, 107, 115], muted: [145, 163, 174], dim: [113, 136, 148], text: [220, 231, 236], thinkingHigh: [109, 143, 232],
};
const fgOf = (token: string) => `\x1b[38;2;${COLORS[token]!.join(";")}m`;
const bgOf = (token: string) => `\x1b[48;2;${COLORS[token]!.join(";")}m`;
const theme = {
	getFgAnsi: (token: string) => fgOf(token),
	fg: (token: string, value: string) => `${fgOf(token)}${value}\x1b[39m`,
	bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
} as unknown as Theme;

const SERVICE = { fg: "\x1b[38;2;30;44;53m", bg: "\x1b[48;2;30;44;53m" }; // #1E2C35
const SETTING = { fg: "\x1b[38;2;38;54;63m", bg: "\x1b[48;2;38;54;63m" }; // #26363F
const DARK = "\x1b[38;2;11;17;22m";
const RESET = "\x1b[0m";
const [CAP, END, BACK] = ["\u{e0b6}", "\u{e0b4}", "\u{e0b2}"];
const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

function context(percent: number | null, contextWindow = 1_000_000): ExtensionContext {
	return {
		cwd: "/Users/test/Development/PiBox",
		model: { id: "m", name: "Test Model", provider: "local", contextWindow, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
		getContextUsage: () => ({ tokens: 0, contextWindow, percent }),
		sessionManager: { getSessionName: () => "visual pass" },
	} as unknown as ExtensionContext;
}

const data: StatusRenderData = {
	ctx: context(11.5),
	theme,
	thinkingLevel: "high",
	permissionMode: "enforce",
	metrics: { input: 152, output: 28_000, cacheRead: 4_700_000, cacheWrite: 0, cacheHitPercent: 92.2, cost: 3.37, durationMs: 0 },
	git: { insideWorkTree: true, branch: "develop", staged: 0, modified: 0, untracked: 2, ahead: 0, behind: 0 },
	config: normalizeStatusBarConfig(),
	tierProfile: { profile: "claude" },
	fastMode: { mainAvailable: true, mainEnabled: false, subagents: "low" },
};

test("new glyphs are the approved code points", () => {
	assert.deepEqual(
		[icons.ICON_POWERLINE_END, icons.ICON_POWERLINE_BACK, icons.ICON_PERMISSIONS, icons.ICON_EFFORT, icons.ICON_TIER, icons.ICON_FAST, icons.ICON_TOKENS].map((glyph) => glyph.codePointAt(0)),
		[0xe0b4, 0xe0b2, 0xf132, 0xf0eb, 0xf1de, 0xf0e7, 0xf0ec],
	);
	assert.deepEqual(
		[icons.ICON_SERVICE_DATABASE, icons.ICON_SERVICE_SEARCH, icons.ICON_SERVICE_VIEW, icons.ICON_SERVICE_SERVER].map((glyph) => glyph.codePointAt(0)),
		[0xf1c0, 0xf002, 0xf06e, 0xf233],
	);
});

test("settings render as pills in normal, alarm, and selected states", () => {
	const row = (overrides: Partial<StatusRenderData> = {}) => renderStatusBar(200, { ...data, ...overrides })[3]!;
	const effort = `${SETTING.fg}${CAP}${SETTING.bg}${fgOf("dim")}\u{f0eb} Effort ${fgOf("success")}Medium${RESET}${SETTING.fg}${END}${RESET}`;
	assert.ok(row({ thinkingLevel: "medium" }).includes(effort), "normal: dark pill, dim icon+label, semantic value");
	const enforced = `${SETTING.fg}${CAP}${SETTING.bg}${fgOf("dim")}\u{f132} Permissions ${fgOf("success")}Enforced${RESET}${SETTING.fg}${END}${RESET}`;
	assert.ok(row().includes(enforced));
	const alarm = `${fgOf("warning")}${CAP}${bgOf("warning")}${DARK}\u{f132} Permissions \x1b[1mBypass${RESET}${fgOf("warning")}${END}${RESET}`;
	assert.ok(row({ permissionMode: "bypass" }).includes(alarm), "alarm: amber pill, dark bold text");
	const selected = `${fgOf("accent")}${CAP}${bgOf("accent")}${DARK}\u{f0eb} Effort \x1b[1mHigh${RESET}${fgOf("accent")}${END}${RESET}`;
	assert.ok(row({ selectedInteractiveId: "effort" }).includes(selected), "selected: accent pill, bold value");
	assert.ok(!row({ selectedInteractiveId: "effort" }).includes("›"));
	const unselectedAlarm = row({ permissionMode: "bypass", selectedInteractiveId: "effort" });
	assert.ok(unselectedAlarm.includes(alarm), "alarm stays amber while another pill is selected");
	assert.ok(row({ permissionMode: "bypass", selectedInteractiveId: "permissions" }).includes(`${fgOf("accent")}${CAP}${bgOf("accent")}${DARK}\u{f132} Permissions \x1b[1mBypass`), "selection wins over alarm");
	assert.match(strip(row()), /^ \u{e0b6}\u{f132} Permissions Enforced\u{e0b4} \u{e0b6}\u{f0eb} Effort High\u{e0b4} \u{e0b6}\u{f1de} Tier Claude\u{e0b4} \u{e0b6}\u{f0e7} Fast Sub≤Low\u{e0b4} /u);
});

test("moving the selection never changes which items fit", () => {
	const ids = ["work-mode", "permissions", "effort", "tier-profile", "fast-mode"];
	for (let width = 30; width <= 200; width++) {
		const baseline = renderStatusBarLayout(width, data);
		const baselineRow = strip(baseline.lines[3]!);
		for (const id of ids) {
			const layout = renderStatusBarLayout(width, { ...data, selectedInteractiveId: id });
			assert.deepEqual(layout.interactiveRows, baseline.interactiveRows, `${id} @${width}`);
			assert.equal(strip(layout.lines[3]!), baselineRow, `${id} @${width}`);
		}
	}
});

test("context gauge fills left to right with usage-colored cells and a matching rounded end", () => {
	const track = (chars: string) => `${SETTING.bg}${fgOf("muted")}${chars}`;
	const filled = (token: string, chars: string) => `${bgOf(token)}${DARK}${chars}`;
	const gauge = (percent: number, label: string, token: string) => {
		const body = ` ${label} / 1.0M `.padEnd(18);
		const count = Math.round((percent / 100) * 18);
		const cells = (count > 0 ? filled(token, body.slice(0, count)) : "") + (count < 18 ? track(body.slice(count)) : "");
		return `${cells}${RESET}${count >= 18 ? fgOf(token) : SETTING.fg}${END}${RESET}`;
	};
	for (const [percent, label, token] of [[0, "0.0%", "accent"], [11.5, "11.5%", "accent"], [50, "50.0%", "accent"], [70, "70.0%", "warning"], [90, "90.0%", "error"], [100, "100.0%", "error"]] as const) {
		const row = renderStatusBar(200, { ...data, ctx: context(percent) })[1]!;
		assert.ok(row.includes(gauge(percent, label, token)), `${percent}%: ${JSON.stringify(row)}`);
	}
	// Spot-check the literal sequence for 11.5%: two filled cells, 16 track cells, track-colored end.
	const row = renderStatusBar(200, { ...data, ctx: context(11.5) })[1]!;
	assert.ok(row.includes(`${bgOf("accent")}${DARK} 1${SETTING.bg}${fgOf("muted")}1.5% / 1.0M ${" ".repeat(4)}${RESET}${SETTING.fg}${END}${RESET}`));
	assert.ok(row.includes(`${bgOf("accent")}${DARK} 1`), "square left edge: the body starts without a cap glyph");
});

test("context gauge handles unknown usage and the minimum body width", () => {
	const unknown = renderStatusBar(200, { ...data, ctx: context(null) })[1]!;
	assert.ok(unknown.includes(`${SETTING.bg}${fgOf("muted")}${" — / 1.0M ".padEnd(18)}${RESET}${SETTING.fg}${END}${RESET}`), JSON.stringify(unknown));
	// Narrow: configured minimum is 8, but the text needs 14 columns.
	const narrow = strip(renderStatusBar(60, data)[1]!);
	assert.match(narrow, / 11\.5% \/ 1\.0M \u{e0b4} ?$/u);
	// Medium minimum (10) is also exceeded by the text; wide pads to 18.
	assert.match(strip(renderStatusBar(200, data)[1]!), / 11\.5% \/ 1\.0M     \u{e0b4} ?$/u);
});

test("session stats render as a back-chain with arrows in the next block's color", () => {
	const row = renderStatusBar(200, data)[3]!;
	const block1 = `${SERVICE.fg}\x1b[49m${BACK}${SERVICE.bg} ${fgOf("muted")}\u{f0ec} 4.7M ${fgOf("dim")}~92%`;
	const block2 = `${SETTING.fg}${SERVICE.bg}${BACK}${SETTING.bg} ${fgOf("dim")}↑${fgOf("muted")}152 ${fgOf("dim")}↓${fgOf("muted")}28k`;
	const block3 = `${fgOf("borderMuted")}${SETTING.bg}${BACK}${bgOf("borderMuted")} ${fgOf("text")}$3.37`;
	assert.ok(row.includes(block1 + block2 + block3 + `${RESET}${fgOf("borderMuted")}${END}${RESET}`), JSON.stringify(row));
	assert.match(strip(row), /\u{e0b2} \u{f0ec} 4\.7M ~92%\u{e0b2} ↑152 ↓28k\u{e0b2} \$3\.37\u{e0b4} $/u);
	const noCost = renderStatusBar(200, { ...data, ctx: { ...data.ctx, model: { ...data.ctx.model!, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } as ExtensionContext, metrics: { input: 152, output: 28_000, cacheRead: 4_700_000, cacheWrite: 0, cacheHitPercent: 92.2, durationMs: 0 } })[3]!;
	assert.ok(noCost.includes(block1 + block2 + `${RESET}${SETTING.fg}${END}${RESET}`), "without cost the chain ends on the tokens-out block");
	assert.doesNotMatch(strip(noCost), /\$/);
});

test("services render as dark pills with state glyphs, icons by id, and accent when selected", () => {
	const services = ["● Mem0", "● SearXNG", "○ Visual companion", "◌ Other thing"];
	const lines = renderStatusBar(200, { ...data, serviceStatuses: services });
	assert.equal(lines.length, 5);
	assert.match(strip(lines[4]!), /^ \u{e0b6}\u{f1c0} Mem0 ●\u{e0b4} \u{e0b6}\u{f002} SearXNG ●\u{e0b4} \u{e0b6}\u{f06e} Visual companion ○\u{e0b4} \u{e0b6}\u{f233} Other thing ◌\u{e0b4} +$/u);
	assert.ok(lines[4]!.includes(`${SERVICE.fg}${CAP}${SERVICE.bg}${fgOf("muted")}\u{f1c0} Mem0 ${fgOf("success")}●${RESET}${SERVICE.fg}${END}${RESET}`));
	assert.ok(lines[4]!.includes(`${fgOf("muted")}\u{f06e} Visual companion ${fgOf("dim")}○${RESET}`));
	const selected = renderStatusBar(200, { ...data, serviceStatuses: [{ id: "service:searxng", text: `${fgOf("success")}●\x1b[39m ${fgOf("dim")}SearXNG\x1b[39m` }], selectedInteractiveId: "service:searxng" })[4]!;
	assert.ok(selected.includes(`${fgOf("accent")}${CAP}${bgOf("accent")}${DARK}\u{f002} SearXNG ●${RESET}${fgOf("accent")}${END}${RESET}`), "themed status text is parsed and the pill is accent when selected");
	const layout = renderStatusBarLayout(200, { ...data, serviceStatuses: [{ id: "service:mem0", text: "● Mem0" }, { id: "service:searxng", text: "● SearXNG" }] });
	assert.deepEqual(layout.interactiveRows.at(-1), ["service:mem0", "service:searxng"]);
});

test("pill layouts stay inside every width and keep targets stable under selection", () => {
	const services = [{ id: "service:mem0", text: "● Mem0" }, { id: "service:searxng", text: "● SearXNG" }, { id: "service:visual-companion", text: "○ Visual companion" }];
	for (const width of [40, 60, 90, 112, 140, 200]) {
		for (const selectedInteractiveId of [undefined, "work-mode", "permissions", "effort", "tier-profile", "fast-mode", "service:mem0"]) {
			for (const permissionMode of ["enforce", "bypass"] as const) {
				const layout = renderStatusBarLayout(width, { ...data, permissionMode, serviceStatuses: services, ...(selectedInteractiveId ? { selectedInteractiveId } : {}) });
				assert.equal(layout.lines.length, 5);
				for (const line of layout.lines) assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} ${JSON.stringify(strip(line))}`);
			}
		}
	}
});

test("narrow pill layouts drop Fast, then Tier, then the stats, then Effort", () => {
	const at = (width: number) => {
		const layout = renderStatusBarLayout(width, data);
		return { settings: layout.interactiveRows[1] ?? [], stats: strip(layout.lines[3]!).includes("\u{e0b2}") };
	};
	assert.deepEqual(at(200), { settings: ["permissions", "effort", "tier-profile", "fast-mode"], stats: true });
	assert.deepEqual(at(94), { settings: ["permissions", "effort", "tier-profile"], stats: true });
	assert.deepEqual(at(77), { settings: ["permissions", "effort"], stats: true });
	assert.deepEqual(at(61), { settings: ["permissions", "effort"], stats: false });
	assert.deepEqual(at(40), { settings: ["permissions"], stats: false });
});

test("hosts without ANSI theme access keep the plain layout", () => {
	const plain = { fg: (_token: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
	const lines = renderStatusBar(160, { ...data, theme: plain, serviceStatuses: ["● Mem0"] });
	assert.ok(!/[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}]/u.test(lines[3]! + lines[4]!.replace(/\u{f0000}/u, "")), "no powerline glyphs outside the header");
	assert.match(lines[3]!, /◆ Permissions: Enforced │ Effort: High │ Tier: Claude │ Fast: Sub≤Low/);
	assert.match(lines[3]!, /T: 4\.7M \(4\.7M cached ~92%\) ↑ 152 ↓ 28k │ \$3\.37/);
	assert.match(lines[4]!, /^ ● Mem0 +$/);
});
