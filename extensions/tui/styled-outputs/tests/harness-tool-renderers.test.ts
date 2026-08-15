import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { isHarnessTool, renderHarnessToolCall, renderHarnessToolResult } from "../components/harness-tool-renderers.js";
import { resourceDisplayDiff } from "../../../workflow/resource-diff.js";

initTheme("dark", false);

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

const lines = (component: { render(width: number): string[] }) => component.render(160).map((line) => stripTerminalSequences(line).trimEnd());

test("renders a foreground subagent as an inline pulsing agent row", () => {
	assert.equal(isHarnessTool("subagent_spawn"), true);
	const rendered = lines(renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester",
		mode: "foreground",
		tier: "medium",
		task: "Verify one browser flow like a real user",
	}, theme, true, false));
	assert.match(rendered[0] ?? "", /^[·•●] e2e-tester Verify one browser flow like a real user/);
	assert.equal(rendered[1], "└─ running · foreground · medium tier");
});

test("renders resource lists as concise tree rows instead of raw JSON", () => {
	const result = {
		content: [{ type: "text", text: JSON.stringify({ count: 2, resources: [
			{ ref: "work-item:checkout", title: "Checkout", state: "active" },
			{ ref: "work-item:search", title: "Search", state: "complete" },
		] }, null, 2) }],
		details: { label: "resource list" },
	};
	const rendered = lines(renderHarnessToolResult("resource_list", result, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · 2 items",
		"├─ work-item:checkout · Checkout · active",
		"└─ work-item:search · Search · complete",
	]);
	assert.doesNotMatch(rendered.join("\n"), /[{}\[\]"]/);
});

test("renders resource mutation receipts as labeled fields", () => {
	const receipt = { ref: "work-item:checkout/task:implement", commit: "abc123", revision: 3 };
	const result = {
		content: [{ type: "text", text: `Wrote ${receipt.ref}.\n${JSON.stringify(receipt, null, 2)}` }],
		details: receipt,
	};
	const rendered = lines(renderHarnessToolResult("resource_write", result, false, theme, false));
	assert.equal(rendered[0], "└─ Done · commit abc123");
	assert.match(rendered.join("\n"), /Ref: work-item:checkout\/task:implement/);
	assert.match(rendered.join("\n"), /Revision: 3/);
	assert.match(rendered.join("\n"), /Commit: abc123/);
});

test("renders canonical resource updates as a colored semantic diff", () => {
	const diff = resourceDisplayDiff("update", "work-item:checkout/task:implement", {
		id: "implement", revision: 2, status: "draft", brief: "Old behavior",
	}, {
		id: "implement", revision: 3, status: "ready", brief: "New behavior",
	});
	const rendered = lines(renderHarnessToolResult("resource_write", {
		content: [{ type: "text", text: "Wrote work-item:checkout/task:implement." }],
		details: { commit: "abcdef1234567890", piboxResourceDiff: diff },
	}, false, theme, false));
	assert.match(rendered[0] ?? "", /Done · Update work-item:checkout\/task:implement · commit abcdef123456/);
	assert.match(rendered.join("\n"), /-.*draft/);
	assert.match(rendered.join("\n"), /\+.*ready/);
	assert.doesNotMatch(rendered.join("\n"), /revision/);
});

test("renders canonical mutation changes and commit without receipt JSON", () => {
	const receipt = {
		ok: true,
		commit: "1234567890abcdef",
		changes: [{ action: "create", ref: "work-item:checkout/task:implement" }],
		affected: [{ ref: "work-item:checkout", revision: 2, state: "active" }],
	};
	const rendered = lines(renderHarnessToolResult("resource_write", {
		content: [{ type: "text", text: `Wrote work-item:checkout/task:implement.\n${JSON.stringify(receipt, null, 2)}` }],
		details: receipt,
	}, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · 1 item · commit 1234567890ab",
		"└─ work-item:checkout/task:implement · create",
	]);
});
