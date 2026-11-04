import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { classifyLoadedResource, renderToolCall, renderToolResult } from "../components/tool-renderers.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

test("renders skill and rule reads as compact loaded resources", () => {
	assert.deepEqual(classifyLoadedResource("/repo/skills/architecture-visualizer/SKILL.md"), { kind: "skill", label: "architecture-visualizer" });
	assert.deepEqual(classifyLoadedResource("/repo/.claude/rules/gateway/typescript.md"), { kind: "rule", label: "gateway/typescript" });
	assert.deepEqual(classifyLoadedResource("~/.pi/agent/rules/personal.md"), { kind: "rule", label: "personal" });
	assert.equal(classifyLoadedResource("/repo/src/rules.ts"), undefined);

	const call = renderToolCall("read", { path: "/repo/.pi/rules/typescript.md" }, theme, { cwd: "/repo", isPartial: false, isError: false });
	assert.equal(call.render(100).join("\n").trimEnd(), "✓ Loaded rule typescript");
	const collapsed = renderToolResult("read", { content: [{ type: "text", text: "rule body" }] }, { expanded: false }, theme, {
		args: { path: "/repo/.pi/rules/typescript.md" }, isError: false, state: {},
	});
	assert.deepEqual(collapsed.render(100), []);
});

test("caps read previews at ten lines", () => {
	const call = renderToolCall("read", { path: "/tmp/project/file.ts" }, theme, {
		cwd: "/tmp/project",
		isPartial: false,
		isError: false,
	});
	assert.match(call.render(100).join("\n"), /^✓ Read file\.ts/);

	const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
	const result = renderToolResult("read", { content: [{ type: "text", text: lines.join("\n") }] }, { expanded: false }, theme, {
		args: { path: "/tmp/project/file.ts" },
		isError: false,
		state: {},
	});
	const rendered = result.render(100).join("\n");
	assert.match(rendered, /^└─ Done • 12 lines/);
	assert.match(rendered, /line 10/);
	assert.doesNotMatch(rendered, /line 11/);
	assert.match(rendered, /… \+2 more lines \(ctrl\+o to expand\)/);
});

test("keeps expanded output nested beneath the message-aligned tool row", () => {
	const result = renderToolResult("bash", { content: [{ type: "text", text: "one\ntwo" }] }, { expanded: true }, theme, {
		args: { command: "printf output" },
		isError: false,
	});
	assert.deepEqual(result.render(100).map((line) => stripTerminalSequences(line).trimEnd()), ["└─ Done • 2 lines", "   one", "   two"]);
});

test("preserves leading whitespace in tool output", () => {
	const result = renderToolResult("read", { content: [{ type: "text", text: "function demo() {\n\treturn true;\n}" }] }, { expanded: true }, theme, {
		args: { path: "/tmp/project/file.ts" },
		isError: false,
		state: {},
	});
	assert.deepEqual(result.render(100).map((line) => stripTerminalSequences(line).trimEnd()), ["└─ Done • 3 lines", "   function demo() {", "      return true;", "   }"]);
});

test("caps collapsed long-line output by characters", () => {
	const result = renderToolResult("bash", { content: [{ type: "text", text: "x".repeat(1_400) }] }, { expanded: false }, theme, {
		args: { command: "emit source map" },
		isError: false,
	});
	const rendered = stripTerminalSequences(result.render(2_000).join("\n"));
	assert.match(rendered, /… \+200 more characters \(ctrl\+o to expand\)/);
	assert.doesNotMatch(rendered, new RegExp(`x{1201}`));
});

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

test("long single-line bash commands wrap in full under a hanging indent", () => {
	const command = "cd /Users/kevinye/Development/sentient/.worktree/skill-hub && git merge --no-edit feature/skill-hub-long-branch-name && git log --oneline -5";
	for (const expanded of [false, true]) {
		const rows = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded, state: {} }).render(80));
		assert.ok(rows.length > 1, "the command wraps instead of being cut");
		assert.match(rows[0]!, /^✓ Bash cd /);
		for (const row of rows) assert.ok(row.length <= 80, row);
		for (const row of rows.slice(1)) assert.match(row, /^│ {6}\S/, "continuations align under the command, with a rail joining the glyph to the status branch");
		assert.equal(rows.map((row) => row.slice(7)).join(" ").replace(/ +/g, " "), command.replace(/ +/g, " "));
		assert.doesNotMatch(rows.join("\n"), /to expand/, "a merely wrapped single-line command is never collapsed");
	}
});

test("multi-line commands collapse to three rows and expand with preserved newlines", () => {
	const command = "cat > /tmp/script.sh <<'EOF'\nset -e\n  echo one\n  echo two\necho three\nEOF";
	const collapsed = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(80));
	assert.deepEqual(collapsed, [
		"✓ Bash cat > /tmp/script.sh <<'EOF'",
		"│      set -e",
		"│        echo one",
		"│      … +3 lines (ctrl+o to expand)",
	]);
	const hosted = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded: false, state: {}, keyText: () => "ctrl+shift+o/f2" }).render(80));
	assert.match(hosted.at(-1)!, /\(ctrl\+shift\+o to expand\)$/, "Pi 1.5 host keybinding labels win");
	const expanded = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded: true, state: {} }).render(80));
	assert.deepEqual(expanded, ["✓ Bash cat > /tmp/script.sh <<'EOF'", "│      set -e", "│        echo one", "│        echo two", "│      echo three", "│      EOF"]);
});

test("expanded output is not capped by the collapsed character limit", () => {
	const text = "x".repeat(3_000);
	const result = renderToolResult("bash", { content: [{ type: "text", text }] }, { expanded: true }, theme, { args: { command: "emit" }, isError: false });
	const rendered = plain(result.render(200)).join("");
	assert.equal(rendered.match(/x/g)?.length, 3_000);
	assert.doesNotMatch(rendered, /more characters/);
});

test("finished status lines report duration only when it is known", () => {
	const status = (ctx: any) => plain(renderToolResult("bash", { content: [{ type: "text", text: "a\nb\nc" }] }, { expanded: false }, theme, { args: { command: "x" }, isError: false, ...ctx }).render(80))[0];
	assert.equal(status({ durationMs: 2_100, state: {} }), "└─ Done • 3 lines • 2.1s", "Pi >=1.1 ctx.durationMs");
	assert.equal(status({ state: { piboxTiming: { startedAt: 1, durationMs: 400 } } }), "└─ Done • 3 lines • 0.4s", "renderer-state timing on Pi 1.0");
	assert.equal(status({ durationMs: 1_500, state: { piboxTiming: { durationMs: 9_000 } } }), "└─ Done • 3 lines • 1.5s", "host duration wins");
	assert.equal(status({ state: {} }), "└─ Done • 3 lines", "unknown (restored) duration is omitted");
	assert.equal(status({}), "└─ Done • 3 lines");
	const error = renderToolResult("bash", { content: [{ type: "text", text: "boom" }] }, { expanded: false }, theme, { args: { command: "x" }, isError: true, durationMs: 65_000 });
	assert.equal(plain(error.render(80))[0], "└─ Error • 1 line • 1m 05s");
});

test("running rows show live elapsed time and partial output without a premature Done", (t) => {
	t.mock.method(Date, "now", () => 20_000);
	const state = { piboxTiming: { startedAt: 7_600 } };
	const call = plain(renderToolCall("bash", { command: "sleep 30" }, theme, { isPartial: true, isError: false, state }).render(80));
	assert.deepEqual(call, ["✽ Bash sleep 30", "└─ Running… 12s"]);
	const before = plain(renderToolCall("bash", { command: "sleep 30" }, theme, { isPartial: true, isError: false, state: {} }).render(80));
	assert.deepEqual(before, ["✽ Bash sleep 30", "└─ Running…"], "no start timestamp means no invented elapsed time");
	const partial = plain(renderToolResult("bash", { content: [{ type: "text", text: "tick" }] }, { expanded: false }, theme, { args: { command: "x" }, isPartial: true, isError: false, state }).render(80));
	assert.deepEqual(partial, ["   tick"]);
});

test("narrow widths never cut a single-line command or collapse it behind a hint", () => {
	const command = "cd /Users/kevinye/Development/sentient/.worktree/skill-hub && git merge --no-edit feature/skill-hub-long-branch-name && git log --oneline -5";
	for (const width of [40, 24]) {
		const rows = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(width));
		assert.ok(rows.length > 4, "wraps to more than the collapsed row count");
		assert.doesNotMatch(rows.join("\n"), /to expand|\+\d+ lines?/);
		assert.equal(rows.map((row, index) => row.slice(index === 0 ? 7 : 7)).join("").replace(/ /g, ""), command.replace(/ /g, ""));
		for (const row of rows) assert.ok(row.length <= width, row);
	}
	const target = "x".repeat(200);
	const grep = plain(renderToolCall("grep", { pattern: target, path: "." }, theme, { isPartial: false, isError: false, expanded: false, state: {}, cwd: "/repo" }).render(40));
	assert.doesNotMatch(grep.join("\n"), /to expand/);
});

test("narrow multi-line commands collapse by real lines, each wrapped in full, with a real-line count", () => {
	const long = "echo " + "word ".repeat(20).trim();
	const command = ["set -e", long, "echo three", "echo four", "echo five"].join("\n");
	const rows = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(40));
	assert.equal(rows.at(-1), "│      … +2 lines (ctrl+o to expand)");
	const body = rows.slice(0, -1);
	assert.ok(body.length > 3, "the long second line is wrapped in full, not cut to three rows");
	assert.equal(body.map((row, index) => row.slice(index === 0 ? 7 : 7)).join(" ").replace(/ +/g, " ").trim(), `set -e ${long} echo three`.replace(/ +/g, " "));
	for (const row of rows) assert.ok(row.length <= 40, row);
	const four = plain(renderToolCall("bash", { command: "a\nb\nc\nd" }, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(40));
	assert.equal(four.at(-1), "│      … +1 line (ctrl+o to expand)", "singular count");
	const three = plain(renderToolCall("bash", { command: "a\nb\nc" }, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(40));
	assert.doesNotMatch(three.join("\n"), /to expand/, "three real lines fit without a hint");
});

test("wrapping a very long single-line command stays linear", () => {
	const build = (length: number) => {
		const command = "echo " + Array.from({ length: length / 5 }, (_, i) => `ab${i % 10}c`).join(" ");
		const started = performance.now();
		const rows = renderToolCall("bash", { command }, theme, { isPartial: true, isError: false, expanded: false, state: {} }).render(100);
		return { ms: performance.now() - started, rows: rows.length };
	};
	build(20_000);
	const best = (length: number) => Math.min(...[1, 2, 3].map(() => build(length).ms));
	const small = best(50_000);
	const large = best(200_000);
	assert.ok(build(100_000).rows > 1_000, "the whole command is rendered");
	// Quadratic wrapping scales ~16x for 4x the text (and took ~200ms for 100 KB); linear stays near 4x.
	assert.ok(large < Math.max(small * 10, 25), `4x text took ${small.toFixed(1)}ms -> ${large.toFixed(1)}ms`);
	assert.ok(large < 500, `${large.toFixed(1)}ms`);
});
