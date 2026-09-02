import assert from "node:assert/strict";
import test from "node:test";
import {
	SUBAGENT_PROTOCOL_VERSION,
	ContinuationCapabilityStore,
	SubagentCapabilityRegistry,
	SubagentEventBuffer,
	assemblePromptContext,
	assertContinuationOwner,
	assertTreeNavigationAllowed,
	getSubagentCapabilityRegistry,
	runtimeOwnerForActivation,
	sameRuntimeOwner,
	type LogicalAgentHandle,
	type RuntimeOwner,
	type SubagentService,
	type SubagentSnapshot,
} from "../index.js";

function owner(overrides: Partial<RuntimeOwner> = {}): RuntimeOwner {
	return { sessionId: "session-a", processInstanceId: "process-a", activationId: "activation-a", ...overrides };
}

function service(serviceOwner: RuntimeOwner) {
	let teardownCount = 0;
	const value: SubagentService = {
		protocolVersion: SUBAGENT_PROTOCOL_VERSION,
		owner: serviceOwner,
		async launch() { throw new Error("not implemented in Phase 1"); },
		async continue() { throw new Error("not implemented in Phase 1"); },
		async wait() { throw new Error("not implemented in Phase 1"); },
		inspect() { throw new Error("not implemented in Phase 1"); },
		async stop() { throw new Error("not implemented in Phase 1"); },
		async release() { throw new Error("not implemented in Phase 1"); },
		replay() { throw new Error("not implemented in Phase 1"); },
		subscribe() { throw new Error("not implemented in Phase 1"); },
		teardown() { teardownCount += 1; },
	};
	return { value, teardownCount: () => teardownCount };
}

function handle(handleOwner: RuntimeOwner = owner()): LogicalAgentHandle {
	return { owner: handleOwner, agentId: "agent-1", continuationCapability: "opaque-capability" };
}

function snapshot(snapshotOwner: RuntimeOwner, state: SubagentSnapshot["agents"][number]["state"]): SubagentSnapshot {
	return { owner: snapshotOwner, cursor: 0, agents: [{ handle: handle(snapshotOwner), agent: "test-agent", state, provider: "test", model: "model", effort: "off", fast: false, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] };
}

test("activation lifecycle preserves ownership only for reload", () => {
	const current = owner();
	const reload = runtimeOwnerForActivation({ lifecycle: "reload", previous: current, ...current });
	assert.equal(reload, current, "reload keeps the exact live owner capability");

	for (const lifecycle of ["startup", "new", "resume", "fork"] as const) {
		const next = runtimeOwnerForActivation({
			lifecycle,
			previous: current,
			sessionId: lifecycle === "resume" ? current.sessionId : `session-${lifecycle}`,
			processInstanceId: current.processInstanceId,
			activationId: `activation-${lifecycle}`,
		});
		assert.equal(sameRuntimeOwner(next, current), false, lifecycle);
	}
	assert.throws(() => runtimeOwnerForActivation({ lifecycle: "reload", previous: current, ...current, processInstanceId: "other-process" }), /cannot cross/);
	assert.throws(() => runtimeOwnerForActivation({ lifecycle: "resume", previous: current, ...current }), /new activation/);
});

test("fresh extension reload binding acquires the same manager without its activation id", async () => {
	const registry = getSubagentCapabilityRegistry();
	await registry.clear();
	let created = 0;
	let managed: ReturnType<typeof service> | undefined;
	const first = await registry.acquire({ lifecycle: "startup", sessionId: "session-a", processInstanceId: "process-a", activationId: "secret-activation" }, (createdOwner) => {
		created += 1;
		managed = service(createdOwner);
		return managed.value;
	});
	const freshInstanceBinding = await registry.acquire({ lifecycle: "reload", sessionId: "session-a", processInstanceId: "process-a" }, () => {
		throw new Error("reload must not create a manager");
	});
	assert.equal(created, 1);
	assert.equal(freshInstanceBinding.service, first.service);
	assert.equal(freshInstanceBinding.owner.activationId, "secret-activation");
	assert.equal(managed?.teardownCount(), 0);
	assert.equal(await first.unregister(), false, "reload supersedes the old extension binding");
	assert.equal(await freshInstanceBinding.unregister(), true);
	assert.equal(managed?.teardownCount(), 0, "binding release is not manager teardown");

	const rebound = await registry.acquire({ lifecycle: "reload", sessionId: "session-a", processInstanceId: "process-a" }, () => {
		throw new Error("released managers remain reloadable");
	});
	assert.equal(rebound.service, first.service);
	assert.equal(await registry.teardown(rebound.owner), true);
	assert.equal(managed?.teardownCount(), 1);
	await assert.rejects(registry.acquire({ lifecycle: "reload", sessionId: "session-a", processInstanceId: "process-a" }, () => first.service), /no manager/);
});

test("reload without an existing manager creates a fresh activation when an activation id is supplied", async () => {
	const registry = new SubagentCapabilityRegistry();
	let createdOwner: RuntimeOwner | undefined;
	const registration = await registry.acquire({ lifecycle: "reload", sessionId: "session-a", processInstanceId: "process-a", activationId: "fresh-after-reload" }, (owner) => {
		createdOwner = owner;
		return service(owner).value;
	});
	assert.equal(createdOwner, registration.owner);
	assert.equal(registration.owner.activationId, "fresh-after-reload");
	assert.equal(registration.owner.sessionId, "session-a");
	await registry.teardown(registration.owner);
});

test("startup, new, resume, and fork create rather than adopt managers", async () => {
	for (const lifecycle of ["startup", "new", "resume", "fork"] as const) {
		const registry = new SubagentCapabilityRegistry();
		const initial = service(owner());
		await registry.register({ protocolVersion: SUBAGENT_PROTOCOL_VERSION, owner: initial.value.owner, service: initial.value });
		let createdOwner: RuntimeOwner | undefined;
		const binding = await registry.acquire({ lifecycle, sessionId: "session-a", processInstanceId: "process-a", activationId: `activation-${lifecycle}` }, (nextOwner) => {
			createdOwner = nextOwner;
			return service(nextOwner).value;
		});
		assert.equal(initial.teardownCount(), 1, lifecycle);
		assert.equal(createdOwner, binding.owner);
		assert.notEqual(binding.service, initial.value);
		await registry.clear();
	}
});

test("consumer lookup requires the same live session and process instance", async () => {
	const registry = new SubagentCapabilityRegistry();
	const managed = service(owner());
	const registration = await registry.register({ protocolVersion: SUBAGENT_PROTOCOL_VERSION, owner: managed.value.owner, service: managed.value });
	assert.equal(registry.resolveConsumer({ sessionId: "session-a", processInstanceId: "process-a" })?.service, managed.value);
	assert.equal(registry.resolveConsumer({ sessionId: "session-a", processInstanceId: "other-process" }), undefined);
	assert.equal(registry.resolveConsumer({ sessionId: "other-session", processInstanceId: "process-a" }), undefined);
	await registration.unregister();
	assert.equal(registry.resolveConsumer({ sessionId: "session-a", processInstanceId: "process-a" }), undefined, "released activations cannot be adopted by persisted session id");
	await registry.teardown(managed.value.owner);
});

test("registration remains versioned and replacement tears down only the manager", async () => {
	const registry = new SubagentCapabilityRegistry();
	const first = service(owner());
	const registration = await registry.register({ protocolVersion: SUBAGENT_PROTOCOL_VERSION, owner: first.value.owner, service: first.value });
	assert.throws(() => registry.resolve(first.value.owner, 2), /Unsupported subagent protocol version/);
	await assert.rejects(registry.register({ protocolVersion: 2 as 1, owner: first.value.owner, service: first.value }), /Unsupported subagent protocol version/);
	assert.equal(await registration.unregister(), true);
	assert.equal(first.teardownCount(), 0);
	assert.equal(registry.resolve(first.value.owner), undefined);
	assert.equal(await registry.teardown(first.value.owner), true);
	assert.equal(first.teardownCount(), 1);
});

test("event replay carries a snapshot, monotonic cursor, attempt sequence, and owner fence", () => {
	const current = owner();
	const events = new SubagentEventBuffer(current, { agents: [] });
	const running = snapshot(current, "running");
	const first = events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "attempt_started", at: "2026-01-01T00:00:00Z" }, { agents: running.agents });
	const second = events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "message_delta", at: "2026-01-01T00:00:01Z" }, { agents: running.agents });
	assert.deepEqual([first.cursor, second.cursor], [1, 2]);
	assert.deepEqual([first.sequence, second.sequence], [1, 2]);
	const replay = events.replay(current, first.cursor);
	assert.equal(replay.snapshot.cursor, first.cursor);
	assert.deepEqual(replay.events.map((event) => event.cursor), [second.cursor]);
	assert.throws(() => events.replay(owner({ activationId: "other" }), 0), /another runtime activation/);
});

test("subscription atomically returns an overflow reset snapshot before live events", () => {
	const current = owner();
	const events = new SubagentEventBuffer(current, { agents: [] }, 2);
	const running = snapshot(current, "running");
	for (let index = 0; index < 3; index += 1) {
		events.append({ agentId: "agent-1", attemptId: "attempt-1", type: index === 0 ? "attempt_started" : "message_delta" }, { agents: running.agents });
	}
	const live: number[] = [];
	const subscription = events.subscribe(current, 0, (event) => live.push(event.cursor));
	assert.equal(subscription.initial.reset, true);
	assert.equal(subscription.initial.snapshot.cursor, 3);
	assert.deepEqual(subscription.initial.events, []);
	assert.deepEqual(live, [], "replay is consumed from initial before any live callback");
	events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "final_message" }, { agents: running.agents });
	assert.deepEqual(live, [4]);
	subscription.unsubscribe();
});

test("settlement permits only exit, drain, terminal and rejects duplicates or late output", () => {
	const current = owner();
	const settled = snapshot(current, "completed");
	const stopping = snapshot(current, "stopping");
	const illegalAfterExit = ["attempt_started", "message_delta", "final_message", "stop_requested", "terminating", "process_exited"] as const;
	for (const type of illegalAfterExit) {
		const events = new SubagentEventBuffer(current);
		events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "process_exited" }, { agents: stopping.agents });
		assert.throws(() => events.append({ agentId: "agent-1", attemptId: "attempt-1", type }, { agents: stopping.agents }), /Only output drain/);
	}
	const events = new SubagentEventBuffer(current);
	assert.throws(() => events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "output_drained" }, { agents: stopping.agents }), /follow process exit/);
	assert.throws(() => events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "terminal" }, { agents: settled.agents }), /follow output drain/);
	const exit = events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "process_exited" }, { agents: stopping.agents });
	const drain = events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "output_drained" }, { agents: stopping.agents });
	assert.throws(() => events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "output_drained" }, { agents: stopping.agents }), /Only terminal/);
	assert.throws(() => events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "message_delta" }, { agents: stopping.agents }), /Only terminal/);
	const terminal = events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "terminal" }, { agents: settled.agents });
	assert.deepEqual([exit.sequence, drain.sequence, terminal.sequence], [1, 2, 3]);
	assert.throws(() => events.append({ agentId: "agent-1", attemptId: "attempt-1", type: "terminal" }, { agents: settled.agents }), /after terminal/);
});

test("opaque continuation capabilities reject forged, stale, and concurrent use", () => {
	const current = owner();
	let sequence = 0;
	const capabilities = new ContinuationCapabilityStore<{ transcriptSessionId: string }>(() => `capability-${++sequence}`);
	const issued = capabilities.issue(current, "agent-1", { transcriptSessionId: "private-transcript" });
	assert.equal("transcriptSessionId" in issued, false);
	assert.throws(() => capabilities.reserve(current, { ...issued, continuationCapability: "forged" }), /Unknown or stale/);
	assert.throws(() => capabilities.reserve(current, { ...issued, agentId: "forged-agent" }), /Unknown or stale/);
	assert.throws(() => capabilities.reserve(owner({ activationId: "other" }), issued), /Unknown or stale/);
	const reservation = capabilities.reserve(current, issued);
	assert.equal(reservation.value.transcriptSessionId, "private-transcript");
	assert.throws(() => capabilities.reserve(current, issued), /already reserved/);
	reservation.release();
	const settled = capabilities.reserve(current, issued);
	settled.settle();
	assert.throws(() => capabilities.reserve(current, issued), /Unknown or stale/);
	assert.throws(() => settled.release(), /no longer active/);
});

test("terminal agents do not block tree navigation", () => {
	const current = owner();
	assert.doesNotThrow(() => assertContinuationOwner(current, handle(current)));
	assert.throws(() => assertContinuationOwner(owner({ activationId: "other" }), handle(current)), /another runtime activation/);
	for (const state of ["launching", "running", "stopping"] as const) {
		assert.throws(() => assertTreeNavigationAllowed(current, snapshot(current, state)), /while subagents are active/);
	}
	for (const state of ["completed", "failed", "cancelled"] as const) {
		assert.doesNotThrow(() => assertTreeNavigationAllowed(current, snapshot(current, state)));
	}
	assert.throws(() => assertTreeNavigationAllowed(owner({ processInstanceId: "other" }), snapshot(current, "completed")), /another runtime activation/);
});

test("transport metadata cannot affect prompt content or stable hash", () => {
	const content = { stableSystemParts: ["Agent definition", "Protocol contract", "Durable task context"], attemptUserPrompt: "Implement the task" };
	const first = assemblePromptContext(content, { systemPromptPath: "/var/run/pibox/one.md", transcriptSessionId: "transport-one" });
	const second = assemblePromptContext(content, { systemPromptPath: "/different/path/two.md", transcriptSessionId: "transport-two", extra: "ignored" });
	assert.deepEqual(first, second);
	assert.equal(JSON.stringify(first).includes("transport-one"), false);
	assert.equal(JSON.stringify(first).includes("/var/run"), false);
	const nextAttempt = assemblePromptContext({ ...content, attemptUserPrompt: "Fix the check" }, { systemPromptPath: "/third/path.md" });
	assert.equal(first.stableSystemContext, nextAttempt.stableSystemContext);
	assert.equal(first.stableSystemContextHash, nextAttempt.stableSystemContextHash);
	assert.notEqual(first.attemptUserTurnHash, nextAttempt.attemptUserTurnHash);
	assert.notEqual(first.attemptUserPrompt, nextAttempt.attemptUserPrompt);
});
