import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Check } from "typebox/value";
import distillExtension, { distillStoreRoot, gitRunnerFor } from "../index.js";
import { discoverRepository } from "../../workflow/repository.js";
import { createSessionScratchWorkspace, purgeSessionScratchWorkspace } from "../../session-scratch/workspace.js";
import { SESSION_SCRATCH_ENTRY_TYPE } from "../../session-scratch/binding.js";
import { DISTILL_KNOWLEDGE_DISCOVERY_EVENT } from "../provider.js";

const exec = promisify(execFile);

async function isolatedAgentDir(t: test.TestContext): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "pibox-distill-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	});
	return agentDir;
}

function harness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const sent: string[] = [];
	const bus = new Map<string, Array<(value: unknown) => void>>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		async exec(command: string, args: string[], options: any) { const response = await exec(command, args, { cwd: options.cwd, encoding: "utf8" }); return { code: 0, stdout: response.stdout, stderr: response.stderr }; },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { handlers.set(name, handler); },
		sendUserMessage(content: string) { sent.push(content); },
		events: {
			on(name: string, handler: (value: unknown) => void) { const list = bus.get(name) ?? []; list.push(handler); bus.set(name, list); },
			emit(name: string, value: unknown) { for (const handler of bus.get(name) ?? []) handler(value); },
		},
	} as any;
	distillExtension(pi);
	return { tools, commands, handlers, sent, pi };
}

test("registers the backend-independent distillation surface", () => {
	const h = harness();
	assert.deepEqual([...h.tools.keys()], ["distill_prepare", "distill_collect", "distill_read", "distill_record", "distill_compare"]);
	assert.equal(h.commands.has("distill"), true);
	assert.deepEqual([...h.handlers.keys()], ["session_start", "session_shutdown"]);
});

test("tool schemas admit formerly capped valid scope and content while retaining exact tokens and enums", () => {
	const h = harness();
	const prepare = h.tools.get("distill_prepare").parameters;
	assert.equal(Check(prepare, {
		target: "x".repeat(241), paths: Array.from({ length: 51 }, (_, index) => `path-${index}`), workItems: Array.from({ length: 21 }, (_, index) => `work-${index}`),
		sessionIds: Array.from({ length: 21 }, (_, index) => `session-${index}`), knowledgeProviders: Array.from({ length: 9 }, (_, index) => `provider-${index}`), focus: Array(9).fill("knowledge"),
	}), true);
	assert.equal(Check(prepare, { focus: ["not-a-focus"] }), false, "finite focus semantics remain enforced");
	const collect = h.tools.get("distill_collect").parameters;
	assert.equal(Check(collect, { previewToken: "a".repeat(64) }), true);
	assert.equal(Check(collect, { previewToken: "a".repeat(63) }), false, "preview tokens remain exact hashes");
	const record = h.tools.get("distill_record").parameters;
	assert.equal(Check(record, { runId: "distill-abcdef1234567890", category: "synthesis", content: "x".repeat(120_001) }), true);
});

test("production Git stdin handles early rejection of a large input without an unhandled pipe error", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-distill-git-stdin-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-b", "develop"], { cwd: root, encoding: "utf8" });
	const runner = gitRunnerFor({ exec() { throw new Error("stdin runs must use the streaming Git path"); } } as any, root);
	const response = await runner(["rev-list", "--stdin"], { stdin: `invalid-first-revision\n${"x".repeat(20 * 1024 * 1024)}\n` });
	assert.notEqual(response.code, 0);
	assert.match(response.stderr, /bad revision|ambiguous argument|unknown revision/i);
});

test("collection still requires a prepared exact preview token", async () => {
	const h = harness();
	await assert.rejects(h.tools.get("distill_collect").execute("collect", { previewToken: "a".repeat(64) }, undefined, undefined, {}), /Unknown or expired distillation preview/);
});

test("large immutable sources remain pageable and large records persist intact", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-distill-extension-")); t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-b", "develop"], { cwd: root, encoding: "utf8" }); await exec("git", ["config", "user.email", "test@example.com"], { cwd: root, encoding: "utf8" }); await exec("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" });
	const source = `${"large source text ".repeat(10_000)}SOURCE-END`; await writeFile(join(root, "large.txt"), source); await exec("git", ["add", "."], { cwd: root, encoding: "utf8" }); await exec("git", ["commit", "-m", "large source"], { cwd: root, encoding: "utf8" });
	const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
	await isolatedAgentDir(t);
	const runId = "distill-abcdef1234567890"; const runRoot = join(distillStoreRoot((await discoverRepository(root)).id), "distill", runId); await mkdir(runRoot, { recursive: true });
	await writeFile(join(runRoot, "manifest.json"), "{}\n"); await writeFile(join(runRoot, "scope.json"), `${JSON.stringify({ target: { commit } })}\n`);
	const h = harness(); const ctx = { cwd: root, sessionManager: {} } as any;
	const first = await h.tools.get("distill_read").execute("read", { runId, sourcePath: "large.txt", offset: 0, limit: 30_000 }, undefined, undefined, ctx);
	assert.equal(first.details.total, source.length); assert.equal(first.details.returned, 30_000); assert.equal(first.details.nextOffset, 30_000);
	const end = await h.tools.get("distill_read").execute("read", { runId, sourcePath: "large.txt", offset: source.length - 20, limit: 30_000 }, undefined, undefined, ctx);
	assert.match(end.content[0].text, /SOURCE-END/); assert.equal(end.details.nextOffset, null);
	const record = `${"complete record text ".repeat(7_000)}RECORD-END`; const recorded = await h.tools.get("distill_record").execute("record", { runId, category: "synthesis", content: record }, undefined, undefined, ctx);
	assert.equal(recorded.details.chars, record.length); assert.equal(recorded.details.inputChars, record.length); assert.equal(await readFile(join(runRoot, "synthesis.md"), "utf8"), record);
	const comparisonContent = `${"authoritative comparison ".repeat(6_000)}COMPARISON-END`; const evidence = Array.from({ length: 21 }, (_, index) => `evidence/path-${index}.md`);
	await writeFile(join(runRoot, "scope.json"), `${JSON.stringify({ target: { commit }, knowledgeProviders: ["test-provider"], knowledgeProviderFingerprint: [{ id: "test-provider", locality: "local" }] })}\n`);
	h.pi.events.on(DISTILL_KNOWLEDGE_DISCOVERY_EVENT, ({ register }: any) => register({ id: "test-provider", locality: "local", description: "Synthetic provider", async search() { return [{ provider: "ignored", id: "item", kind: "finding", content: comparisonContent, evidence }]; } }));
	const compared = await h.tools.get("distill_compare").execute("compare", { runId, claims: [{ id: "claim", query: "complete comparison" }], limitPerProvider: 1 }, undefined, undefined, ctx);
	assert.equal(compared.details.comparisons[0].providers["test-provider"][0].content, comparisonContent); assert.deepEqual(compared.details.comparisons[0].providers["test-provider"][0].evidence, evidence);
	assert.match(await readFile(join(runRoot, "comparisons", "providers.json"), "utf8"), /COMPARISON-END/);
});

test("collection stores runs outside the repository without an ignore rule and captures session scratch", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-distill-store-")); t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = await isolatedAgentDir(t);
	const git = (...args: string[]) => exec("git", args, { cwd: root, encoding: "utf8" });
	await git("init", "-b", "develop"); await git("config", "user.email", "test@example.com"); await git("config", "user.name", "Test");
	await writeFile(join(root, "app.ts"), "export const v = 1;\n"); await git("add", "."); await git("commit", "-m", "base");
	await writeFile(join(root, "app.ts"), "export const v = 2;\n"); await git("commit", "-am", "change");
	const workspace = await createSessionScratchWorkspace("current-session"); t.after(() => purgeSessionScratchWorkspace(workspace.binding));
	await writeFile(workspace.paths.ledger, "# Ledger\n\nSCRATCH-LEDGER-FINDING\n");
	await writeFile(join(workspace.paths.results, "report.md"), "result body\n");
	const branch = [
		{ type: "custom", id: "s1", customType: SESSION_SCRATCH_ENTRY_TYPE, data: { schemaVersion: 1, binding: workspace.binding } },
		{ type: "message", id: "u1", parentId: "s1", message: { role: "user", content: "hello" } },
	];
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "current-session", getLeafId: () => "u1", getBranch: () => branch } } as any;
	const h = harness();
	const preview = await h.tools.get("distill_prepare").execute("prepare", { target: "HEAD", baseline: "HEAD~1" }, undefined, undefined, ctx);
	assert.deepEqual(preview.details.sessionScratch, [{ sessionId: "current-session", available: true }]);
	const collected = await h.tools.get("distill_collect").execute("collect", { previewToken: preview.details.previewToken }, undefined, undefined, ctx);
	assert.ok(collected.details.runRoot.startsWith(agentDir), "run root is under the agent directory");
	assert.ok(!collected.details.runRoot.startsWith(root), "run root is outside the repository");
	assert.ok(collected.details.files.includes("scratch.md"));
	const scratch = await h.tools.get("distill_read").execute("read", { runId: preview.details.runId, path: "scratch.md" }, undefined, undefined, ctx);
	assert.match(scratch.content[0].text, /SCRATCH-LEDGER-FINDING/);
	assert.match(scratch.content[0].text, /report\.md` \(12 bytes\)/);
});

test("the /distill command enters the skill with the user's natural-language scope", async () => {
	const h = harness();
	await h.commands.get("distill").handler("what changed since v1.0 for failure modes", {});
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0] ?? "", /what changed since v1\.0 for failure modes/);
	assert.match(h.sent[0] ?? "", /Call `distill_collect` only after the user confirms/);
	assert.match(h.sent[0] ?? "", /`rule-writing` skill/);
});
