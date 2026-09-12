import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
	LIFETIME_WRAPPER_PATH,
	REPORT_BRIDGE_EXTENSION_PATH,
	SubagentProcessManager,
	attemptUserPromptPath,
	createPiInvocationResolver,
	stableSystemPromptPath,
	type RuntimeOwner,
	type SubagentInvocation,
	type SubagentInvocationRequest,
} from "../index.js";
import { normalizeSubagentTitle } from "../presentation.js";

const FAKE_CHILD = resolve("extensions/subagent/tests/support/fake-child.mjs");
const PRODUCTION_BRIDGE_CHILD = resolve("extensions/subagent/tests/support/production-bridge-child.mjs");
const REAL_PI_PROVIDER = resolve("extensions/subagent/tests/support/real-pi-provider.ts");
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
	t.after(async () => {
		const reportDirectories: string[] = [];
		try {
			for (const snapshot of manager.inspect(owner())) {
				if (["launching", "running", "stopping"].includes(snapshot.state)) continue;
				const terminal = await manager.wait(owner(), snapshot.handle);
				if (terminal.reportPath) reportDirectories.push(dirname(terminal.reportPath));
			}
		} catch { /* A test may already have torn down the manager. */ }
		await manager.teardown();
		await Promise.all(reportDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
		await rm(root, { recursive: true, force: true });
	});
	return { manager, root, sessionDirectory, invocations };
}

function launch(manager: SubagentProcessManager, agent: string, prompt = "first prompt") {
	return manager.launch({ owner: owner(), agent, cwd: process.cwd(), stableSystemContext: "stable agent contract", attemptUserPrompt: prompt, continuationKey: "stable-config", ...EXECUTION });
}

async function productionBridgeFixture(t: TestContext, mode: string, finalText?: string) {
	const root = await mkdtemp(join(tmpdir(), "pibox-production-bridge-"));
	const resolver = createPiInvocationResolver({
		piInvocation: {
			command: process.execPath,
			args: ["--import", "tsx", PRODUCTION_BRIDGE_CHILD],
			env: { FAKE_PI_MODE: mode, ...(finalText === undefined ? {} : { FAKE_FINAL_TEXT: finalText }) },
		},
		lifetimeTermGraceMs: 50,
	});
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: resolver,
		maximumJsonlLineCharacters: 32 * 1024,
		terminationGraceMs: 100,
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });
	return manager;
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
	t.after(() => terminal.reportPath ? rm(dirname(terminal.reportPath), { recursive: true, force: true }) : undefined);
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
	assert.deepEqual(finalEvents.map((event) => event.data?.reportBytes), [11, 19]);
});

test("production bridge drains oversized cumulative, tool, and final events into a private complete report", async (t) => {
	const manager = await productionBridgeFixture(t, "oversized");
	const terminal = await (await launch(manager, "bridge")).result;
	assert.equal(terminal.status, "completed");
	assert.equal(Array.from(terminal.text).length, 1_700_001);
	assert.match(terminal.text, /^🙂中🙂中/);
	assert.ok(terminal.text.endsWith("z".repeat(100)));
	assert.match(terminal.reportPath ?? "", /^\/tmp\/pibox-subagent-attempt-[^/]+\/report\.md$/);
	assert.equal(terminal.reportBytes, Buffer.byteLength(terminal.text));
	assert.equal(terminal.reportCharacters, 1_700_001);
	assert.equal(await readFile(terminal.reportPath!, "utf8"), terminal.text);
	assert.equal((await stat(dirname(terminal.reportPath!))).mode & 0o777, 0o700);
	assert.equal((await stat(terminal.reportPath!)).mode & 0o777, 0o600);
	assert.equal(terminal.text.includes("private reasoning"), false);
	assert.equal(terminal.progress?.toolCalls, 1);
	assert.doesNotMatch(terminal.stderr ?? "", /configured limit|agent_end/);
	const retainedPath = terminal.reportPath!;
	await manager.release(owner(), terminal.handle);
	await access(retainedPath);
	await manager.teardown();
	await access(retainedPath);
	t.after(() => rm(dirname(retainedPath), { recursive: true, force: true }));
});

test("real Pi CLI loads the provider and report bridge, selects a tool, and settles oversized native events", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-real-pi-bridge-"));
	const marker = join(root, "tool-selected.log");
	const piCommand = resolve("node_modules/.bin/pi");
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: createPiInvocationResolver({
			piInvocation: {
				command: piCommand,
				args: ["--offline", "--no-context-files", "--no-skills"],
				env: { PI_OFFLINE: "1", PIBOX_REAL_PI_TOOL_MARKER: marker },
			},
			lifetimeTermGraceMs: 50,
		}),
		maximumJsonlLineCharacters: 32 * 1024,
		terminationGraceMs: 200,
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });
	const stableSystemContext = "Stable context survives file transport: π🙂";
	const attemptUserPrompt = `-leading-dash\n@/literal/not-an-attachment\nUnicode: π🙂中\n${"prompt-body-".repeat(270_000)}\n  exact trailing whitespace  \n`;
	assert.ok(Buffer.byteLength(attemptUserPrompt) > 3 * 1024 * 1024, "fixture must exceed ordinary argv budgets");
	const started = await manager.launch({
		owner: owner(),
		agent: "real-cli",
		cwd: root,
		stableSystemContext,
		attemptUserPrompt,
		provider: "pibox-real-cli-test",
		model: "fixture-model",
		effort: "off",
		tools: ["oversized_fixture_tool"],
		extensionPaths: [REAL_PI_PROVIDER],
		skillPaths: [],
		fast: false,
	});
	const terminal = await started.result;
	assert.equal(terminal.status, "completed", terminal.stderr);
	const markerLines = (await readFile(marker, "utf8")).trim().split("\n");
	assert.deepEqual(JSON.parse(markerLines[0]!), {
		promptBytes: Buffer.byteLength(attemptUserPrompt),
		promptSha256: createHash("sha256").update(attemptUserPrompt).digest("hex"),
		stableContextPresent: true,
	}, "the provider received the exact prompt as one user message and the stable context");
	assert.equal(markerLines[1], "selected", "the real agent loop executed the selected extension tool");
	assert.equal(terminal.progress?.toolCalls, 1);
	assert.equal(terminal.text.endsWith("REAL_PI_FINAL_SENTINEL"), true);
	assert.ok((terminal.reportBytes ?? 0) > 1_000_000);
	assert.equal(await readFile(terminal.reportPath!, "utf8"), terminal.text);
	await assert.rejects(access(attemptUserPromptPath(join(root, "sessions", `${started.handle.agentId}.jsonl`), terminal.attemptId)), /ENOENT/, "the consumed prompt sidecar is removed");
	assert.doesNotMatch(terminal.stderr ?? "", /configured limit|Malformed child event channel|agent_settled|E2BIG/);
	const lifecycle = await eventTypes(manager);
	assert.ok(lifecycle.includes("final_message"), "real message_end reached the bridge");
	assert.equal(lifecycle.at(-1), "terminal", "real agent_settled allowed completion");
	t.after(() => rm(dirname(terminal.reportPath!), { recursive: true, force: true }));
});

test("production report paths remain attempt-specific and old reports stay stable after continuation", async (t) => {
	const manager = await productionBridgeFixture(t, "continuation");
	const first = await (await launch(manager, "bridge", "one")).result;
	const firstPath = first.reportPath!;
	const firstText = await readFile(firstPath, "utf8");
	const second = await (await manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "two" })).result;
	assert.equal(firstText, "reply:one");
	assert.equal(second.text, "reply:two");
	assert.notEqual(second.reportPath, firstPath);
	assert.equal(await readFile(firstPath, "utf8"), firstText);
	assert.equal(await readFile(second.reportPath!, "utf8"), "reply:two");
	t.after(async () => {
		await Promise.all([firstPath, second.reportPath!].map((path) => rm(dirname(path), { recursive: true, force: true })));
	});
});

test("production bridge makes report write, missing file, malformed channel, and missing settlement failures explicit", async (t) => {
	for (const [mode, diagnostic] of [
		["report-error", /Child report write failed/],
		["missing-report", /report file is missing/],
		["malformed-channel", /Malformed child event channel/],
		["missing-settlement", /agent_settled/],
	] as const) {
		const manager = await productionBridgeFixture(t, mode, "final text");
		const terminal = await (await launch(manager, "bridge")).result;
		assert.equal(terminal.status, "failed", mode);
		assert.match(terminal.stderr ?? "", diagnostic, mode);
		if (terminal.reportPath) t.after(() => rm(dirname(terminal.reportPath!), { recursive: true, force: true }));
	}
});

test("failed, terminated, and partial report allocations are cleaned only after child drain", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-report-cleanup-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let sequence = 0;
	const createManager = (mode: string) => {
		const allocationDirectory = join(root, `attempt-${++sequence}`);
		const reportPath = join(allocationDirectory, "report.md");
		const manager = new SubagentProcessManager({
			owner: owner(),
			sessionDirectory: join(root, `sessions-${sequence}`),
			terminationGraceMs: 30,
			invocationResolver: (request) => ({
				command: process.execPath,
				args: [FAKE_CHILD, mode],
				env: { FAKE_PROMPT: request.attemptUserPrompt, FAKE_TRANSCRIPT: request.transcriptPath },
			}),
			async reportPathAllocator() {
				await mkdir(allocationDirectory, { recursive: true, mode: 0o700 });
				return reportPath;
			},
		});
		return { manager, allocationDirectory, reportPath };
	};

	const missing = createManager("missing-report");
	const missingTerminal = await (await launch(missing.manager, "missing")).result;
	assert.equal(missingTerminal.status, "failed");
	assert.equal(missingTerminal.reportPath, undefined);
	await assert.rejects(access(missing.allocationDirectory), /ENOENT/);
	await missing.manager.teardown();

	const terminated = createManager("wait");
	const running = await launch(terminated.manager, "wait");
	await waitForEvent(terminated.manager, "message_delta");
	await terminated.manager.stop(owner(), running.handle);
	assert.equal((await running.result).reason, "explicit_stop");
	await assert.rejects(access(terminated.allocationDirectory), /ENOENT/);
	await terminated.manager.teardown();

	const captured = createManager("success-partial");
	const capturedTerminal = await (await launch(captured.manager, "success-partial")).result;
	assert.equal(capturedTerminal.status, "completed");
	assert.equal(await readFile(captured.reportPath, "utf8"), "final answer");
	await assert.rejects(access(`${captured.reportPath}.tmp-stale`), /ENOENT/);
	await captured.manager.teardown();
	await access(captured.reportPath);
});

test("assistant failure metadata stays separate from captured report contents", async (t) => {
	const manager = await productionBridgeFixture(t, "assistant-error", "safe final text");
	const terminal = await (await launch(manager, "bridge")).result;
	assert.equal(terminal.status, "failed");
	assert.equal(terminal.text, "safe final text");
	assert.match(terminal.stderr ?? "", /provider failed/);
	assert.equal(await readFile(terminal.reportPath!, "utf8"), "safe final text");
	assert.doesNotMatch(await readFile(terminal.reportPath!, "utf8"), /provider failed|private reasoning/);
	t.after(() => rm(dirname(terminal.reportPath!), { recursive: true, force: true }));
});

test("malformed output fails with bounded diagnostics while EOF drains a valid partial record", async (t) => {
	const malformedFixture = await fixture(t);
	const malformed = await (await launch(malformedFixture.manager, "malformed")).result;
	assert.equal(malformed.status, "failed");
	assert.equal(malformed.text, "recovered");
	assert.match(malformed.stderr ?? "", /Malformed child event channel/);
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

test("stop and wait promptly settle an initial launch whose invocation never resolves", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-launch-stop-"));
	let invocationRequested!: () => void;
	const requested = new Promise<void>((resolve) => { invocationRequested = resolve; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver() {
			invocationRequested();
			return new Promise<SubagentInvocation>(() => {});
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });

	const launching = launch(manager, "wait");
	await requested;
	const snapshot = manager.inspect(owner())[0];
	assert.equal(snapshot?.state, "launching");
	assert.ok(snapshot?.attemptId);
	const waiting = manager.wait(owner(), snapshot!.handle);
	await assert.rejects(manager.release(owner(), snapshot!.handle), /Cannot release an active logical agent/);
	await promptly(manager.stop(owner(), snapshot!.handle));

	const started = await promptly(launching);
	const terminal = await promptly(waiting);
	assert.deepEqual(await started.result, terminal);
	assert.equal(terminal.status, "cancelled");
	assert.equal(terminal.reason, "explicit_stop");
	assert.equal(terminal.text, "Stopped by user.");
	assert.equal(manager.inspect(owner())[0]?.state, "cancelled");
	assert.equal(manager.inspect(owner())[0]?.processId, undefined);
	assert.deepEqual(await eventTypes(manager), ["stop_requested", "terminal"]);
});

test("teardown promptly settles an initial launch whose invocation never resolves", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-launch-teardown-"));
	let invocationRequested!: () => void;
	const requested = new Promise<void>((resolve) => { invocationRequested = resolve; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver() {
			invocationRequested();
			return new Promise<SubagentInvocation>(() => {});
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });

	const launching = launch(manager, "wait");
	await requested;
	const handle = manager.inspect(owner())[0]!.handle;
	const waiting = manager.wait(owner(), handle);
	await promptly(manager.teardown());
	const started = await promptly(launching);
	const terminal = await promptly(waiting);
	assert.deepEqual(await started.result, terminal);
	assert.equal(terminal.status, "cancelled");
	assert.equal(terminal.reason, "owner_lost");
	assert.equal(terminal.text, "Stopped because the owning activation ended.");
});

test("a late beforeSpawn completion cannot spawn or publish after launch stop", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-late-fence-"));
	const marker = join(root, "spawned");
	let beforeSpawnEntered!: () => void;
	let releaseBeforeSpawn!: () => void;
	const entered = new Promise<void>((resolve) => { beforeSpawnEntered = resolve; });
	const gate = new Promise<void>((resolve) => { releaseBeforeSpawn = resolve; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: () => ({ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`] }),
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });

	const launching = manager.launch({
		owner: owner(), agent: "wait", cwd: root, stableSystemContext: "stable", attemptUserPrompt: "prompt", ...EXECUTION,
		beforeSpawn() { beforeSpawnEntered(); return gate; },
	});
	await entered;
	const handle = manager.inspect(owner())[0]!.handle;
	await promptly(manager.stop(owner(), handle));
	const started = await promptly(launching);
	await promptly(started.result);
	releaseBeforeSpawn();
	await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
	await assert.rejects(access(marker), /ENOENT/);
	assert.deepEqual(await eventTypes(manager), ["stop_requested", "terminal"]);
});

test("stop during report allocation terminalizes without spawning and cleans the late allocation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-allocation-stop-"));
	const allocationDirectory = join(root, "attempt");
	const reportPath = join(allocationDirectory, "report.md");
	const marker = join(root, "spawned");
	let allocationEntered!: () => void;
	let releaseAllocation!: () => void;
	const entered = new Promise<void>((resolveEntered) => { allocationEntered = resolveEntered; });
	const gate = new Promise<void>((resolveGate) => { releaseAllocation = resolveGate; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: () => ({ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`] }),
		async reportPathAllocator() {
			allocationEntered();
			await gate;
			await mkdir(allocationDirectory, { recursive: true, mode: 0o700 });
			return reportPath;
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });

	const launching = launch(manager, "allocation");
	await entered;
	const handle = manager.inspect(owner())[0]!.handle;
	await promptly(manager.stop(owner(), handle));
	const started = await promptly(launching);
	assert.equal((await promptly(started.result)).reason, "explicit_stop");
	releaseAllocation();
	await waitForMissing(allocationDirectory);
	await assert.rejects(access(marker), /ENOENT/);
	assert.deepEqual(await eventTypes(manager), ["stop_requested", "terminal"]);
});

test("teardown during report allocation terminalizes without spawning and cleans the late allocation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-allocation-teardown-"));
	const allocationDirectory = join(root, "attempt");
	const reportPath = join(allocationDirectory, "report.md");
	const marker = join(root, "spawned");
	let allocationEntered!: () => void;
	let releaseAllocation!: () => void;
	const entered = new Promise<void>((resolveEntered) => { allocationEntered = resolveEntered; });
	const gate = new Promise<void>((resolveGate) => { releaseAllocation = resolveGate; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: () => ({ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`] }),
		async reportPathAllocator() {
			allocationEntered();
			await gate;
			await mkdir(allocationDirectory, { recursive: true, mode: 0o700 });
			return reportPath;
		},
	});
	t.after(() => rm(root, { recursive: true, force: true }));

	const launching = launch(manager, "allocation");
	await entered;
	const handle = manager.inspect(owner())[0]!.handle;
	const waiting = manager.wait(owner(), handle);
	await promptly(manager.teardown());
	const started = await promptly(launching);
	assert.equal((await promptly(started.result)).reason, "owner_lost");
	assert.equal((await promptly(waiting)).reason, "owner_lost");
	releaseAllocation();
	await waitForMissing(allocationDirectory);
	await assert.rejects(access(marker), /ENOENT/);
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

test("continuation launching is published, blocks release, and promptly stops with capability rotation when invocation never resolves", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-continuation-stop-"));
	let invocationCount = 0;
	let continuationRequested!: () => void;
	const requested = new Promise<void>((resolve) => { continuationRequested = resolve; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver(request) {
			invocationCount += 1;
			if (invocationCount === 2) {
				continuationRequested();
				return new Promise<SubagentInvocation>(() => {});
			}
			return fakeInvocation(request);
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });

	const first = await (await launch(manager, "continuation", "one")).result;
	const continuing = manager.continue({
		owner: owner(), handle: first.handle, attemptUserPrompt: "two",
		attemptMetadata: { PIBOX_WORKFLOW_ATTEMPT_TOKEN: "attempt-two" },
	});
	await requested;
	const snapshot = manager.inspect(owner())[0];
	assert.equal(snapshot?.state, "launching");
	assert.deepEqual(snapshot?.attemptMetadata, { PIBOX_WORKFLOW_ATTEMPT_TOKEN: "attempt-two" });
	assert.notEqual(snapshot?.attemptId, first.attemptId);
	assert.equal(snapshot?.handle.continuationCapability, first.handle.continuationCapability);
	const waiting = manager.wait(owner(), first.handle);
	await assert.rejects(manager.release(owner(), first.handle), /Cannot release an active logical agent/);
	await promptly(manager.stop(owner(), first.handle));

	const started = await promptly(continuing);
	const stopped = await promptly(started.result);
	assert.deepEqual(await promptly(waiting), stopped);
	assert.deepEqual(started.handle, stopped.handle, "a pre-spawn cancelled continuation returns its fresh live handle");
	assert.equal(stopped.reason, "explicit_stop");
	assert.notEqual(stopped.handle.continuationCapability, first.handle.continuationCapability);
	await assert.rejects(manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "stale" }), /Unknown or stale/);
	const third = await (await manager.continue({ owner: owner(), handle: stopped.handle, attemptUserPrompt: "three" })).result;
	assert.equal(third.text, "reply:three");
	assert.equal(invocationCount, 3);
});

test("teardown promptly settles a continuation whose invocation never resolves as owner_lost", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-continuation-teardown-"));
	let invocationCount = 0;
	let continuationRequested!: () => void;
	const requested = new Promise<void>((resolve) => { continuationRequested = resolve; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver(request) {
			invocationCount += 1;
			if (invocationCount === 2) {
				continuationRequested();
				return new Promise<SubagentInvocation>(() => {});
			}
			return fakeInvocation(request);
		},
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });

	const first = await (await launch(manager, "continuation", "one")).result;
	const continuing = manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "two" });
	await requested;
	assert.equal(manager.inspect(owner())[0]?.state, "launching");
	const waiting = manager.wait(owner(), first.handle);
	await promptly(manager.teardown());
	const started = await promptly(continuing);
	const terminal = await promptly(started.result);
	assert.deepEqual(await promptly(waiting), terminal);
	assert.equal(terminal.status, "cancelled");
	assert.equal(terminal.reason, "owner_lost");
	assert.equal(terminal.text, "Stopped because the owning activation ended.");
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
		"--extension", REPORT_BRIDGE_EXTENSION_PATH,
		"--extension", "/ext/one.ts", "--extension", "/ext/two.ts",
		"--mode", "json", "-p", "--session", transcriptPath, "--name", "reviewer",
		"--provider", "provider", "--model", "model", "--thinking", "max", "--tools", "read,grep",
		"--append-system-prompt", stableSystemPromptPath(transcriptPath), "--skill", "/skill/one", "--", "pibox-subagent-user-prompt",
	]);
	assert.equal(await readFile(stableSystemPromptPath(transcriptPath), "utf8"), "stable");
	assert.equal(await readFile(attemptUserPromptPath(transcriptPath, "attempt"), "utf8"), "dynamic");
	assert.equal((await stat(attemptUserPromptPath(transcriptPath, "attempt"))).mode & 0o777, 0o600);
	assert.deepEqual(invocation.env, {
		BASE_ENV: "base", WORKFLOW_TOKEN: "token", WORKFLOW_REF: "item", ATTEMPT_REF: "attempt",
		PIBOX_RUNTIME_ROLE: "subagent", PIBOX_FAST_CHILD_ENABLED: "1", PIBOX_SUBAGENT_EVENT_FD: "3",
		PIBOX_SUBAGENT_PROMPT_PATH: attemptUserPromptPath(transcriptPath, "attempt"), PIBOX_LIFETIME_TERM_GRACE_MS: "75",
	});
});

test("production Pi resolver keeps stable and attempt prompts byte-exact and off argv", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-pi-large-prompt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const resolver = createPiInvocationResolver({ piInvocation: { command: "pi-test", args: [] } });
	for (const bytes of [128 * 1024, 512 * 1024]) {
		const stableSystemContext = "π".repeat(bytes / 2);
		assert.equal(Buffer.byteLength(stableSystemContext), bytes);
		const transcriptPath = join(root, `${bytes}.jsonl`);
		const attemptUserPrompt = `-leading\n@literal/path\nπ🙂中\n${"x".repeat(bytes)}\ntrailing  \n`;
		const invocation = await resolver({
			agentId: `agent-${bytes}`, attemptId: "attempt", agent: "reviewer", cwd: root,
			stableSystemContext, attemptUserPrompt, transcriptPath, continuation: false,
			provider: "provider", model: "model", effort: "high", tools: [], extensionPaths: [], skillPaths: [], fast: false,
		});
		assert.equal(await readFile(stableSystemPromptPath(transcriptPath), "utf8"), stableSystemContext);
		assert.equal(await readFile(attemptUserPromptPath(transcriptPath, "attempt"), "utf8"), attemptUserPrompt);
		assert.equal(invocation.args.includes(stableSystemContext), false, "stable prompt bytes never consume the OS argument budget");
		assert.equal(invocation.args.includes(attemptUserPrompt), false, "attempt prompt bytes never consume the OS argument budget");
		assert.equal(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], stableSystemPromptPath(transcriptPath));
		assert.equal(invocation.env?.PIBOX_SUBAGENT_PROMPT_PATH, attemptUserPromptPath(transcriptPath, "attempt"));
	}
});

test("pre-spawn cancellation removes an already-created prompt sidecar", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-prompt-cancel-"));
	let entered!: () => void;
	let release!: () => void;
	const atFence = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
	const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: createPiInvocationResolver({ piInvocation: { command: "unused-pi", args: [] } }),
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });
	const launching = manager.launch({
		owner: owner(), agent: "cancel", cwd: root, stableSystemContext: "stable", attemptUserPrompt: "exact prompt", ...EXECUTION,
		beforeSpawn() { entered(); return gate; },
	});
	await atFence;
	const snapshot = manager.inspect(owner())[0]!;
	const promptPath = attemptUserPromptPath(join(root, "sessions", `${snapshot.handle.agentId}.jsonl`), snapshot.attemptId!);
	await access(promptPath);
	await manager.stop(owner(), snapshot.handle);
	assert.equal((await (await launching).result).reason, "explicit_stop");
	await assert.rejects(access(promptPath), /ENOENT/);
	release();
});

test("prompt sidecars are removed when the wrapped Pi command cannot spawn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-prompt-spawn-failure-"));
	const manager = new SubagentProcessManager({
		owner: owner(),
		sessionDirectory: join(root, "sessions"),
		invocationResolver: createPiInvocationResolver({ piInvocation: { command: join(root, "missing-pi"), args: [] } }),
	});
	t.after(async () => { await manager.teardown(); await rm(root, { recursive: true, force: true }); });
	const started = await manager.launch({
		owner: owner(), agent: "missing", cwd: root, stableSystemContext: "stable", attemptUserPrompt: "exact prompt", ...EXECUTION,
	});
	const terminal = await started.result;
	assert.equal(terminal.status, "failed");
	const transcriptPath = join(root, "sessions", `${started.handle.agentId}.jsonl`);
	await assert.rejects(access(attemptUserPromptPath(transcriptPath, terminal.attemptId)), /ENOENT/);
});

test("the real child boundary classifies an oversized argv failure as E2BIG and cleans its unpublished report allocation", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-subagent-e2big-"));
	const allocationDirectory = join(root, "attempt");
	t.after(() => rm(root, { recursive: true, force: true }));
	const manager = new SubagentProcessManager({
		owner: owner(), sessionDirectory: join(root, "sessions"),
		invocationResolver: () => ({ command: process.execPath, args: ["-e", "process.exit(0)", "x".repeat(3 * 1024 * 1024)] }),
		async reportPathAllocator() {
			await mkdir(allocationDirectory, { recursive: true, mode: 0o700 });
			return join(allocationDirectory, "report.md");
		},
	});
	t.after(() => manager.teardown());
	await assert.rejects(
		manager.launch({ owner: owner(), agent: "oversized", cwd: root, stableSystemContext: "stable", attemptUserPrompt: "prompt", ...EXECUTION }),
		(error: NodeJS.ErrnoException) => error.code === "E2BIG",
	);
	await assert.rejects(access(allocationDirectory), /ENOENT/);
});

test("production Pi resolver implements wildcard tools by excluding recursive subagent controls", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-wildcard-invocation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const resolver = createPiInvocationResolver({ piInvocation: { command: "pi-test", args: [] } });
	const invocation = await resolver({
		agentId: "agent", attemptId: "attempt", agent: "general-purpose", cwd: "/work",
		stableSystemContext: "", attemptUserPrompt: "task", transcriptPath: join(root, "session.jsonl"), continuation: false,
		provider: "provider", model: "model", effort: "medium", tools: ["*"],
		extensionPaths: [], skillPaths: [], fast: false,
	});
	const excludeIndex = invocation.args.indexOf("--exclude-tools");
	assert.ok(excludeIndex >= 0);
	assert.equal(invocation.args[excludeIndex + 1], "subagent_spawn,subagent_status,subagent_control,subagent_continue,subagent_read");
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

function fakeInvocation(request: SubagentInvocationRequest): SubagentInvocation {
	return {
		command: process.execPath,
		args: [FAKE_CHILD, request.agent],
		env: { FAKE_PROMPT: request.attemptUserPrompt, FAKE_TRANSCRIPT: request.transcriptPath },
	};
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Lifecycle operation did not settle promptly")), 500); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

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

async function waitForMissing(path: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try { await access(path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for cleanup: ${path}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
	}
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

test("display metadata survives service continuation but never enters child invocation or prompt hashes", async (t) => {
	const { manager, invocations } = await fixture(t);
	const routing = {
		requested: { tier: "high", model: "missing", effort: "xhigh", allowFallback: true },
		selected: { provider: EXECUTION.provider, model: EXECUTION.model, effort: EXECUTION.effort },
		fallbackUsed: true,
		attempts: [{ model: "missing", status: "model_missing" }],
	};
	const fullTitle = `\u001b[31mFix\n RTL corners\u001b[0m ${"with complete logical label ".repeat(8)}`.trim();
	const started = await manager.launch({ owner: owner(), agent: "continuation", title: fullTitle, routing, cwd: process.cwd(), stableSystemContext: "stable", attemptUserPrompt: "first", ...EXECUTION });
	const first = await started.result;
	routing.requested.model = "mutated outside service";
	const snapshot = manager.inspect(owner())[0]!;
	assert.equal(snapshot.title, normalizeSubagentTitle(fullTitle));
	assert.ok(Array.from(snapshot.title!).length > 80, "the stored logical label is not limited by its rendered heading");
	assert.equal(snapshot.routing?.requested.model, "missing");
	assert.equal(snapshot.attemptId, first.attemptId);
	const continued = await manager.continue({ owner: owner(), handle: first.handle, attemptUserPrompt: "second" });
	await continued.result;
	assert.equal(manager.inspect(owner())[0]!.title, snapshot.title);
	assert.deepEqual(manager.inspect(owner())[0]!.routing, snapshot.routing);
	for (const invocation of invocations) {
		assert.equal("title" in invocation, false);
		assert.equal("routing" in invocation, false);
		assert.equal(invocation.stableSystemContext, "stable");
	}
});
