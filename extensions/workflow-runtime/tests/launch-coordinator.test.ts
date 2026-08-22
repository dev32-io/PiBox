import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";
import { FAST_MODE_CHILD_ENV } from "../../fast-mode/policy.js";
import { resetActiveFastModePolicy, setActiveFastModePolicy } from "../../fast-mode/runtime.js";
import { ALL_TOOLS_SUBAGENT_ENV, SUBAGENT_CONTROL_TOOLS } from "../../workflow/tool-groups.js";

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
	assert.ok(record.attempts[0]?.timing?.processSpawnedAt);
	assert.ok(record.attempts[0]?.timing?.childReadyAt);
	assert.ok(record.attempts[0]?.timing?.firstActivityAt);
	assert.ok(record.attempts[0]?.timing?.firstToolAt);
	assert.ok(record.attempts[0]?.timing?.reportReadyAt);
	assert.ok(record.attempts[0]?.timing?.processExitedAt);
	assert.ok(record.attempts[0]?.timing?.outputDrainedAt);
	assert.ok(record.attempts[0]?.timing?.settledAt);
	assert.ok(progressUpdates.includes(1234));
	const attemptRoot = join(registry.root, "agents", record.id, "attempts", record.attempts[0]!.id);
	await assert.rejects(access(join(attemptRoot, "stdout.jsonl")), /ENOENT/, "successful raw transport is removed after durable completion");
	await assert.rejects(access(join(attemptRoot, "stderr.log")), /ENOENT/);
	const lifecycle = parse(await readFile(registry.snapshotPath, "utf8")) as { eventSequence: number; revision: number };
	assert.equal(lifecycle.eventSequence, lifecycle.revision, "no unjournaled progress rewrites occur during coordinated launch");
	assert.ok(lifecycle.eventSequence <= 6, `expected bounded semantic lifecycle writes, observed ${lifecycle.eventSequence}`);
	await assert.rejects(access(registry.eventsPath), /ENOENT/, "the registry snapshot replaces the redundant agent journal");
});

test("publishes process-start progress only after agent.running is durable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-event-order-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-event-order");
	await registry.initialize("main:session-event-order");
	const fake = join(root, "fast-child.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"turn_end",message:{usage:{output:1}}}));\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}}));`);
	let markCalled!: () => void;
	const markObserved = new Promise<void>((resolve) => { markCalled = resolve; });
	let releaseMark!: () => void;
	const markGate = new Promise<void>((resolve) => { releaseMark = resolve; });
	const durableMarkRunning = registry.markRunning.bind(registry);
	registry.markRunning = async (...args: Parameters<SessionAgentRegistry["markRunning"]>) => {
		markCalled();
		await markGate;
		return durableMarkRunning(...args);
	};
	const processStartPublications: boolean[] = [];
	const launch = new LaunchCoordinator(registry, "main:session-event-order", () => ({ command: process.execPath, args: [fake] })).launch({
		operationId: "event-order", role: "repair-implementer", task: "repair", assignment: {}, cwd: root,
		provider: "test", model: "fake", effort: "low", tools: [],
		onProgress: (progress) => processStartPublications.push(Boolean(progress.processStartedAt)),
	});
	await markObserved;
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(processStartPublications, [false], "volatile progress cannot announce process start before the durable lifecycle event");
	releaseMark();
	const launched = await launch;
	assert.ok(processStartPublications.includes(true), "durable agent.running releases the process-start projection");
	const record = await registry.get(launched.agent.id);
	assert.ok(record.attempts[0]?.timing?.processSpawnedAt);
});

test("high-turn tool activity is summarized with constant durable registry writes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-low-write-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-low-write");
	await registry.initialize("main:session-low-write");
	const fake = join(root, "busy-child.mjs");
	const lines = [
		...Array.from({ length: 129 }, (_, index) => [
			`console.log(JSON.stringify({type:"tool_execution_start",toolName:"tool-${index}"}));`,
			`console.log(JSON.stringify({type:"tool_execution_end",toolName:"tool-${index}",isError:false}));`,
		]).flat(),
		...Array.from({ length: 62 }, () => `console.log(JSON.stringify({type:"turn_end",message:{usage:{input:10,output:20,reasoning:5,totalTokens:100}}}));`),
		`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}}));`,
		`console.log(JSON.stringify({type:"agent_settled"}));`,
	];
	await writeFile(fake, lines.join("\n"));
	const launched = await new LaunchCoordinator(registry, "main:session-low-write", () => ({ command: process.execPath, args: [fake] })).launch({
		operationId: "busy", role: "implementer", task: "work", assignment: {}, cwd: root,
		provider: "test", model: "fake", effort: "low", tools: [],
	});
	const attempt = (await registry.get(launched.agent.id)).attempts[0]!;
	assert.equal(attempt.progress?.turns, 62);
	assert.equal(attempt.progress?.toolCalls, 129);
	assert.equal(attempt.progress?.inputTokens, 620);
	assert.equal(attempt.progress?.outputTokens, 1240);
	const lifecycle = parse(await readFile(registry.snapshotPath, "utf8")) as { eventSequence: number; revision: number };
	assert.equal(lifecycle.eventSequence, lifecycle.revision);
	assert.ok(lifecycle.eventSequence <= 6, `activity volume must not affect durable write count; observed ${lifecycle.eventSequence}`);
	await assert.rejects(access(registry.eventsPath), /ENOENT/);
});

test("exceptional launch paths settle the current attempt before failing the logical agent", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-exception-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-launch-exception");
	await registry.initialize("main:session-launch-exception");
	const coordinator = new LaunchCoordinator(registry, "main:session-launch-exception", () => { throw new Error("resolver exploded"); });
	await assert.rejects(coordinator.launch({ operationId: "explode", role: "implementer", task: "fail", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: [] }), /resolver exploded/);
	const [agent] = await registry.list();
	assert.equal(agent?.state, "failed");
	assert.equal(agent?.attempts[0]?.state, "failed");
	assert.equal(agent?.attempts[0]?.exitCode, 1);
	assert.ok(agent?.attempts[0]?.timing?.processExitedAt);
	assert.ok(agent?.attempts[0]?.timing?.settledAt);
});

test("failed attempt transport is retained as bounded diagnostics", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-bounded-failure-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-bounded-failure");
	await registry.initialize("main:session-bounded-failure");
	const fake = join(root, "noisy-failure.mjs");
	await writeFile(fake, `console.error("x".repeat(100000)); process.exit(1);\n`);
	const launched = await new LaunchCoordinator(registry, "main:session-bounded-failure", () => ({ command: process.execPath, args: [fake] })).launch({
		operationId: "noisy", role: "implementer", task: "fail", assignment: {}, cwd: root,
		provider: "test", model: "fake", effort: "low", tools: [],
	});
	assert.equal(launched.agent.state, "failed");
	const attempt = launched.agent.attempts[0]!;
	const attemptRoot = join(registry.root, "agents", launched.agent.id, "attempts", attempt.id);
	assert.ok((await stat(join(attemptRoot, "stderr.log"))).size <= 64 * 1024);
	assert.ok(launched.result.stderr.length <= 64 * 1024);
});

test("wildcard tool unions enable all child tools except recursive subagent controls", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-all-tools-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-all-tools");
	await registry.initialize("main:session-all-tools");
	const fake = join(root, "all-tools.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:process.env.${ALL_TOOLS_SUBAGENT_ENV} ?? "missing"}]}}));\n`);
	let childArgs: string[] = [];
	const coordinator = new LaunchCoordinator(registry, "main:session-all-tools", (args) => {
		childArgs = args;
		return { command: process.execPath, args: [fake] };
	});
	const launched = await coordinator.launch({
		operationId: "all-tools", role: "general-purpose", task: "Research", assignment: {}, cwd: root,
		provider: "test", model: "fake", effort: "low", tools: ["*", "read"], agentPrompt: "Work directly.",
	});
	assert.equal(launched.result.text, "1");
	assert.equal(childArgs.includes("--tools"), false);
	assert.equal(childArgs[childArgs.indexOf("--exclude-tools") + 1], SUBAGENT_CONTROL_TOOLS.join(","));
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

test("retries an explicitly prepared failed agent in the same Pi session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-failed-retry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-retry");
	await registry.initialize("main:session-retry");
	const failure = join(root, "failure.mjs");
	const success = join(root, "success.mjs");
	await writeFile(failure, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"provider rejected turn"}}));\n`);
	await writeFile(success, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"continued repair"}]}}));\n`);
	const first = await new LaunchCoordinator(registry, "main:session-retry", () => ({ command: process.execPath, args: [failure] })).launch({ operationId: "repair-1", role: "repair-implementer", task: "Repair", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: [] });
	assert.equal(first.agent.state, "failed");
	await registry.prepareRetry(first.agent.id);
	let sessionFile = "";
	const second = await new LaunchCoordinator(registry, "main:session-retry", (args) => { sessionFile = args[args.indexOf("--session") + 1] ?? ""; return { command: process.execPath, args: [success] }; }).launch({ operationId: "repair-1:retry:1", existingAgentId: first.agent.id, role: "repair-implementer", task: "Continue", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: [] });
	assert.equal(second.agent.id, first.agent.id);
	assert.equal(second.agent.attempts.length, 2);
	assert.equal(second.result.text, "continued repair");
	assert.equal(sessionFile, join(registry.root, "agents", first.agent.id, "pi-session.jsonl"));
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
	t.after(async () => { resetActiveFastModePolicy(); await rm(root, { recursive: true, force: true }); });
	setActiveFastModePolicy({ main: false, subagents: "max" });
	const registry = new SessionAgentRegistry(root, "session-fallback");
	await registry.initialize("main:session-fallback");
	const limited = join(root, "limited.mjs");
	const success = join(root, "success.mjs");
	await writeFile(limited, `console.error('HTTP 429 Retry-After: 1'); process.exit(1);\n`);
	await writeFile(success, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok:' + process.env.${FAST_MODE_CHILD_ENV}}]}}));\n`);
	const { ProviderCooldowns } = await import("../../provider-fallback/index.js");
	const seen: string[] = [];
	const updates: string[] = [];
	const sessions: string[] = [];
	const coordinator = new LaunchCoordinator(registry, "main:session-fallback", (args) => {
		const route = args[args.indexOf("--model") + 1]!;
		seen.push(route);
		sessions.push(args[args.indexOf("--session") + 1]!);
		return { command: process.execPath, args: [route === "openai-codex/gpt-5.6-luna" ? limited : success] };
	}, [], new ProviderCooldowns());
	const result = await coordinator.launch({ operationId: "fallback", role: "explorer", task: "try", assignment: {}, cwd: root, provider: "openai-codex", model: "gpt-5.6-luna", effort: "low", capabilityTier: "low", activity: { kind: "review", generation: 0 }, providerCandidates: [{ provider: "openai-codex", model: "gpt-5.6-luna", effort: "low" }, { provider: "ollama-cloud", model: "deepseek-v4-flash", effort: "low" }], tools: [], onText: (text) => updates.push(text) });
	assert.equal(result.result.text, "ok:0");
	assert.deepEqual(seen, ["openai-codex/gpt-5.6-luna", "ollama-cloud/deepseek-v4-flash"]);
	assert.deepEqual(updates, ["ok:0"]);
	assert.equal(new Set(sessions).size, 1);
	assert.equal(result.agent.provider, "ollama-cloud");
	assert.equal(result.agent.attempts.length, 2);
	assert.deepEqual(result.agent.attempts.map((attempt) => attempt.fast), [true, false], "fallback recomputes effective Fast mode per resolved route");
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

test("passes only the tier-filtered Fast decision to each child process", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-launch-fast-mode-"));
	t.after(async () => { resetActiveFastModePolicy(); await rm(root, { recursive: true, force: true }); });
	setActiveFastModePolicy({ main: false, subagents: "medium" });
	const registry = new SessionAgentRegistry(root, "session-fast");
	await registry.initialize("main:session-fast");
	const fake = join(root, "fast-env.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:process.env.${FAST_MODE_CHILD_ENV} ?? "missing"}]}}));\n`);
	const coordinator = new LaunchCoordinator(registry, "main:session-fast", () => ({ command: process.execPath, args: [fake] }));
	const low = await coordinator.launch({ operationId: "fast-low", role: "explorer", task: "low", assignment: {}, cwd: root, provider: "openai-codex", model: "gpt-5.6-luna", effort: "low", capabilityTier: "low", tools: [] });
	const high = await coordinator.launch({ operationId: "fast-high", role: "explorer", task: "high", assignment: {}, cwd: root, provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", capabilityTier: "high", tools: [] });
	assert.equal(low.result.text, "1");
	assert.equal(low.agent.attempts[0]?.fast, true);
	assert.equal(high.result.text, "0");
	assert.equal(high.agent.attempts[0]?.fast, false);
});

test("post-repair CI feedback reuses the reported integration worker and Pi session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-integration-worker-loop-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-integration-loop");
	await registry.initialize("main:session-integration-loop");
	const fake = join(root, "repair.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"repair submitted"}]}}));\n`);
	const sessions: string[] = [];
	const coordinator = new LaunchCoordinator(registry, "main:session-integration-loop", (args) => {
		sessions.push(args[args.indexOf("--session") + 1]!);
		return { command: process.execPath, args: [fake] };
	});
	const first = await coordinator.launch({ operationId: "integration-repair:story:stage", role: "repair-implementer", task: "Resolve conflict", assignment: { generation: 1 }, cwd: root, provider: "test", model: "fake", effort: "low", tools: [], deferCompletion: true, workItemId: "story", workspace: root });
	assert.equal(first.agent.state, "reported");
	const second = await coordinator.launch({ operationId: "integration-repair:story:stage", existingAgentId: first.agent.id, role: "repair-implementer", task: "Post-repair CI failed; continue", assignment: { generation: 2 }, cwd: root, provider: "test", model: "fake", effort: "low", tools: [], deferCompletion: true, workItemId: "story", workspace: root });
	assert.equal(second.agent.id, first.agent.id);
	assert.equal(second.agent.state, "reported");
	assert.equal(second.agent.attempts.length, 2);
	assert.equal(new Set(sessions).size, 1);
	assert.equal(sessions[0], join(registry.root, "agents", first.agent.id, "pi-session.jsonl"));
});
