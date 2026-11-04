import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { decorateHexColors } from "../color-preview.js";
import { DEFAULT_STYLED_OUTPUTS_CONFIG } from "../config.js";
import { createPrefixedMarkdown } from "../components/message-layout.js";
import { highlightSnippet, INVERSE_OFF, isUnhighlighted, languageForPath, renderSyntaxDiff } from "../components/syntax.js";
import { renderToolResult } from "../components/tool-renderers.js";

initTheme("dark", false);

const rattle = JSON.parse(readFileSync("themes/rattle.json", "utf8")) as { vars: Record<string, string>; colors: Record<string, string> };
const hex = (token: string) => {
	const value = rattle.colors[token]!;
	return rattle.vars[value] ?? value;
};
const rgb = (value: string) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16)).join(";");
const theme = {
	fg: (token: string, value: string) => `\x1b[38;2;${rgb(hex(token))}m${value}\x1b[39m`,
	bg: (token: string, value: string) => `\x1b[48;2;${rgb(hex(token))}m${value}\x1b[49m`,
	bold: (value: string) => value,
} as unknown as Theme;
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const SYNTAX_COLOR = /\x1b\[38;[25];/;
const lines = ["import { a } from \"./a\";", "", "export function add(x: number): number {", "\treturn x + 1; // done", "}"];

const read = (path: string, text: string, expanded = false) =>
	renderToolResult("read", { content: [{ type: "text", text }] }, { expanded }, theme, { args: { path }, isError: false, state: {} }).render(100);

test("inline code uses the distinct mdCode color without backticks in prefixed markdown", () => {
	const color = `\x1b[38;2;${rgb(hex("mdCode"))}m`;
	const markdownTheme = { ...getMarkdownTheme(), code: (value: string) => theme.fg("mdCode", value) };
	for (const [source, bodyColor] of [["Run `npm test` now", undefined], ["# Heading with `code`", undefined], ["- item `code`", undefined], ["> quote `code`", undefined], ["Run `npm test` now", "text" as const]] as const) {
		const rendered = createPrefixedMarkdown(source, markdownTheme, theme, { prefix: "●", prefixColor: "text", ...(bodyColor ? { bodyColor } : {}) }).render(80).join("\n");
		const code = source.includes("npm") ? "npm test" : "code";
		assert.ok(rendered.includes(`${color}${code}`), `${source}: ${JSON.stringify(rendered)}`);
		assert.doesNotMatch(stripTerminalSequences(rendered), /`/);
	}
	// The chosen color is unique among the roles it sits beside in prose.
	for (const token of ["text", "accent", "mdLink", "success", "mdHeading", "mdListBullet", "toolTitle"]) assert.notEqual(hex(token).toLowerCase(), hex("mdCode").toLowerCase(), token);
});

test("color-preview chips still render inside inline code spans", () => {
	const markdownTheme = { ...getMarkdownTheme(), code: (value: string) => theme.fg("mdCode", value) };
	const source = decorateHexColors("Accent `#62B8D6` here", DEFAULT_STYLED_OUTPUTS_CONFIG.colorPreviews);
	const rendered = createPrefixedMarkdown(source, markdownTheme, theme, { prefix: "●", prefixColor: "text" }).render(80).join("\n");
	assert.match(rendered, /48;2;98;184;214/);
	assert.equal(plain([rendered])[0], " ● Accent #62B8D6 here");
});

test("read previews are syntax-highlighted by file language with unchanged visible text", () => {
	const text = lines.join("\n");
	const highlighted = read("/repo/src/add.ts", text);
	const unknown = read("/repo/notes.unknownext", text);
	assert.match(highlighted.slice(1).join("\n"), SYNTAX_COLOR);
	assert.deepEqual(plain(highlighted), plain(unknown), "same visible text as the plain preview");
	assert.equal(plain(highlighted)[2], "   export function add(x: number): number {");
	// Unknown languages keep the single dim color and no syntax colors.
	const dim = `\x1b[38;2;${rgb(hex("dim"))}m`;
	assert.ok(unknown.slice(1).every((line) => line.includes(dim) && !SYNTAX_COLOR.test(line.replaceAll(dim, ""))));
	const long = plain(read("/repo/src/add.ts", Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join("\n")));
	assert.equal(long.length, 12, "status row, ten lines, and the omitted hint");
	assert.match(long.at(-1)!, /… \+2 more lines/);
});

test("skill and rule resource reads are not highlighted when expanded", () => {
	const output = renderToolResult("read", { content: [{ type: "text", text: "# Title\nconst a = 1;" }] }, { expanded: true }, theme, { args: { path: "/repo/skills/demo/SKILL.md" }, isError: false, state: {} }).render(100).join("\n");
	assert.doesNotMatch(output.split("\n").slice(1).join("\n"), /\x1b\[38;2;(?!\d+;\d+;\d+m)/);
	assert.ok(output.includes(`\x1b[38;2;${rgb(hex("dim"))}m`));
});

test("edit diffs keep gutters, signs, and tinted changed rows while syntax-coloring code", () => {
	const diff = [" 1 const keep = 1;", "-2 const value = \"old\";", "+2 const value = \"new\";", " 3 export { keep };"].join("\n");
	const result = renderToolResult("edit", { content: [{ type: "text", text: "ok" }], details: { diff } }, { expanded: true }, theme, { args: { path: "/repo/a.ts" }, isError: false, state: {} });
	const rendered = result.render(100);
	assert.deepEqual(plain(rendered), ["└─ Done • +1 −1", "     1 const keep = 1;", "   - 2 const value = \"old\";", "   + 2 const value = \"new\";", "     3 export { keep };"]);
	const [, context, removed, added] = rendered as [string, string, string, string];
	assert.ok(removed.includes(`\x1b[38;2;${rgb(hex("toolDiffRemoved"))}m- 2 `), "removed gutter color");
	assert.ok(added.includes(`\x1b[38;2;${rgb(hex("toolDiffAdded"))}m+ 2 `), "added gutter color");
	assert.ok(removed.includes(`\x1b[48;2;${rgb(hex("toolErrorBg"))}m`) && added.includes(`\x1b[48;2;${rgb(hex("toolSuccessBg"))}m`), "changed rows are tinted");
	assert.doesNotMatch(context, /\x1b\[48;/);
	for (const row of [context, removed, added]) assert.match(row.replace(/\x1b\[38;2;[\d;]+m[ +\-\d]+\x1b\[39m/, ""), SYNTAX_COLOR, "code content carries syntax colors");
	assert.ok(removed.includes("\x1b[7m") && added.includes("\x1b[7m"), "changed span is emphasized");
});

test("diffs of unknown languages keep Pi's own rendering", () => {
	assert.equal(renderSyntaxDiff("+1 text", undefined, theme), undefined);
	const result = renderToolResult("edit", { content: [{ type: "text", text: "ok" }], details: { diff: "-1 a\n+1 b" } }, { expanded: true }, theme, { args: { path: "/repo/a.unknownext" }, isError: false, state: {} });
	assert.deepEqual(plain(result.render(100)), ["└─ Done • +1 −1", "   - 1 a", "   + 1 b"]);
});

test("highlighter failures fall back to plain rendering", () => {
	const broken = { toLowerCase() { throw new Error("boom"); } } as unknown as string;
	assert.equal(highlightSnippet("const a = 1;", broken), undefined);
	assert.equal(highlightSnippet("const a = 1;", undefined), undefined);
	assert.equal(renderSyntaxDiff("+1 const a = 1;", broken, theme), undefined);
});

test("count labels and hints use singular nouns for one item", () => {
	const label = (name: string, text: string) => plain(renderToolResult(name as any, { content: [{ type: "text", text }] }, { expanded: false }, theme, { args: {}, isError: false, state: {} }).render(80))[0];
	assert.equal(label("read", "a"), "└─ Done • 1 line");
	assert.equal(label("grep", "a:1:x"), "└─ Done • 1 match");
	assert.equal(label("grep", "a\nb"), "└─ Done • 2 matches");
	assert.equal(label("find", "a"), "└─ Done • 1 file");
	assert.equal(label("find", "a\nb"), "└─ Done • 2 files");
	assert.equal(label("ls", "a"), "└─ Done • 1 entry");
	assert.equal(label("ls", "a\nb"), "└─ Done • 2 entries");
	const hint = plain(renderToolResult("read", { content: [{ type: "text", text: Array.from({ length: 11 }, (_, i) => `l${i}`).join("\n") }] }, { expanded: false }, theme, { args: { path: "/x.txt" }, isError: false, state: {} }).render(80));
	assert.match(hint.at(-1)!, /… \+1 more line \(ctrl\+o to expand\)/);
});

test("languages Pi cannot highlight fall back to the plain dim preview and Pi's diff rendering", () => {
	const dim = `\x1b[38;2;${rgb(hex("dim"))}m`;
	for (const path of ["/repo/a.fish", "/repo/main.tf"]) {
		assert.equal(highlightSnippet("set x 1", languageForPath(path)), undefined, path);
		const rows = read(path, "set x 1").slice(1);
		assert.ok(rows.every((line) => line.includes(dim)), JSON.stringify(rows));
		const diff = renderToolResult("edit", { content: [{ type: "text", text: "ok" }], details: { diff: "-1 a b\n+1 a c" } }, { expanded: true }, theme, { args: { path }, isError: false, state: {} });
		assert.deepEqual(plain(diff.render(100)), ["└─ Done • +1 −1", "   - 1 a b", "   + 1 a c"]);
		assert.equal(renderSyntaxDiff("-1 a b\n+1 a c", languageForPath(path), theme), undefined);
	}
});

test("highlighter output without syntax counts as unhighlighted", () => {
	const source = ["const a = 1;", "x"];
	const fallback = ["<code>const a = 1;", "<code>x"];
	assert.ok(isUnhighlighted(fallback, source, fallback), "Pi's no-language code-block coloring");
	assert.ok(isUnhighlighted(source, source, fallback), "Pi 1.0.0 returns raw lines when its highlighter throws");
	assert.ok(!isUnhighlighted(["const a = <n>1</n>;", "x"], source, fallback));
});

test("diffs keep syntax rendering when a segment has no tokens to color", () => {
	const diff = [" 1 ", "-2 const value = \"old\";", "+2 const value = \"new\";", " 3 "].join("\n");
	const rendered = renderSyntaxDiff(diff, "typescript", theme);
	assert.ok(rendered);
	assert.match(rendered.map((line) => line.text).join("\n"), SYNTAX_COLOR);
});

test("read errors are never syntax-highlighted", () => {
	const dim = `\x1b[38;2;${rgb(hex("dim"))}m`;
	const message = "ENOENT: no such file or directory, open '/x/a.ts'";
	const rows = renderToolResult("read", { content: [{ type: "text", text: message }] }, { expanded: false }, theme, { args: { path: "/x/a.ts" }, isError: true, state: {} }).render(100).slice(1);
	assert.equal(rows.length, 1);
	assert.ok(rows[0]!.includes(`${dim}${message}`), JSON.stringify(rows[0]));
	assert.doesNotMatch(rows[0]!.replaceAll(dim, ""), SYNTAX_COLOR);
});

test("reverse video is closed before tint padding on every wrapped diff line", () => {
	const diff = [" 1 const a = 1;", "-2 const name = \"alpha beta gamma delta epsilon\"; // trailing", "+2 const name = \"zeta eta theta iota kappa lambda\"; // trailing", " 3 export {}"].join("\n");
	for (const width of [100, 40, 23]) {
		const lines = renderToolResult("edit", { content: [{ type: "text", text: "ok" }], details: { diff } }, { expanded: true }, theme, { args: { path: "/x/a.ts" }, isError: false, state: {} }).render(width);
		let wrappedInverse = 0;
		for (const line of lines) {
			const [, body = "", padding = ""] = line.match(/^(.*?)( *)\x1b\[49m$/) ?? [];
			if (!line.includes("\x1b[7m") && !padding) continue;
			const state = [...body.matchAll(/\x1b\[(7|27)m/g)].at(-1)?.[1];
			assert.notEqual(state, "7", `inverse still on in padding at width ${width}: ${JSON.stringify(line)}`);
			if (width < 100 && line.includes("\x1b[7m")) wrappedInverse++;
		}
		if (width < 100) assert.ok(wrappedInverse > 0, "the scenario exercises reverse video on wrapped rows");
	}
	assert.equal(INVERSE_OFF, "\x1b[27m");
});
