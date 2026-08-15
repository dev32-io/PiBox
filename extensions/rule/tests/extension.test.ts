import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import rulesExtension from "../index.js";

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pibox-rules-extension-"));
	mkdirSync(join(cwd, ".git"));
	mkdirSync(join(cwd, ".claude", "rules"), { recursive: true });
	writeFileSync(join(cwd, ".claude", "rules", "always.md"), "# Always\n\nPreserve behavior.\n");
	writeFileSync(join(cwd, ".claude", "rules", "typescript.md"), "---\npaths: ['src/**/*.ts']\n---\n# TypeScript\n\nUse strict types.\n");
	return cwd;
}

function harness(cwd: string) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: any[] = [];
	let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		registerEntryRenderer(_type: string, value: typeof renderer) { renderer = value; },
	};
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: { buildContextEntries: () => entries },
	};
	rulesExtension(pi as any);
	return { handlers, entries, ctx, renderer: () => renderer };
}

test("injects unconditional rules at agent start and scoped rules after matching reads", async () => {
	const cwd = fixture();
	const h = harness(cwd);
	await h.handlers.get("session_start")?.({}, h.ctx);
	const start = await h.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, h.ctx);
	assert.match(start.systemPrompt, /## Project Rules/);
	assert.match(start.systemPrompt, /Preserve behavior/);
	assert.doesNotMatch(start.systemPrompt, /Use strict types/);

	await h.handlers.get("tool_call")?.({ toolName: "read", toolCallId: "read-1", input: { path: "src/app.ts" } }, h.ctx);
	const result = await h.handlers.get("tool_result")?.({ toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "source" }], details: undefined }, h.ctx);
	assert.equal(result.content[0].text, "source");
	assert.match(result.content[1].text, /Rules loaded for src\/app\.ts/);
	assert.match(result.content[1].text, /Use strict types/);
	assert.equal(h.entries.length, 1);
	assert.deepEqual(h.entries[0].data.labels, ["typescript"]);

	await h.handlers.get("tool_call")?.({ toolName: "read", toolCallId: "read-2", input: { path: "src/again.ts" } }, h.ctx);
	assert.equal(await h.handlers.get("tool_result")?.({ toolName: "read", toolCallId: "read-2", content: [{ type: "text", text: "again" }] }, h.ctx), undefined);
});

test("failed reads do not activate matching rules", async () => {
	const cwd = fixture();
	const h = harness(cwd);
	await h.handlers.get("session_start")?.({}, h.ctx);
	await h.handlers.get("tool_call")?.({ toolName: "read", toolCallId: "failed", input: { path: "src/missing.ts" } }, h.ctx);
	assert.equal(await h.handlers.get("tool_result")?.({ toolName: "read", toolCallId: "failed", content: [{ type: "text", text: "missing" }], isError: true }, h.ctx), undefined);
	assert.equal(h.entries.length, 0);
	await h.handlers.get("tool_call")?.({ toolName: "read", toolCallId: "retry", input: { path: "src/present.ts" } }, h.ctx);
	const retry = await h.handlers.get("tool_result")?.({ toolName: "read", toolCallId: "retry", content: [{ type: "text", text: "source" }], isError: false }, h.ctx);
	assert.match(retry.content[1].text, /Use strict types/);
});

test("direct rule reads are not duplicated in the tool result", async () => {
	const cwd = fixture();
	const h = harness(cwd);
	await h.handlers.get("session_start")?.({}, h.ctx);
	const path = join(cwd, ".claude", "rules", "typescript.md");
	await h.handlers.get("tool_call")?.({ toolName: "read", toolCallId: "rule-read", input: { path } }, h.ctx);
	const result = await h.handlers.get("tool_result")?.({ toolName: "read", toolCallId: "rule-read", content: [{ type: "text", text: "rule body" }] }, h.ctx);
	assert.equal(result, undefined);
	assert.deepEqual(h.entries[0].data.labels, []);
});
