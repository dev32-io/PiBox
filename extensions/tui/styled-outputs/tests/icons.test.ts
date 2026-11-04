import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import * as icons from "../../icons.js";
import { renderHarnessToolCall } from "../components/harness-tool-renderers.js";
import { renderToolCall } from "../components/tool-renderers.js";

const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const cp = (value: string) => [...value].map((char) => char.codePointAt(0));

test("icon module exposes the exact Nerd Font code points", () => {
	assert.deepEqual(
		{
			bash: cp(icons.ICON_BASH), read: cp(icons.ICON_READ), edit: cp(icons.ICON_EDIT), write: cp(icons.ICON_WRITE),
			grep: cp(icons.ICON_GREP), folder: cp(icons.ICON_FOLDER), explore: cp(icons.ICON_EXPLORE), subagent: cp(icons.ICON_SUBAGENT), workflow: cp(icons.ICON_WORKFLOW),
			web: cp(icons.ICON_WEB), tool: cp(icons.ICON_TOOL), branch: cp(icons.ICON_GIT_BRANCH), separator: cp(icons.ICON_SEPARATOR),
		},
		{
			bash: [0xf489], read: [0xf15c], edit: [0xf044], write: [0xea7f], grep: [0xf002], folder: [0xf07b], explore: [0xf1e5], subagent: [0xf06a9],
			workflow: [0xf0e8], web: [0xf0ac], tool: [0xf0ad], branch: [0xe725], separator: [0xe0b1],
		},
	);
	assert.equal(visibleWidth(icons.ICON_BASH), 1, "private-use glyphs measure one cell in pi-tui");
	assert.equal(visibleWidth(icons.ICON_SUBAGENT), 1);
});

test("tool names map to their icons", () => {
	assert.deepEqual(["bash", "read", "edit", "write", "grep", "find", "ls"].map((name) => icons.builtinToolIcon(name)), [
		icons.ICON_BASH, icons.ICON_READ, icons.ICON_EDIT, icons.ICON_WRITE, icons.ICON_GREP, icons.ICON_FOLDER, icons.ICON_FOLDER,
	]);
	for (const name of ["mcp__context7__query", "web_search", "fetch_content", "source_check", "get_search_content"]) assert.equal(icons.decoratedToolIcon(name), icons.ICON_WEB, name);
	assert.equal(icons.decoratedToolIcon("something_else"), icons.ICON_TOOL);
	for (const name of ["workflow_start", "story_write", "task_write", "stage_write", "resource_list", "wait"]) assert.equal(icons.harnessToolIcon(name), icons.ICON_WORKFLOW, name);
	assert.equal(icons.harnessToolIcon("subagent_spawn"), icons.ICON_SUBAGENT);
});

test("header icons sit between lifecycle glyph and action with exactly one space", () => {
	const header = (name: any, args: any) => plain(renderToolCall(name, args, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(80))[0]!;
	assert.equal(header("bash", { command: "ls" }), "✓ \u{f489} Bash ls");
	assert.equal(header("read", { path: "a.ts" }), "✓ \u{f15c} Read a.ts");
	assert.equal(header("edit", { path: "a.ts" }), "✓ \u{f044} Update a.ts");
	assert.equal(header("write", { path: "a.ts" }), "✓ \u{ea7f} Write a.ts");
	assert.equal(header("grep", { pattern: "x", path: "." }), "✓ \u{f002} Grep x in .");
	assert.equal(header("find", { pattern: "*.ts", path: "." }), "✓ \u{f07b} Find *.ts in .");
	assert.equal(header("ls", { path: "." }), "✓ \u{f07b} Ls .");
	assert.equal(plain(renderHarnessToolCall("subagent_spawn", { agent: "worker" }, theme, false, false).render(80))[0], "✓ \u{f06a9} worker");
	assert.equal(plain(renderHarnessToolCall("workflow_compile", {}, theme, false, false).render(80))[0], "✓ \u{f0e8} Compile workflow");
});

test("wrapped headers keep the rail under the glyph and align under the target at widths 40 and 80", () => {
	const command = "cd /Users/kevinye/Development/sentient/.worktree/skill-hub && git merge --no-edit feature/skill-hub-long-branch-name && git log --oneline -5";
	for (const width of [40, 80]) {
		const rows = plain(renderToolCall("bash", { command }, theme, { isPartial: false, isError: false, expanded: false, state: {} }).render(width));
		assert.ok(rows.length > 1);
		const targetColumn = rows[0]!.indexOf("cd ");
		assert.equal(targetColumn, [..."✓ \u{f489} Bash "].length, "target follows glyph, icon, action");
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${row}`);
		for (const row of rows.slice(1)) {
			assert.equal(row[0], "│", "rail stays in the lifecycle glyph column");
			assert.match(row.slice(1, targetColumn), /^ +$/);
			assert.notEqual(row[targetColumn], " ", "text starts exactly at the target column");
		}
	}
});
