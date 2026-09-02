import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
	LIFETIME_WRAPPER_PATH,
	SubagentProcessManager,
	createPiInvocationResolver,
	stableSystemPromptPath,
	type RuntimeOwner,
	type SubagentInvocationRequest,
} from "../index.js";

const FAKE_CHILD = resolve("extensions/subagent/tests/support/fake-child.mjs");
const EXECUTION = {
	provider: "test-provider",
	model: "test-model",
	effort: "high",
	tools: ["read", "grep"],
	extensionPaths: ["/configured/extension.ts"],
	skillPaths: ["/configured/skill"],
	fast: true,
	env: { STABLE_ENV: "stable" },
	workflowCredentials: { WORKFLOW_CREDENTIAL: "secret" },
	workflowMetadata: { WORKFLOW_REF: "work-item:test" },
} as const;

function owner(overrides: Partial<RuntimeOwner> = {}): RuntimeOwner {
	return { sessionId: "session-process", processInstanceId: "process-process", activationId: "activation-process", ...overrides };
}

async function fixture(t: TestContext, options: { terminationGraceMs?: number; signalLog?: string; maximumStderrBytes?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-manager-"));
	const sessionDirectory = join(root, "private-sessions");
	const invocations: SubagentInvocationRequest[] = [];
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory,
		terminationGraceMs: options.terminationGraceMs ?? 100,
		...(options.maximumStderrBytes ? { maximumStderrBytes: options.maximumStderrBytes } : {}),
		invocationResolver(request) {
			invocations.push(request);
			return {
				command: process.execPath,
				args: [FAKE_CHILD, request.agent],
				env: {
					FAKE_PROMPT: request.attemptUserPrompt,
					FAKE_TRANSCRIPT: request.transcriptPath,
					...(options.signalLog ? { FAKE_SIGNAL_LOG: options.signalLog } : {}),
				},
			};
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });
	return { manager, root, sessionDirectory, invocations };
}

function launch(manager: SubagentProcessManager, agent: string, prompt = "first prompt") {
	return manager.launch({ owner: owner(), agent, cwd: process.cwd(), stableSystemContext: "stable agent contract", attemptUserPrompt: prompt, continuationKey: "stable-config", ...EXECUTION });
}

async function eventTypes(manager: SubagentProcessManager): Promise<string[]> {
	return manager.replay(owner(), 0).events.map((event) => event.type);
}

test("successful bounded process uses a private transcript and settles from its final message", async (t) => {
	const { manager, sessionDirectory, invocations } = await fixture(t);
	const started = await launch(manager, "success");
	const result = await started.result;
	assert.equal(result.status, "completed");
	assert.equal(result.exitCode, 0);
	assert.equal(result.text, "final answer");
	assert.equal(result.handle.continuationCapability, started.handle.continuationCapability);
	assert.equal(invocations.length, 1);
	assert.equal(dirname(invocations[0]!.transcriptPath), sessionDirectory);
	assert.equal(invocations[0]!.continuation, false);
	assert.match(await readFile(invocations[0]!.transcriptPath, "utf8"), /first prompt/);
	assert.deepEqual(await eventTypes(manager), [
		"attempt_started", "message_delta", "final_message", "process_exited", "output_drained", "terminal",
	]);
	const replay = manager.replay(owner(), 0);
	assert.equal(replay.snapshot.cursor, 0, "cursor-zero replay starts from the initial snapshot");
	const latest = manager.replay(owner());
	assert.equal(latest.snapshot.agents[0]?.state, "completed");
	assert.equal(latest.snapshot.agents[0]?.summary, "final answer");
	assert.equal(latest.snapshot.agents[0]?.continuationKey, "stable-config");
	assert.deepEqual(manager.inspect(owner(), { workflowMetadata: { WORKFLOW_REF: "work-item:test" } }).map((agent) => agent.handle.agentId), [started.handle.agentId]);
	assert.equal((await manager.wait(owner(), result.handle)).text, "final answer");
});

test("release deletes a settled child transcript and retained diagnostics", async (t) => {
	const { manager, invocations } = await fixture(t);
	const started = await launch(manager, "success");
	const terminal = await started.result;
	const transcript = invocations[0]!.transcriptPath;
	await manager.release(owner(), terminal.handle);
	await assert.rejects(access(transcript), /ENOENT/);
	assert.equal(manager.inspect(owner()).length, 0);
	await assert.rejects(manager.wait(owner(), terminal.handle), /Unknown|stale/);
});

test("failure diagnostics remain byte-bounded until explicit release", async (t) => {
	const { manager } = await fixture(t, { maximumStderrBytes: 128 });
	const terminal = await (await launch(manager, "noisy-error")).result;
	assert.equal(terminal.status, "failed");
	assert.ok(Buffer.byteLength(terminal.stderr ?? "", "utf8") <= 128);
	await manager.release(owner(), terminal.handle);
});

test("normalizes bounded tool activity and cache-aware usage into snapshots and terminal results", async (t) => {
	const { manager } = await fixture(t);
	const terminal = await (await launch(manager, "progress")).result;
	assert.equal(terminal.status, "completed");
	assert.deepEqual(await eventTypes(manager), [
		"attempt_started", "tool_activity", "tool_activity", "usage", "final_message", "process_exited", "output_drained", "terminal",
	]);
	assert.deepEqual({
		turns: terminal.progress?.turns,
		toolCalls: terminal.progress?.toolCalls,
		activeTool: terminal.progress?.activeTool,
		input: terminal.progress?.inputTokens,
		output: terminal.progress?.outputTokens,
		cacheRead: terminal.progress?.cacheReadTokens,
		cacheWrite: terminal.progress?.cacheWriteTokens,
		context: terminal.progress?.contextTokens,
	}, { turns: 1, toolCalls: 1, activeTool: undefined, input: 100, output: 25, cacheRead: 40, cacheWrite: 10, context: 180 });
	const snapshot = manager.replay(owner()).snapshot.agents[0];
	assert.equal(snapshot?.provider, "test-provider");
	assert.equal(snapshot?.model, "test-model");
	assert.equal(snapshot?.progress?.processExitedAt !== undefined, true);
});

test("the last final assistant message is authoritative over deltas and earlier finals", async (t) => {
	const { manager } = await fixture(t);
	const result = await (await launch(manager, "authoritative")).result;
	assert.equal(result.text, "authoritative final");
	const finalEvents = manager.replay(owner(), 0).events.filter((event) => event.type === "final_message");
	assert.deepEqual(finalEvents.map((event) => event.data?.text), ["first final", "authoritative final"]);
});

test("malformed output fails with bounded diagnostics while EOF drains a valid partial record", async (t) => {
	const malformedFixture = await fixture(t);
	const malformed = await (await launch(malformedFixture.manager, "malformed")).result;
	assert.equal(malformed.status, "failed");
	assert.equal(malformed.text, "recovered");
	assert.match(malformed.stderr ?? "", /Malformed child JSONL/);
	assert.ok(Buffer.byteLength(malformed.stderr ?? "") <= 64 * 1024);

	const partialFixture = await fixture(t);
	const partial = await (await launch(partialFixture.manager, "partial")).result;
	assert.equal(partial.status, "completed");
	assert.equal(partial.text, "partial final");
	assert.deepEqual((await eventTypes(partialFixture.manager)).slice(-3), ["process_exited", "output_drained", "terminal"]);
});

test("exit zero requires final assistant and settled Pi evidence", async (t) => {
	for (const [agent, diagnostic] of [
		["empty", /final assistant message_end.*agent_settled/s],
		["missing-final", /final assistant message_end/],
		["missing-settlement", /agent_settled/],
	] as const) {
		const { manager } = await fixture(t);
		const result = await (await launch(manager, agent)).result;
		assert.equal(result.exitCode, 0, agent);
		assert.equal(result.status, "failed", agent);
		assert.match(result.stderr ?? "", diagnostic, agent);
	}
});

test("stop emits lifecycle events, confirms exit, and escalates an ignored SIGTERM", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-signals-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const signalLog = join(root, "signals.log");
	const { manager } = await fixture(t, { terminationGraceMs: 60, signalLog });
	const started = await launch(manager, "ignore-term");
	await waitForEvent(manager, "message_delta");
	const reboundWait = manager.wait(owner(), started.handle);
	await manager.stop(owner(), started.handle);
	const result = await started.result;
	assert.deepEqual(await reboundWait, result);
	assert.equal(result.status, "cancelled");
	assert.equal(result.reason, "explicit_stop");
	assert.equal(result.text, "Stopped by user.");
	assert.doesNotMatch(result.stderr ?? "", /final assistant message_end|agent_settled/);
	assert.equal(result.exitCode, null);
	assert.match(await readFile(signalLog, "utf8"), /SIGTERM/);
	const types = await eventTypes(manager);
	assert.deepEqual(types.slice(-5), ["stop_requested", "terminating", "process_exited", "output_drained", "terminal"]);
	assert.equal(manager.replay(owner()).snapshot.agents[0]?.state, "cancelled");
	assert.equal(manager.replay(owner()).snapshot.agents[0]?.summary, "Stopped by user.");
});

test("teardown is terminal cancellation, terminates children, and fences later delivery", async (t) => {
	const { manager, sessionDirectory } = await fixture(t, { terminationGraceMs: 50 });
	const started = await launch(manager, "wait");
	await waitForEvent(manager, "message_delta");
	const delivered: string[] = [];
	manager.subscribe(owner(), manager.replay(owner()).snapshot.cursor, (event) => delivered.push(event.type));
	await manager.teardown();
	const result = await started.result;
	assert.equal(result.status, "cancelled");
	assert.equal(result.reason, "owner_lost");
	assert.equal(result.text, "Stopped because the owning activation ended.");
	assert.doesNotMatch(result.stderr ?? "", /final assistant message_end|agent_settled/);
	assert.deepEqual(delivered, []);
	await assert.rejects(access(sessionDirectory), /ENOENT/, "activation teardown deletes every retained child transcript");
	assert.throws(() => manager.replay(owner()), /torn down/);
	await assert.rejects(launch(manager, "success"), /torn down/);
});

test("an unobserved background result cannot reject during owner-loss teardown", async (t) => {
	const { manager } = await fixture(t, { terminationGraceMs: 50 });
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const started = await launch(manager, "wait");
		void started.result;
		await waitForEvent(manager, "message_delta");
		await manager.teardown();
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("continuation consumes handles, rejects concurrent writers, and rotates the opaque capability", async (t) => {
	const { manager, invocations } = await fixture(t);
	const started = await launch(manager, "continuation", "one");
	const first = await started.result;
	assert.equal(first.text, "reply:one");
	assert.match(first.contextHashes.stableSystemContextHash, /^sha256:[a-f0-9]{64}$/);
	assert.match(first.contextHashes.attemptUserTurnHash, /^sha256:[a-f0-9]{64}$/);

	const continuingStart = manager.continue({
		owner: owner(), handle: first.handle, attemptUserPrompt: "two",
		env: { STABLE_ENV: "attempt", ATTEMPT_ENV: "two" },
		attemptMetadata: { ATTEMPT_REF: "attempt-two" },
		workflowCredentials: { WORKFLOW_CREDENTIAL: "rotated" },
	});
	await assert.rejects(
		manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "concurrent" }),
		/already reserved|active transcript writer/,
	);
	const continuing = await continuingStart;
	assert.equal(continuing.handle.continuationCapability, first.handle.continuationCapability, "the start result exposes the active cancellable handle");
	const second = await continuing.result;
	assert.equal(second.text, "reply:two");
	assert.equal(second.contextHashes.stableSystemContextHash, first.contextHashes.stableSystemContextHash);
	assert.notEqual(second.contextHashes.attemptUserTurnHash, first.contextHashes.attemptUserTurnHash);
	assert.notEqual(second.handle.continuationCapability, first.handle.continuationCapability);
	assert.equal(second.handle.agentId, first.handle.agentId);
	await assert.rejects(manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "stale" }), /Unknown or stale/);

	const thirdStarted = await manager.continue({ owner: owner(), handle: second.handle, attemptUserPrompt: "three" });
	const third = await thirdStarted.result;
	assert.equal(third.text, "reply:three");
	assert.notEqual(third.handle.continuationCapability, second.handle.continuationCapability);
	assert.deepEqual(invocations.map((invocation) => invocation.continuation), [false, true, true]);
	for (const invocation of invocations) {
		assert.deepEqual(
			{ provider: invocation.provider, model: invocation.model, effort: invocation.effort, tools: invocation.tools, extensionPaths: invocation.extensionPaths, skillPaths: invocation.skillPaths, fast: invocation.fast },
			{ provider: EXECUTION.provider, model: EXECUTION.model, effort: EXECUTION.effort, tools: EXECUTION.tools, extensionPaths: EXECUTION.extensionPaths, skillPaths: EXECUTION.skillPaths, fast: EXECUTION.fast },
		);
	}
	assert.deepEqual(invocations[1]?.env, { STABLE_ENV: "attempt", ATTEMPT_ENV: "two" });
	assert.deepEqual(invocations[1]?.attemptMetadata, { ATTEMPT_REF: "attempt-two" });
	assert.deepEqual(invocations[1]?.workflowCredentials, { WORKFLOW_CREDENTIAL: "rotated" });
	assert.deepEqual(invocations[2]?.env, EXECUTION.env, "attempt env overrides do not mutate the stable continuation config");
	assert.equal(invocations[2]?.attemptMetadata, undefined);
	assert.equal(new Set(invocations.map((invocation) => invocation.transcriptPath)).size, 1);
	assert.deepEqual((await readFile(invocations[0]!.transcriptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line).prompt), ["one", "two", "three"]);
	const snapshot = manager.replay(owner()).snapshot.agents[0];
	assert.equal(snapshot?.handle.continuationCapability, third.handle.continuationCapability);
	assert.equal(snapshot?.contextHashes?.stableSystemContextHash, first.contextHashes.stableSystemContextHash);
	assert.equal(snapshot?.contextHashes?.attemptUserTurnHash, third.contextHashes.attemptUserTurnHash);
	const diagnostics = manager.replay(owner(), 0).events.filter((event) => event.type === "terminal");
	assert.deepEqual(diagnostics.map((event) => event.data?.stableSystemContextHash), [first, second, third].map((result) => result.contextHashes.stableSystemContextHash));
	assert.equal(JSON.stringify(diagnostics).includes("WORKFLOW_CREDENTIAL"), false);
	assert.equal(JSON.stringify(diagnostics).includes(invocations[0]!.transcriptPath), false);
});

test("output-drain subscribers cannot start a continuation before writer release and terminal publication", async (t) => {
	const { manager } = await fixture(t);
	const started = await launch(manager, "continuation", "one");
	let early: Promise<unknown> | undefined;
	const subscription = manager.subscribe(owner(), 0, (event) => {
		if (event.type !== "output_drained" || early) return;
		assert.equal(manager.replay(owner()).snapshot.agents[0]?.state, "running");
		early = manager.continue({ owner: owner(), handle: started.handle, attemptUserPrompt: "too early" });
		subscription.unsubscribe();
	});
	const first = await started.result;
	assert.ok(early);
	await assert.rejects(early, /active transcript writer/);
	const secondStarted = await manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "after terminal" });
	const second = await secondStarted.result;
	assert.equal(second.status, "completed");
	assert.equal(second.text, "reply:after terminal");
});

test("every owner-bearing call rejects another activation", async (t) => {
	const { manager } = await fixture(t);
	const other = owner({ activationId: "other" });
	await assert.rejects(manager.launch({ owner: other, agent: "success", cwd: process.cwd(), stableSystemContext: "stable", attemptUserPrompt: "prompt", ...EXECUTION }), /another runtime activation/);
	assert.throws(() => manager.replay(other), /another runtime activation/);
	assert.throws(() => manager.inspect(other), /another runtime activation/);
	assert.throws(() => manager.subscribe(other, 0, () => undefined), /another runtime activation/);
	const started = await launch(manager, "success");
	await assert.rejects(manager.wait(other, started.handle), /another runtime activation/);
	await assert.rejects(manager.stop(other, started.handle), /another runtime activation/);
	await started.result;
	await assert.rejects(manager.continue({ owner: other, handle: started.handle, attemptUserPrompt: "next" }), /another runtime activation|Unknown or stale/);
});

test("production Pi resolver uses JSON print mode, a private prompt file, and the lifetime wrapper", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-pi-invocation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const transcriptPath = join(root, "session.jsonl");
	const resolver = createPiInvocationResolver({ piInvocation: { command: "pi-test", args: ["--base"] }, lifetimeTermGraceMs: 75 });
	const invocation = await resolver({
		agentId: "agent", attemptId: "attempt", agent: "reviewer", cwd: "/work",
		stableSystemContext: "stable", attemptUserPrompt: "dynamic", transcriptPath, continuation: false,
		provider: "provider", model: "model", effort: "max", tools: ["read", "grep"],
		extensionPaths: ["/ext/one.ts", "/ext/two.ts"], skillPaths: ["/skill/one"], fast: true,
		env: { BASE_ENV: "base" }, workflowCredentials: { WORKFLOW_TOKEN: "token" },
		workflowMetadata: { WORKFLOW_REF: "item" }, attemptMetadata: { ATTEMPT_REF: "attempt" },
	});
	assert.equal(invocation.command, process.execPath);
	assert.deepEqual(invocation.args, [
		LIFETIME_WRAPPER_PATH, "--", "pi-test", "--base",
		"--extension", "/ext/one.ts", "--extension", "/ext/two.ts",
		"--mode", "json", "-p", "--session", transcriptPath, "--name", "reviewer",
		"--provider", "provider", "--model", "model", "--thinking", "max", "--tools", "read,grep",
		"--append-system-prompt", stableSystemPromptPath(transcriptPath), "--skill", "/skill/one", "--", "dynamic",
	]);
	assert.equal(await readFile(stableSystemPromptPath(transcriptPath), "utf8"), "stable");
	assert.deepEqual(invocation.env, {
		BASE_ENV: "base", WORKFLOW_TOKEN: "token", WORKFLOW_REF: "item", ATTEMPT_REF: "attempt",
		PIBOX_RUNTIME_ROLE: "subagent", PIBOX_FAST_CHILD_ENABLED: "1", PIBOX_LIFETIME_TERM_GRACE_MS: "75",
	});
});

test("production Pi resolver keeps task and review limit prompts byte-exact and off argv", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-pi-large-prompt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const resolver = createPiInvocationResolver({ piInvocation: { command: "pi-test", args: [] } });
	for (const bytes of [128 * 1024, 512 * 1024]) {
		const stableSystemContext = "π".repeat(bytes / 2);
		assert.equal(Buffer.byteLength(stableSystemContext), bytes);
		const transcriptPath = join(root, `${bytes}.jsonl`);
		const invocation = await resolver({
			agentId: `agent-${bytes}`, attemptId: "attempt", agent: "reviewer", cwd: root,
			stableSystemContext, attemptUserPrompt: "dynamic", transcriptPath, continuation: false,
			provider: "provider", model: "model", effort: "high", tools: [], extensionPaths: [], skillPaths: [], fast: false,
		});
		assert.equal(await readFile(stableSystemPromptPath(transcriptPath), "utf8"), stableSystemContext);
		assert.equal(invocation.args.includes(stableSystemContext), false, "stable prompt bytes never consume the OS argument budget");
		assert.equal(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], stableSystemPromptPath(transcriptPath));
	}
});

test("the real child boundary classifies an oversized argv failure as E2BIG", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-e2big-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manager = new SubagentProcessManager({
		owner: owner(), sessionDirectory: join(root, "sessions"),
		invocationResolver: () => ({ command: process.execPath, args: ["-e", "process.exit(0)", "x".repeat(3 * 1024 * 1024)] }),
	});
	t.after(() => manager.teardown());
	await assert.rejects(
		manager.launch({ owner: owner(), agent: "oversized", cwd: root, stableSystemContext: "stable", attemptUserPrompt: "prompt", ...EXECUTION }),
		(error: NodeJS.ErrnoException) => error.code === "E2BIG",
	);
});

test("production Pi resolver implements wildcard tools by excluding recursive subagent controls", async () => {
	const resolver = createPiInvocationResolver({ piInvocation: { command: "pi-test", args: [] } });
	const invocation = await resolver({
		agentId: "agent", attemptId: "attempt", agent: "general-purpose", cwd: "/work",
		stableSystemContext: "", attemptUserPrompt: "task", transcriptPath: "/private/session.jsonl", continuation: false,
		provider: "provider", model: "model", effort: "medium", tools: ["*"],
		extensionPaths: [], skillPaths: [], fast: false,
	});
	const excludeIndex = invocation.args.indexOf("--exclude-tools");
	assert.ok(excludeIndex >= 0);
	assert.equal(invocation.args[excludeIndex + 1], "subagent_spawn,subagent_status,subagent_control,subagent_continue");
	assert.equal(invocation.args.includes("--tools"), false);
	assert.equal(invocation.env?.PIBOX_SUBAGENT_ALL_TOOLS, "1");
	assert.equal(invocation.env?.PIBOX_RUNTIME_ROLE, "subagent");
});

test("lifetime wrapper escalates the process group after its direct child exits on SIGTERM", { skip: process.platform === "win32" }, async () => {
	const descendantScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
	const childScript = [
		"const {spawn}=require('node:child_process');",
		`const descendant=spawn(process.execPath,['--eval',${JSON.stringify(descendantScript)}],{stdio:'ignore'});`,
		"process.on('SIGTERM',()=>process.exit(0));",
		"console.log('READY:' + process.pid + ':' + descendant.pid);",
		"setInterval(()=>{},1000);",
	].join("");
	const wrapper = spawn(process.execPath, [LIFETIME_WRAPPER_PATH, "--", process.execPath, "--eval", childScript], {
		env: { ...process.env, PIBOX_LIFETIME_TERM_GRACE_MS: "80" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	wrapper.stderr.setEncoding("utf8");
	wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
	const [childPid, descendantPid] = await new Promise<[number, number]>((resolvePids, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`wrapper child did not become ready: ${stderr}`)), 2_000);
		wrapper.stdout.setEncoding("utf8");
		wrapper.stdout.on("data", (chunk) => {
			output += chunk;
			const match = /READY:(\d+):(\d+)/.exec(output);
			if (match) { clearTimeout(timer); resolvePids([Number(match[1]), Number(match[2])]); }
		});
	});
	const leaseLostAt = Date.now();
	wrapper.stdin.end();
	await waitForClose(wrapper, 2_000);
	assert.ok(Date.now() - leaseLostAt >= 60, "wrapper exited before the group escalation window");
	await Promise.all([waitUntilGone(childPid, 2_000), waitUntilGone(descendantPid, 2_000)]);
});

async function waitForEvent(manager: SubagentProcessManager, type: string): Promise<void> {
	if ((await eventTypes(manager)).includes(type)) return;
	await new Promise<void>((resolveEvent, reject) => {
		const timer = setTimeout(() => { subscription.unsubscribe(); reject(new Error(`Timed out waiting for ${type}`)); }, 2_000);
		const subscription = manager.subscribe(owner(), manager.replay(owner()).snapshot.cursor, (event) => {
			if (event.type !== type) return;
			clearTimeout(timer);
			subscription.unsubscribe();
			resolveEvent();
		});
	});
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
	return new Promise((resolveClose, reject) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Timed out waiting for process close")); }, timeoutMs);
		child.once("close", () => { clearTimeout(timer); resolveClose(); });
	});
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try { process.kill(pid, 0); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		if (Date.now() >= deadline) throw new Error(`Child process ${pid} survived lease loss`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
}
