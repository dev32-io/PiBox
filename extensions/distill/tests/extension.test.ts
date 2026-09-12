import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Check } from "typebox/value";
import distillExtension, { gitRunnerFor } from "../index.js";
import { DISTILL_KNOWLEDGE_DISCOVERY_EVENT } from "../provider.js";

const exec = promisify(execFile);

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
	assert.deepEqual([...h.tools.keys()], ["distill_prepare", "distill_collect", "distill_read", "distill_record", "distill_compare", "distill_instruction_check"]);
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
	const instruction = h.tools.get("distill_instruction_check").parameters;
	assert.equal(Check(instruction, { candidate: "x".repeat(2_001), destination: "agents", targetPath: "AGENTS.md", paths: Array(51).fill("src/**"), evidencePaths: Array(21).fill("src/a.ts"), criticality: "x", nonObviousness: "x", repeatedApplicability: "x", failureImpact: "x" }), true);
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
	const runId = "distill-abcdef1234567890"; const runRoot = join(root, ".pibox", "distill", runId); await mkdir(runRoot, { recursive: true });
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

test("the /distill command enters the skill with the user's natural-language scope", async () => {
	const h = harness();
	await h.commands.get("distill").handler("what changed since v1.0 for failure modes", {});
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0] ?? "", /what changed since v1\.0 for failure modes/);
	assert.match(h.sent[0] ?? "", /Do not call `distill_collect` until the user confirms/);
	assert.match(h.sent[0] ?? "", /example, explanation, history, summary, descriptive fact/);
});
