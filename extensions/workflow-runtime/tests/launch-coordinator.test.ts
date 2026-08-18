import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";

test("launches a direct child through the registry with file-backed process output", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-coordinator-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-1", 16, 1);
	await registry.initialize("main:session-1");
	let effectiveSystemPrompt = "";
	let started: { id: string; model: string; effort: string } | undefined;
	const progressUpdates: number[] = [];
	const coordinator = new LaunchCoordinator(registry, "main:session-1");
	const fake = join(root, "fake-child.mjs");
	await writeFile(fake, [
		`console.log(JSON.stringify({type:"tool_execution_start",toolName:"grep",args:{pattern:"private"}}));`,
		`console.log(JSON.stringify({type:"tool_execution_end",toolName:"grep",isError:false}));`,
		`console.log(JSON.stringify({type:"turn_end",message:{usage:{output:1234,reasoning:42,totalTokens:9000}}}));`,
		`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"mapped repository"}]}}));`,
		`console.log(JSON.stringify({type:"agent_settled"}));`,
	].join("\n"));

	const launched = await coordinator.launch({
		operationId: "direct-1",
		role: "explorer",
		task: "Map it",
		assignment: { mode: "map", question: "Map it" },
		cwd: root,
		provider: "test",
		model: "fake",
		effort: "low",
		tools: [],
		agentPrompt: "Agent instructions.",
		additionalPrompt: "Workflow protocol.",
		persistentContext: "Persistent canonical context.",
		onStarted: (agent) => { started = { id: agent.id, model: agent.model, effort: agent.effort }; },
		onProgress: (progress) => progressUpdates.push(progress.outputTokens),
		invocationResolver: (args) => {
			const promptIndex = args.indexOf("--append-system-prompt");
			effectiveSystemPrompt = readFileSync(args[promptIndex + 1]!, "utf8");
			return { command: process.execPath, args: [fake] };
		},
	});

	assert.equal(launched.result.text, "mapped repository");
	assert.deepEqual(started, { id: launched.agent.id, model: "fake", effort: "low" });
	assert.match(effectiveSystemPrompt, /Agent instructions\.[\s\S]+Workflow protocol\.[\s\S]+Persistent canonical context\./);
	assert.equal(launched.agent.state, "completed");
	assert.equal(await registry.activeCount(), 0);
	const record = await registry.get(launched.agent.id);
	assert.equal(record.attempts.length, 1);
	assert.equal(record.attempts[0]?.exitCode, 0);
	assert.equal(record.attempts[0]?.progress?.turns, 1);
	assert.equal(record.attempts[0]?.progress?.toolCalls, 1);
	assert.equal(record.attempts[0]?.progress?.outputTokens, 1234);
	assert.ok(record.attempts[0]?.progress?.processStartedAt);
	assert.ok(record.attempts[0]?.progress?.processExitedAt);
	assert.ok(record.attempts[0]?.progress?.settledAt);
	assert.ok(progressUpdates.includes(1234));
	const attemptRoot = join(registry.root, "agents", record.id, "attempts", record.attempts[0]!.id);
	await access(join(attemptRoot, "stdout.jsonl"));
	assert.match(await readFile(join(attemptRoot, "stdout.jsonl"), "utf8"), /mapped repository/);
});

test("treats a terminal assistant error as failure when Pi exits zero", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-assistant-error-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-error");
	await registry.initialize("main:session-error");
	const fake = join(root, "fake-error.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"provider rejected effort"}}));\n`);
	const coordinator = new LaunchCoordinator(registry, "main:session-error", () => ({ command: process.execPath, args: [fake] }));
	const launched = await coordinator.launch({ operationId: "assistant-error", role: "explorer", task: "Try", assignment: {}, cwd: root, provider: "local-llm", model: "local", effort: "medium", tools: [] });
	assert.equal(launched.result.exitCode, 1);
	assert.match(launched.result.stderr, /provider rejected effort/);
	assert.equal(launched.agent.state, "failed");
	assert.equal(launched.agent.attempts[0]?.exitCode, 1);
});

test("resumes a waiting assignment as another process attempt under the same slot and Pi session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-resume-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-1", 1, 1);
	await registry.initialize("main:session-1");
	const original = await registry.reserve({ operationId: "task-original", parentAgentId: "main:session-1", parentDepth: 0, role: "implementer", provider: "test", model: "fake", effort: "low", assignment: { task: "one" }, taskId: "task-1", runId: "run-1" });
	const first = await registry.startAttempt(original.id);
	await registry.markRunning(original.id, first.attempt.id, 111);
	await registry.recordExit(original.id, first.attempt.id, 0);
	await registry.recordMessage(original.id, { operationId: "message-1", type: "change_request", blocking: true, summary: "Need a choice", rationale: "Contract ambiguity", evidence: [] });
	const fake = join(root, "fake-resume.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"resumed"}]}}));\n`);
	let sessionFile = "";
	const coordinator = new LaunchCoordinator(registry, "main:session-1", (args) => { sessionFile = args[args.indexOf("--session") + 1] ?? ""; return { command: process.execPath, args: [fake] }; });
	const resumed = await coordinator.launch({ operationId: "run-2", existingAgentId: original.id, role: "implementer", task: "Resume", assignment: { task: "one" }, cwd: root, provider: "test", model: "fake", effort: "low", tools: [], taskId: "task-1", runId: "run-2" });
	assert.equal(resumed.agent.id, original.id);
	assert.equal(resumed.agent.attempts.length, 2);
	assert.equal(resumed.agent.runId, "run-2");
	assert.equal(sessionFile, join(registry.root, "agents", original.id, "pi-session.jsonl"));
	assert.equal(await registry.activeCount(), 0);
});

test("falls back through ordered routes without changing logical agent or Pi session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-fallback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-fallback");
	await registry.initialize("main:session-fallback");
	const limited = join(root, "limited.mjs");
	const success = join(root, "success.mjs");
	await writeFile(limited, `console.error('HTTP 429 Retry-After: 1'); process.exit(1);\n`);
	await writeFile(success, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}]}}));\n`);
	const { ProviderCooldowns } = await import("../../provider-fallback/index.js");
	const seen: string[] = [];
	const updates: string[] = [];
	const sessions: string[] = [];
	const coordinator = new LaunchCoordinator(registry, "main:session-fallback", (args) => {
		const route = args[args.indexOf("--model") + 1]!;
		seen.push(route);
		sessions.push(args[args.indexOf("--session") + 1]!);
		return { command: process.execPath, args: [route === "bad/one" ? limited : success] };
	}, [], new ProviderCooldowns());
	const result = await coordinator.launch({ operationId: "fallback", role: "explorer", task: "try", assignment: {}, cwd: root, provider: "bad", model: "one", effort: "low", activity: { kind: "review", generation: 0 }, providerCandidates: [{ provider: "bad", model: "one", effort: "low" }, { provider: "good", model: "two", effort: "low" }], tools: [], onText: (text) => updates.push(text) });
	assert.equal(result.result.text, "ok");
	assert.deepEqual(seen, ["bad/one", "good/two"]);
	assert.deepEqual(updates, ["ok"]);
	assert.equal(new Set(sessions).size, 1);
	assert.equal(result.agent.provider, "good");
	assert.equal(result.agent.attempts.length, 2);
	assert.deepEqual(result.agent.attempts.map((attempt) => attempt.activity), [
		{ kind: "review", generation: 0 },
		{ kind: "review", generation: 0 },
	]);
});

test("does not fallback non-provider failures", async (t) => {
 const root = await mkdtemp(join(tmpdir(), "pibox-launch-no-fallback-")); t.after(() => rm(root, { recursive: true, force: true }));
 const registry = new SessionAgentRegistry(root, "session-no-fallback"); await registry.initialize("main:session-no-fallback");
 const fake = join(root, "protocol.mjs"); await writeFile(fake, `console.error('protocol tool failure'); process.exit(1);\n`); let calls = 0;
 const coordinator = new LaunchCoordinator(registry, "main:session-no-fallback", () => { calls += 1; return { command: process.execPath, args: [fake] }; });
 const result = await coordinator.launch({ operationId: "no-fallback", role: "explorer", task: "try", assignment: {}, cwd: root, provider: "one", model: "one", effort: "low", providerCandidates: [{ provider: "one", model: "one", effort: "low" }, { provider: "two", model: "two", effort: "low" }], tools: [] });
 assert.equal(calls, 1); assert.equal(result.agent.state, "failed");
});
