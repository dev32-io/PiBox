import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentPrompt } from "../components/subagent-prompt.js";
import { renderHarnessToolCall } from "../components/harness-tool-renderers.js";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as Theme;
const preview = (task: unknown, expanded = false, width = 120) => renderSubagentPrompt(task, expanded, width, theme).map(stripTerminalSequences);

test("prompt previews cap both wrapped lines and Unicode characters", () => {
	const multiline = Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join("\n");
	assert.deepEqual(preview(multiline), ["   Prompt:", "      line 1", "      line 2", "      line 3", "      line 4", "      line 5", "      … (ctrl+o to expand)"]);
	assert.equal(preview(multiline, true).at(-1), "      line 7");
	assert.equal(preview("x".repeat(100), false, 13).length, 7, "line limit is applied after wrapping");
	assert.equal(preview("x".repeat(50), false, 16).length, 6, "exactly five wrapped lines need no hint");
	assert.deepEqual(preview("😀".repeat(501), false, 1200), ["   Prompt:", `      ${"😀".repeat(500)}`, "      … (ctrl+o to expand)"]);
	assert.equal(preview("😀".repeat(500), false, 1200).length, 2, "500 code points do not split surrogate pairs or require a hint");
	assert.equal(preview("😀".repeat(501), true, 1200)[1], `      ${"😀".repeat(501)}`);
});

test("prompt display preserves multiline indentation and removes terminal controls without changing args", () => {
	const task = "  first\r\n\tsecond\n\n\x1b[31mthird\x1b[0m\x1b]2;owned\x07\x00\x7f";
	assert.deepEqual(preview(task, true), ["   Prompt:", "        first", "         second", "      ", "      third"]);
	assert.match(task, /owned/, "sanitization is display-only");
	for (const task of [undefined, null, 42, {}, "", " \n\t"]) assert.deepEqual(preview(task), []);
	for (const width of [1, 2, 3, 4, 8, 20]) {
		for (const expanded of [false, true]) {
			assert.ok(preview("中文 😀 words\n".repeat(20), expanded, width).every((line) => visibleWidth(line) <= width && !line.includes("\n")));
		}
	}
	assert.deepEqual(preview("hello", false, 0), []);
});

test("prompt truncation hint respects the configured expansion shortcut", () => {
	const keybindings = getKeybindings();
	const original = keybindings.getKeys;
	try {
		keybindings.getKeys = ((id: string) => id === "app.tools.expand" ? ["alt+o"] : original.call(keybindings, id as any)) as typeof original;
		assert.equal(preview("x".repeat(501)).at(-1), "      … (alt+o to expand)");
	} finally {
		keybindings.getKeys = original;
	}
});

test("spawn and continuation prompts remain visible across lifecycle states and expand completely", () => {
	const task = "x".repeat(500) + "PROMPT_END";
	for (const name of ["subagent_spawn", "subagent_continue"]) {
		for (const mode of ["foreground", "background"]) {
			for (const partial of [false, true]) {
				const args = { agent: "investigator", agentId: "agent-1", title: "Inspect rendering", task, mode };
				const render = (expanded: boolean) => renderHarnessToolCall(name, args, theme, partial, false, undefined, undefined, undefined, expanded).render(120).join("\n");
				assert.match(render(false), /Prompt:/);
				assert.doesNotMatch(render(false), /PROMPT_END/);
				assert.match(render(true), /PROMPT_END/);
				assert.equal(args.task, task);
			}
		}
	}
	assert.doesNotMatch(renderHarnessToolCall("subagent_status", { task }, theme, false, false).render(120).join("\n"), /Prompt:/);
});

test("untitled subagent calls never leak prompt controls through the headline fallback", () => {
	for (const name of ["subagent_spawn", "subagent_continue"]) {
		const task = "\x1b]52;c;Y2xpcGJvYXJk\x07\x1b]2;PWNED\x07Do work\x1b[31m now\x1b[0m";
		const args = { agent: "investigator", agentId: "agent-1", task };
		for (const expanded of [false, true]) {
			const rendered = renderHarnessToolCall(name, args, theme, false, false, undefined, undefined, undefined, expanded).render(120);
			assert.doesNotMatch(rendered.join("\n"), /[\x00-\x09\x0b-\x1f\x7f-\x9f]|PWNED|Y2xpcGJvYXJk/);
			assert.doesNotMatch(rendered[0]!, /Do work/);
			assert.match(rendered.join("\n"), /Do work now/);
			assert.equal(args.task, task);
		}
	}
});
