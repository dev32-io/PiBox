import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, convertToLlm, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderHarnessToolResult } from "../../tui/styled-outputs/components/harness-tool-renderers.js";
import memoryAdapter, { recallIneligibility } from "../index.js";
import { Mem0Client, type MemoryRecord } from "../client.js";
import { deriveRepositoryScope } from "../scope.js";

async function fixture(t: any) {
	const runtimeRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	t.after(() => { if (runtimeRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE; else process.env.PIBOX_RUNTIME_ROLE = runtimeRole; });
	const root = await mkdtemp(join(tmpdir(), "pibox-memory-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(root, "proof.ts"), "verified\n");
	git("add", "proof.ts");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	let tool: any;
	const pi: any = {
		registerTool(value: any) { tool = value; },
		registerCommand(name: string, value: any) { commands.set(name, value); },
		on(name: string, fn: any) { handlers.set(name, fn); },
		events: { on() {} },
		sendMessage() { assert.fail("no queued messages"); },
		sendUserMessage() { assert.fail("no synthetic prompts"); },
		async exec(_command: string, args: string[]) {
			try { return { code: 0, stdout: git(...args), stderr: "" }; }
			catch (error: any) { return { code: error.status, stdout: error.stdout ?? "", stderr: "" }; }
		},
	};
	const scope = await deriveRepositoryScope(pi, root);
	let records: MemoryRecord[] = [];
	let searches = 0;
	let query = "";
	let healthy = true;
	let failSave = false;
	t.mock.method(Mem0Client.prototype, "health", async () => healthy);
	t.mock.method(Mem0Client.prototype, "search", async (text: string) => { searches++; query = text; return records; });
	t.mock.method(Mem0Client.prototype, "add", async (memory: string, _user: string, metadata: any) => {
		if (failSave) throw new Error("save failed");
		const record = { id: `m${records.length}`, memory, metadata, score: 0.8 };
		records.push(record);
		return [record];
	});
	memoryAdapter(pi);
	const ctx: any = { cwd: root, hasUI: true, ui: { notify(text: string) { notices.push(text); } }, sessionManager: SessionManager.create(root, join(root, "sessions")) };
	return { root, git, pi, ctx, scope, handlers, commands, notices, tool,
		get records() { return records; }, set records(value) { records = value; },
		get searches() { return searches; }, get query() { return query; },
		set healthy(value: boolean) { healthy = value; }, set failSave(value: boolean) { failSave = value; },
		call: (input: any) => tool.execute("test", input, undefined, undefined, ctx),
		before: (prompt: string) => handlers.get("before_agent_start")({ prompt }, ctx),
	};
}

test("curation validates actual conversation provenance, code freshness and read-only children", async t => {
	const f = await fixture(t);
	const userId = f.ctx.sessionManager.appendMessage({ role: "user", content: "Prefer focused offline tests for this repository.", timestamp: 1 });
	await f.call({ action: "remember", memory: "Prefer focused offline tests.", conversationQuote: "Prefer focused offline tests" });
	const user = f.records[0]!;
	assert.equal(user.metadata?.source_kind, "conversation");
	assert.equal(user.metadata?.verified_commit, undefined);
	assert.equal((user.metadata?.conversation as any).entry_id, userId);
	assert.equal(await recallIneligibility(f.pi, user, f.scope), undefined);
	assert.match((await recallIneligibility(f.pi, { ...user, metadata: { ...user.metadata, conversation: { session_id: "s", entry_id: "e", quote_sha256: "fake" } } }, f.scope))!, /unproven/);
	assert.deepEqual(f.notices, ["Memory saved."]);
	await assert.rejects(f.call({ action: "remember", memory: "fiction", conversationQuote: "Not in conversation" }), /actual user message/);
	await assert.rejects(f.call({ action: "remember", memory: "unproven" }), /no evidence paths/);
	await assert.rejects(f.call({ action: "remember", memory: "escape", evidencePaths: ["../outside"] }), /inside the repository/);
	await writeFile(join(f.root, "untracked.ts"), "not tracked");
	await assert.rejects(f.call({ action: "remember", memory: "untracked", evidencePaths: ["untracked.ts"] }), /not tracked/);
	await f.call({ action: "remember", memory: "Verified lesson.", evidencePaths: ["proof.ts"] });
	const code = f.records[1]!;
	assert.equal(code.metadata?.verified_commit, f.scope.commit);
	await writeFile(join(f.root, "proof.ts"), "changed\n");
	assert.match((await recallIneligibility(f.pi, code, f.scope))!, /changed/);
	assert.equal(await recallIneligibility(f.pi, user, f.scope), undefined, "user facts do not acquire Git fiction");
	const notices = f.notices.length;
	f.failSave = true;
	await assert.rejects(f.call({ action: "remember", memory: "failure", conversationQuote: "Prefer focused offline tests" }), /save failed/);
	assert.equal(f.notices.length, notices, "failed saves never notify success");
	t.mock.method(Mem0Client.prototype, "add", async () => []);
	const empty = await f.call({ action: "remember", memory: "not stored", conversationQuote: "Prefer focused offline tests" });
	assert.match(empty.content[0].text, /no saved records/);
	assert.equal(f.notices.length, notices, "empty response is not a confirmed save");
	const oldRole = process.env.PIBOX_RUNTIME_ROLE;
	const oldId = process.env.PIBOX_SUBAGENT_ID;
	try {
		process.env.PIBOX_RUNTIME_ROLE = "subagent";
		delete process.env.PIBOX_SUBAGENT_ID;
		for (const action of ["remember", "update", "delete"]) await assert.rejects(f.call({ action, id: user.id, memory: "forbidden" }), /read-only/);
		assert.match((await f.call({ action: "recall", query: "offline tests" })).content[0].text, /Prefer focused/);
		delete process.env.PIBOX_RUNTIME_ROLE;
		process.env.PIBOX_SUBAGENT_ID = "identity-only";
		assert.match((await f.call({ action: "remember", memory: "Main-session save", conversationQuote: "Prefer focused offline tests" })).content[0].text, /no saved records/, "identity alone never selects child authority");
	} finally {
		if (oldRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE; else process.env.PIBOX_RUNTIME_ROLE = oldRole;
		if (oldId === undefined) delete process.env.PIBOX_SUBAGENT_ID; else process.env.PIBOX_SUBAGENT_ID = oldId;
	}
});

test("manual and bootstrap recall exclude invalid, stale, expired and cross-repository evidence", async t => {
	const f = await fixture(t);
	const metadata = { repo_id: f.scope.repoId, status: "active", verified_commit: f.scope.commit, evidence_paths: ["proof.ts"] };
	f.records = [
		{ id: "legacy", memory: "Verified legacy code lesson", score: 0.8, metadata },
		{ id: "foreign", memory: "foreign secret", score: 0.99, metadata: { ...metadata, repo_id: "other" } },
		{ id: "expired", memory: "expired fact", score: 0.9, metadata, expiration_date: "2000-01-01" },
		{ id: "unproven", memory: "unproven conversation", score: 0.9, metadata: { ...metadata, source_kind: "conversation" } },
		{ id: "unknown", memory: "unknown kind", score: 0.9, metadata: { ...metadata, source_kind: "invented" } },
		{ id: "no-proof", memory: "unproven legacy", score: 0.9, metadata: { ...metadata, evidence_paths: [] } },
	];
	const before = await f.before("code lesson");
	const manual = await f.call({ action: "recall", query: "code lesson" });
	assert.equal(manual.content[0].text, before.message.content);
	assert.match(manual.content[0].text, /Verified legacy/);
	assert.doesNotMatch(manual.content[0].text, /foreign secret|expired fact|unproven|unknown kind/);
	assert.equal(manual.details.retrieval.skipped.length, 5);
	await writeFile(join(f.root, "proof.ts"), "stale\n");
	assert.equal(await f.before("lesson"), undefined);
	await f.commands.get("memory-debug").handler("", f.ctx);
	assert.match(f.notices.at(-1)!, /changed since verification/);
	const count = f.notices.length;
	f.healthy = false;
	assert.equal(await f.before("lesson"), undefined);
	assert.equal(f.notices.length, count, "unavailable bootstrap stays quiet");
	await f.commands.get("memory-debug").handler("", f.ctx);
	assert.match(f.notices.at(-1)!, /unavailable/);
});

test("recall producer renders only eligible packed records with accurate count and inspectable rows", async t => {
	const f = await fixture(t);
	f.ctx.sessionManager.appendMessage({ role: "user", content: "Prefer focused offline tests.", timestamp: 1 });
	await f.call({ action: "remember", memory: "Prefer focused offline tests.", type: "preference", conversationQuote: "Prefer focused offline tests." });
	await f.call({ action: "remember", memory: "STALE_LEAK", evidencePaths: ["proof.ts"] });
	const eligible = f.records[0]!;
	f.records.push(
		{ ...eligible, id: "foreign", memory: "FOREIGN_LEAK", metadata: { ...eligible.metadata, repo_id: "other" } },
		{ ...eligible, id: "oversize", memory: "OVERSIZE_LEAK", metadata: { ...eligible.metadata, type: "x".repeat(4_000) } },
	);
	await writeFile(join(f.root, "proof.ts"), "changed\n");
	const before = await f.before("offline tests");
	const result = await f.call({ action: "recall", query: "offline tests" });
	assert.deepEqual(result.details.records, [eligible]);
	assert.deepEqual(result.details.retrieval.selected.map((record: any) => record.id), [eligible.id]);
	assert.equal(result.details.retrieval.skipped.length, 3);
	assert.match(result.details.retrieval.skipped.find((record: any) => record.id === "oversize").reason, /context budget/);
	assert.equal(result.content[0].text, before.message.content, "bootstrap snapshot retains same bounded model text");
	assert.ok(result.content[0].text.length <= 4_000);
	assert.doesNotMatch(result.content[0].text, /FOREIGN_LEAK|STALE_LEAK|OVERSIZE_LEAK/);
	const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
	for (const expanded of [false, true]) {
		const rows = renderHarnessToolResult("memory_adapter", result, expanded, theme, false).render(160).map(line => stripTerminalSequences(line).trimEnd());
		assert.deepEqual(rows, ["└─ Done · 1 memory", `   └─ ${eligible.id} · preference · Prefer focused offline tests.`]);
	}
	f.records = [];
	const empty = await f.call({ action: "recall", query: "offline tests" });
	assert.deepEqual(empty.details.records, [], "empty recall cannot leak earlier packed records");
	assert.deepEqual(renderHarnessToolResult("memory_adapter", empty, false, theme, false).render(160).map(line => stripTerminalSequences(line).trimEnd()), ["└─ Done · 0 memories"]);
});

test("code memories save and recall Unicode tracked evidence under Git path quoting", async t => {
	const f = await fixture(t);
	const path = "说明.ts";
	await writeFile(join(f.root, path), "verified Unicode evidence\n");
	f.git("add", path);
	f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Unicode evidence");
	f.git("config", "core.quotepath", "true");
	assert.match(f.git("ls-tree", "-r", "--name-only", "HEAD", "--", path), /^"/, "fixture reproduces Git's quoted output");
	await f.call({ action: "remember", memory: "Verified Unicode lesson.", evidencePaths: [path] });
	assert.deepEqual(f.records[0]!.metadata?.evidence_paths, [path]);
	const result = await f.call({ action: "recall", query: "Unicode lesson" });
	assert.match(result.content[0].text, /Verified Unicode lesson/);
	assert.ok(result.content[0].text.includes(`Evidence: ${path}`));
	assert.deepEqual(result.details.retrieval.selected.map((record: any) => record.id), [f.records[0]!.id]);
});

test("durable snapshot keeps prefix through tools, steer, new prompt, reload, branch and compaction", async t => {
	const f = await fixture(t);
	let session = f.ctx.sessionManager as SessionManager;
	const firstUser = session.appendMessage({ role: "user", content: "Earlier investigation", timestamp: 1 });
	f.records = [{ id: "lesson", memory: "Verified lesson", score: 0.8, metadata: { repo_id: f.scope.repoId, status: "active", verified_commit: f.scope.commit, evidence_paths: ["proof.ts"] } }];
	const before = await f.before("Fix task");
	assert.match(f.query, /Earlier investigation[\s\S]*Fix task/);
	assert.equal(f.handlers.has("context"), false, "no request-local transcript rewriting");
	assert.equal(session.buildSessionContext().messages.length, 1, "before hook returns message rather than inserting ahead of prompt");
	session.appendMessage({ role: "user", content: "Fix task", timestamp: 2 });
	const snapshot = before.message;
	session.appendCustomMessageEntry(snapshot.customType, snapshot.content, snapshot.display, snapshot.details);
	const prefix = structuredClone(session.buildSessionContext().messages);
	const assistant: any = { role: "assistant", content: [{ type: "thinking", thinking: "reason", thinkingSignature: "signature" }, { type: "toolCall", id: "read-1", name: "read", arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "toolUse", timestamp: 3, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	session.appendMessage(assistant);
	session.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 4 });
	session.appendMessage({ role: "user", content: "Steer task", timestamp: 5 });
	assert.deepEqual(session.buildSessionContext().messages.slice(0, prefix.length), prefix);
	assert.equal(f.searches, 1, "tools and steer cause no extra bootstrap or notices");
	const wired = convertToLlm(session.buildSessionContext().messages);
	assert.deepEqual(wired.find(message => message.role === "assistant"), assistant);
	assert.equal(await f.before("Next task"), undefined, "identical visible evidence is not repeated");
	session.appendMessage({ role: "user", content: "Next task", timestamp: 6 });
	const full = session.buildSessionContext().messages;
	session = SessionManager.open(session.getSessionFile()!);
	f.ctx.sessionManager = session;
	await f.handlers.get("session_start")({}, f.ctx);
	assert.deepEqual(session.buildSessionContext().messages, full, "Pi restores persisted snapshot without extension replay");
	assert.equal(await f.before("Next task"), undefined, "reload dedup reads canonical context");
	const leaf = session.getLeafId()!;
	session.branch(firstUser);
	assert.ok(await f.before("Alternate task"), "abandoned branch snapshot cannot suppress recall");
	session.branch(leaf);
	session.appendCompaction("Task summary", null, 1000);
	assert.ok(!session.buildSessionContext().messages.some((message: any) => message.customType === "pibox-memory"));
	assert.ok(await f.before("Resume task"), "normal compaction permits fresh evidence retrieval");
	assert.deepEqual(f.notices, Array(3).fill("Memory recalled: 1 records."));
	const compactedPrefix = structuredClone(session.buildSessionContext().messages);
	f.records[0]!.memory = "Updated verified lesson";
	const changed = await f.before("Changed task");
	session.appendMessage({ role: "user", content: "Changed task", timestamp: 7 });
	session.appendCustomMessageEntry(changed.message.customType, changed.message.content, changed.message.display, changed.message.details);
	assert.deepEqual(session.buildSessionContext().messages.slice(0, compactedPrefix.length), compactedPrefix);
	assert.match((session.buildSessionContext().messages.at(-1) as any).content, /Updated verified lesson/);
});

test("approved update revalidates code and preserves unrelated metadata; user updates need new conversation proof", async t => {
	const f = await fixture(t);
	await f.call({ action: "remember", memory: "Code lesson", type: "lesson", evidencePaths: ["proof.ts"] });
	const record = f.records[0]!;
	record.metadata!.custom = "keep";
	t.mock.method(Mem0Client.prototype, "get", async () => record);
	let updated: any;
	t.mock.method(Mem0Client.prototype, "update", async (_id: string, _memory: string, metadata: any) => { updated = metadata; });
	await f.call({ action: "update", id: record.id, memory: "Corrected lesson" });
	assert.equal(updated.custom, "keep");
	assert.equal(updated.type, "lesson");
	assert.deepEqual(updated.evidence_paths, ["proof.ts"]);
	await writeFile(join(f.root, "proof.ts"), "changed\n");
	await assert.rejects(f.call({ action: "update", id: record.id, memory: "Unverified update" }), /changed/);
	f.ctx.sessionManager.appendMessage({ role: "user", content: "Prefer offline tests", timestamp: 1 });
	await f.call({ action: "update", id: record.id, memory: "Prefer offline tests", conversationQuote: "Prefer offline tests" });
	assert.equal(updated.source_kind, "conversation");
	assert.equal(updated.verified_commit, undefined);
	assert.deepEqual(updated.evidence_paths, []);
	record.metadata = updated;
	await assert.rejects(f.call({ action: "update", id: record.id, memory: "Unproven new preference" }), /no evidence/);
});
