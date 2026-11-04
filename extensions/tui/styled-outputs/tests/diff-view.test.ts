import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateDiffString, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DiffView, diffStatus, SPLIT_VIEW_MIN_WIDTH, wordDiff, type DiffViewOptions } from "../components/diff-view.js";
import { renderToolResult } from "../components/tool-renderers.js";

initTheme("dark", false);

const rattle = JSON.parse(readFileSync("themes/rattle.json", "utf8")) as { vars: Record<string, string>; colors: Record<string, string> };
const hex = (token: string) => rattle.vars[rattle.colors[token]!] ?? rattle.colors[token]!;
const rgb = (token: string) => [1, 3, 5].map((index) => Number.parseInt(hex(token).slice(index, index + 2), 16)).join(";");
const theme = {
	fg: (token: string, value: string) => `\x1b[38;2;${rgb(token)}m${value}\x1b[39m`,
	bg: (token: string, value: string) => `\x1b[48;2;${rgb(token)}m${value}\x1b[49m`,
	bold: (value: string) => value,
} as unknown as Theme;
// A 256-color host: no RGB to brighten, so emphasis falls back to reverse video.
const indexed = {
	fg: (_token: string, value: string) => `\x1b[38;5;7m${value}\x1b[39m`,
	bg: (token: string, value: string) => `\x1b[48;5;${token === "toolSuccessBg" ? 22 : 52}m${value}\x1b[49m`,
	bold: (value: string) => value,
} as unknown as Theme;
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const TINTS = new Set([`48;2;${rgb("toolSuccessBg")}`, `48;2;${rgb("toolErrorBg")}`, "48;5;22", "48;5;52"]);
const SGR = /(\x1b\[[0-9;]*m)/;
const view = (diff: string, width: number, options: Partial<DiffViewOptions> = {}, language: string | undefined = "typescript", host = theme) =>
	new DiffView(diff, language, host, { expanded: true, limit: 10, toggle: "ctrl+o", hintColor: "dim", ...options }).render(width);

/** Visible text drawn on an emphasis background (anything but the row tint) or in reverse video, per row. */
function emphasized(line: string): string {
	let bg = "";
	let inverse = false;
	let output = "";
	for (const part of line.split(SGR)) {
		const code = part.match(/^\x1b\[([0-9;]*)m$/)?.[1];
		if (code === undefined) { if ((bg && !TINTS.has(bg)) || inverse) output += part; continue; }
		if (code === "" || code === "0") { bg = ""; inverse = false; } else if (code === "49") bg = ""; else if (code.startsWith("48;")) bg = code;
		else if (code === "7") inverse = true; else if (code === "27") inverse = false;
	}
	return output;
}

function lines(count: number, make = (index: number) => `const value${index} = compute(${index});`): string[] {
	return Array.from({ length: count }, (_, index) => make(index + 1));
}

/** Three far-apart hunks: a two-line modification, one line replaced by three, and a single-line change. */
function multiHunk(): string {
	const before = lines(60);
	const after = [...before];
	after[19] = "const value20 = compute(20, true);";
	after[20] = "const value21 = compute(21, true);";
	after.splice(35, 1, "export function renamed(x: number): number {", "\treturn x * 2;", "}");
	after[54] = "const value53 = recompute(53);";
	return generateDiffString(before.join("\n"), after.join("\n")).diff;
}

test("status line shows proportional bar and pluralized hunks", () => {
	const status = (diff: string) => diffStatus(diff, "typescript", theme);
	const cells = (item: string, token: string) => item.match(new RegExp(`\\x1b\\[38;2;${rgb(token)}m(━*)`))?.[1]?.length ?? 0;
	const [counts, hunks] = status("-1 a\n+1 b\n+2 c\n+3 d");
	assert.equal(stripTerminalSequences(counts!), "+3 −1 ▕━━━━━━━━━━▏");
	assert.equal([cells(counts!, "success"), cells(counts!, "error")].join("/"), "8/2");
	assert.equal(stripTerminalSequences(hunks!), "1 hunk");
	assert.equal(stripTerminalSequences(status(multiHunk())[1]!), "3 hunks");
	const lopsided = status(`+1 a\n${lines(99, (index) => `-${index} x`).join("\n")}`)[0]!;
	assert.equal([cells(lopsided, "success"), cells(lopsided, "error")].join("/"), "1/9", "a nonzero side keeps one cell");
	assert.ok(stripTerminalSequences(lopsided).includes("▕") && lopsided.includes(`\x1b[38;2;${rgb("dim")}m▕`), "dim brackets");
});

test("no-change and create diffs keep sensible status rows", () => {
	assert.deepEqual(diffStatus(" 1 a\n 2 b", "typescript", theme), []);
	const unchanged = renderToolResult("edit", { content: [], details: { diff: " 1 a" } }, { expanded: true }, theme, { args: { path: "/r/a.ts" }, isError: false, state: {}, durationMs: 300 });
	assert.equal(plain(unchanged.render(100))[0], "└─ Done • 0.3s");
	const diff = generateDiffString("", "const a = 1;\nconst b = 2;\n").diff;
	const result = { content: [{ type: "text", text: "ok" }], details: { piboxWrite: { action: "create", diff } } };
	const rows = plain(renderToolResult("write", result, { expanded: true }, theme, { args: { path: "/r/a.ts" }, isError: false, state: {} }).render(100));
	assert.deepEqual(rows, ["└─ Done • +2 −0 ▕━━━━━━━━━━▏ • 1 hunk", "   + 1 const a = 1;", "   + 2 const b = 2;"]);
	const counts = diffStatus(diff, "typescript", theme)[0]!;
	assert.ok(counts.includes(`\x1b[38;2;${rgb("success")}m${"━".repeat(10)}`), "all additions fill the bar");
});

test("multi-line modifications emphasize only the changed words on both sides", () => {
	const diff = [" 1 const a = 1;", "-2 const name = \"alpha\";", "-3 const size = 10;", "+2 const name = \"beta\";", "+3 const size = 20;", " 4 const b = 2;"].join("\n");
	for (const language of ["typescript", undefined]) {
		const rows = view(diff, 100, {}, language);
		assert.deepEqual(rows.map(emphasized), ["", "alpha", "10", "beta", "20", ""], String(language));
		assert.doesNotMatch(rows.join(""), /\x1b\[7m/, "truecolor emphasis uses a brighter background, not reverse video");
	}
	assert.deepEqual(view(diff, 100, {}, "typescript", indexed).map(emphasized), ["", "alpha", "10", "beta", "20", ""], "256-color hosts fall back to reverse video");
});

test("dissimilar pairs and very long lines get no word emphasis", () => {
	assert.equal(wordDiff("const name = \"alpha\";", "return compute(other, list);"), undefined);
	assert.ok(wordDiff("const name = \"alpha\";", "const name = \"beta\";"));
	const long = "x".repeat(520);
	assert.equal(wordDiff(`${long} a`, `${long} b`), undefined);
	const rows = view(["-1 const name = \"alpha\";", "+1 return compute(other, list);"].join("\n"), 100);
	assert.deepEqual(rows.map(emphasized), ["", ""]);
});

test("unequal runs pair lines by similarity; unpaired lines get no emphasis", () => {
	const diff = ["-2 const size = 10;", "+2 // a brand new comment here", "+3 const size = 20;"].join("\n");
	assert.deepEqual(view(diff, 100).map(emphasized), ["10", "", "20"]);
});

test("unchanged gaps fold into dim rows aligned with the code column", () => {
	const rows = plain(view(multiHunk(), 100));
	const folds = rows.filter((row) => row.includes("unchanged"));
	assert.deepEqual(folds.map((row) => row.trim()), ["… 15 unchanged lines …", "… 6 unchanged lines …", "… 8 unchanged lines …"]);
	const code = rows.find((row) => row.includes("const value16 "))!.indexOf("const");
	for (const fold of folds) assert.equal(fold.indexOf("…"), code, fold);
	assert.equal(plain(view(generateDiffString(lines(6).join("\n"), lines(6).map((line, index) => index === 5 ? "x" : line).join("\n")).diff, 100)).find((row) => row.includes("unchanged"))?.trim(), "… 1 unchanged line …");
});

test("collapsed previews end with a pluralized footer using the expand key", () => {
	const diff = multiHunk();
	const footer = (options: Partial<DiffViewOptions>, width = 100) => plain(view(diff, width, { expanded: false, ...options })).at(-1);
	// The first hunk's four leading context lines fold away, leaving 30 diff lines.
	assert.equal(footer({ limit: 3, toggle: "ctrl+o" }), "   … 27 more diff lines • 2 more hunks • ctrl+o to expand");
	assert.equal(footer({ limit: 3, toggle: "ctrl+o" }, 160), "   … 27 more diff lines • 2 more hunks • ctrl+o to expand", "split view shares the footer");
	assert.equal(footer({ limit: 29, toggle: "alt+e" }), "   … 1 more diff line • alt+e to expand");
	assert.ok(!plain(view(diff, 100, { expanded: true, limit: 3 })).some((row) => row.includes("to expand")), "expanded shows everything");
	const result = { content: [{ type: "text", text: "ok" }], details: { piboxWrite: { action: "rewrite", diff } } };
	const write = plain(renderToolResult("write", result, { expanded: false }, theme, { args: { path: "/r/a.ts" }, isError: false, state: {}, keyText: () => "ctrl+x" }).render(100));
	assert.equal(write.at(-1), "   … 10 more diff lines • 1 more hunk • ctrl+x to expand");
});

test("collapsed edits open on the first change and cap at twenty diff lines", () => {
	const diff = multiHunk();
	const edit = (expanded: boolean) => plain(renderToolResult("edit", { content: [{ type: "text", text: "ok" }], details: { diff } }, { expanded }, theme, { args: { path: "/r/a.ts" }, isError: false, state: {} }).render(100));
	const collapsed = edit(false);
	assert.equal(collapsed[1]!.trim(), "… 19 unchanged lines …", "leading context folds into the gap before the first change");
	assert.equal(collapsed[2], "   -20 const value20 = compute(20);");
	assert.equal(collapsed.filter((row) => /^ {3}[-+ ]\s*\d+ /.test(row)).length, 20);
	assert.equal(collapsed.at(-1), "   … 10 more diff lines • 1 more hunk • ctrl+o to expand");
	const expanded = edit(true);
	assert.equal(expanded[1]!.trim(), "… 15 unchanged lines …");
	assert.equal(expanded.filter((row) => /^ {3}[-+ ]\s*\d+ /.test(row)).length, 34, "expansion shows every diff line, leading context included");
	assert.ok(!expanded.some((row) => row.includes("to expand")));
});

test("narrow widths render unified; wide widths render a framed split view", () => {
	const diff = multiHunk();
	const narrow = plain(view(diff, SPLIT_VIEW_MIN_WIDTH - 1));
	assert.ok(!narrow.some((row) => /[┌│└]/.test(row)));
	assert.ok(narrow.includes("   -20 const value20 = compute(20);") && narrow.includes("   +20 const value20 = compute(20, true);"));
	const wide = view(diff, 160);
	const rows = plain(wide);
	assert.match(rows[0]!, /^ {3}┌─+┬─+┐$/);
	assert.match(rows.at(-1)!, /^ {3}└─+┴─+┘$/);
	const row = rows.find((line) => line.includes("-20 const value20"))!;
	assert.match(row, /^ {3}│ -20 const value20 = compute\(20\); +│ \+20 const value20 = compute\(20, true\); +│$/);
	assert.match(rows.find((line) => line.includes("… 15 unchanged"))!, /^ {3}│ +… 15 unchanged lines … +│ +… 15 unchanged lines … +│$/);
	// Context rows keep their own line number on each side once the new side has grown.
	assert.match(rows.find((line) => line.includes("const value40 "))!, /│  40 const value40 = compute\(40\); +│  42 const value40/);
	for (const line of wide) assert.equal(visibleWidth(line), 160);
	assert.ok(wide.every((line) => line.includes(`\x1b[38;2;${rgb("borderMuted")}m`)), "frame uses borderMuted");
});

test("split rows stay aligned with blank padding opposite unmatched lines", () => {
	const rows = plain(view(multiHunk(), 160));
	const divider = rows[0]!.indexOf("┬");
	for (const row of rows.slice(1, -1)) assert.equal([...row.slice(0, divider + 1)].length, divider + 1);
	for (const row of rows.slice(1, -1)) assert.equal(row[divider], "│", row);
	const start = rows.findIndex((row) => row.includes("-36 const value36"));
	assert.match(rows[start]!, /\+36 export function renamed/);
	for (const [offset, text] of [[1, "+37    return x * 2;"], [2, "+38 }"]] as const) {
		const row = rows[start + offset]!;
		assert.match(row.slice(0, divider), /^ {3}│ +$/, "left side is blank");
		assert.ok(row.slice(divider).includes(text), row);
	}
	const raw = view(multiHunk(), 160)[start + 1]!;
	assert.ok(!raw.split("│")[1]!.includes("\x1b[48;"), "blank opposite cell is not tinted");
});

test("no row exceeds the width with wide, emoji, and tab content", () => {
	const make = (index: number) => `\tconst 名前${index} = "中文字符😀👩‍💻 wide content that keeps going past any column" + ${"x".repeat(index * 7)};`;
	const before = lines(12, make);
	const after = before.map((line, index) => index % 3 ? line : line.replace("wide", "WIDE"));
	const diff = generateDiffString(before.join("\n"), after.join("\n")).diff;
	for (const width of [40, 100, 140, 160, 200]) {
		for (const expanded of [true, false]) {
			const rows = view(diff, width, { expanded });
			assert.ok(rows.length > 0);
			for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${visibleWidth(row)} ${JSON.stringify(stripTerminalSequences(row))}`);
			if (width >= SPLIT_VIEW_MIN_WIDTH && expanded) assert.ok(rows.every((row) => visibleWidth(row) === width), "split frame rows fill the width");
		}
	}
	assert.ok(!plain(view(diff, 100)).some((row) => row.includes("\t")), "tabs are expanded");
});

test("rows end with resets and emphasis never reaches padding", () => {
	const diff = [" 1 const a = 1;", `-2 const name = "alpha beta gamma delta epsilon zeta"; // trailing comment`, `+2 const name = "theta iota kappa lambda mu nu"; // trailing comment`, " 3 export {}"].join("\n");
	let wrapped = 0;
	for (const host of [theme, indexed]) {
		for (const width of [23, 40, 100, 140, 200]) {
			const rows = view(diff, width, {}, "typescript", host);
			for (const row of rows) {
				assert.ok(row.endsWith("\x1b[0m"), JSON.stringify(row));
				// Trailing padding sits outside every emphasis; with the frame, each cell's padding is checked.
				for (const cell of width >= SPLIT_VIEW_MIN_WIDTH ? row.split(/\x1b\[38;2;[\d;]+m│/) : [row]) {
					const padding = cell.match(/( +)(?:\x1b\[[0-9;]*m)*$/)?.[1] ?? "";
					if (!padding) continue;
					assert.equal(emphasized(cell).endsWith(" "), false, `emphasis spills into padding at ${width}: ${JSON.stringify(cell)}`);
				}
				if (width < 100 && emphasized(row) && !/[+-] ?\d/.test(stripTerminalSequences(row))) wrapped++;
			}
		}
	}
	assert.ok(wrapped > 0, "the scenario exercises emphasis on wrapped continuation rows");
});

test("huge diffs render plain without highlighting or word emphasis", () => {
	const before = lines(3_000, (index) => `const value${index} = compute(${index}, "alpha");`);
	const after = before.map((line) => line.replace("alpha", "beta"));
	const diff = generateDiffString(before.join("\n"), after.join("\n")).diff;
	assert.ok(diff.length > 80_000);
	const rows = view(diff, 100, { expanded: false, limit: 20 });
	assert.deepEqual(rows.map(emphasized).filter(Boolean), []);
	const kindColors = new RegExp(`\\x1b\\[38;2;(${[rgb("toolDiffAdded"), rgb("toolDiffRemoved"), rgb("toolDiffContext"), rgb("dim")].join("|")})m`, "g");
	assert.doesNotMatch(rows.join("").replace(kindColors, ""), /\x1b\[38;/);
});

test("rendered rows are cached per diff, width, and options", () => {
	const diff = multiHunk();
	const first = new DiffView(diff, "typescript", theme, { expanded: true, limit: 10, toggle: "ctrl+o", hintColor: "dim" });
	assert.equal(first.render(100), first.render(100));
	assert.equal(new DiffView(diff, "typescript", theme, { expanded: true, limit: 10, toggle: "ctrl+o", hintColor: "dim" }).render(100), first.render(100), "a new component for the same diff reuses rows");
	assert.notEqual(first.render(160), first.render(100));
});

test("edit errors and non-diff results keep their plain previews", () => {
	const error = renderToolResult("edit", { content: [{ type: "text", text: "Could not find the exact text" }] }, { expanded: false }, theme, { args: { path: "/r/a.ts" }, isError: true, state: {} });
	assert.deepEqual(plain(error.render(100)), ["└─ Error • 1 line", "   Could not find the exact text"]);
	const write = renderToolResult("write", { content: [{ type: "text", text: "Wrote 3 bytes" }] }, { expanded: false }, theme, { args: { path: "/r/a.ts" }, isError: false, state: {} });
	assert.deepEqual(plain(write.render(100)), ["└─ Done • 1 line", "   Wrote 3 bytes"]);
});
