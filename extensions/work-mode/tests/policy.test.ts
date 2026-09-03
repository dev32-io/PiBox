import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { branchHasProviderHistory, parseWorkModeEntry, requestedStartupMode, restoreWorkMode, WORK_MODE_ENTRY_TYPE } from "../policy.js";
import { WORKFLOW_TOOL_NAMES } from "../tool-groups.js";

function ctx(entries: unknown[]) {
	return { sessionManager: { getBranch: () => entries, getEntries: () => { throw new Error("getEntries must not be used"); } } } as any;
}

function entry(data: unknown) {
	return { type: "custom", customType: WORK_MODE_ENTRY_TYPE, data };
}

test("workflow exposure group exactly covers both workflow extension surfaces", async () => {
	const sources = await Promise.all([readFile("extensions/workflow-runtime/index.ts", "utf8"), readFile("extensions/workflow/index.ts", "utf8")]);
	const registered = sources.flatMap((source) => [...source.matchAll(/registerTool\(\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1]!));
	assert.deepEqual(registered, [...WORKFLOW_TOOL_NAMES]);
});

test("restores only the latest valid active-branch work-mode entry", () => {
	const older = entry({ schemaVersion: 1, mode: "orchestrator", workflowToolsExposed: false, providerMode: "agent" });
	const malformed = entry({ schemaVersion: 1, mode: "invalid", workflowToolsExposed: true });
	const newest = entry({ schemaVersion: 1, mode: "designer", workflowToolsExposed: true, providerMode: "workflow" });
	assert.deepEqual(restoreWorkMode(ctx([older, malformed, newest])), newest.data);
	assert.deepEqual(restoreWorkMode(ctx([older, malformed])), older.data);
	assert.deepEqual(restoreWorkMode(ctx([])), { schemaVersion: 1, mode: "agent", workflowToolsExposed: false });
});

test("parsing rejects partial or invented provider state", () => {
	assert.equal(parseWorkModeEntry({ schemaVersion: 1, mode: "agent" }), undefined);
	assert.equal(parseWorkModeEntry({ schemaVersion: 1, mode: "agent", workflowToolsExposed: false, providerMode: "bogus" }), undefined);
});

test("legacy provider history is inferred without reading message content", () => {
	assert.equal(branchHasProviderHistory(ctx([{ type: "message", message: { role: "user", content: "unsent" } }])), false);
	assert.equal(branchHasProviderHistory(ctx([{ type: "message", message: { role: "assistant", content: "answer" } }])), true);
	assert.equal(branchHasProviderHistory(ctx([{ type: "compaction", summary: "opaque" }])), true);
});

test("startup mode accepts four modes and the bounded deprecated profile alias", () => {
	assert.equal(requestedStartupMode({ getFlag: (name: string) => name === "work-mode" ? "Workflow" : undefined } as any), "workflow");
	assert.equal(requestedStartupMode({ getFlag: (name: string) => name === "profile" ? "default" : undefined } as any), "agent");
	assert.equal(requestedStartupMode({ getFlag: (name: string) => name === "profile" ? "designer" : undefined } as any), "designer");
	assert.throws(() => requestedStartupMode({ getFlag: () => "made-up" } as any), /Unknown PiBox mode/);
});
