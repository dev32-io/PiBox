import assert from "node:assert/strict";
import test from "node:test";
import { PendingSubagentDeliveryRegistry, type RuntimeOwner, type TerminalResult } from "../index.js";

function owner(overrides: Partial<RuntimeOwner> = {}): RuntimeOwner {
	return { sessionId: "session", processInstanceId: "process", activationId: "activation", ...overrides };
}

function terminal(resultOwner: RuntimeOwner = owner(), agentId = "agent", text = "done"): TerminalResult {
	return {
		owner: resultOwner,
		handle: { owner: resultOwner, agentId, continuationCapability: "capability" },
		attemptId: "attempt",
		contextHashes: { stableSystemContextHash: "sha256:stable", attemptUserTurnHash: "sha256:attempt" },
		status: "completed",
		reason: "completed",
		exitCode: 0,
		text,
	};
}

test("pending delivery results remain owner-fenced and are accepted exactly once", async () => {
	const registry = new PendingSubagentDeliveryRegistry();
	const delivered: Array<string> = [];
	registry.track({ owner: owner(), agent: "generic", agentId: "agent" }, Promise.resolve(terminal()));
	await new Promise((resolve) => setImmediate(resolve));

	const stale = registry.bind(owner({ activationId: "replacement" }), "replacement", () => {
		delivered.push("replacement");
		return true;
	});
	assert.equal(delivered.length, 0);
	assert.equal(registry.count(owner()), 1);

	registry.bind(owner(), "reload", (delivery, outcome) => {
		delivered.push(`${delivery.agentId}:${"terminal" in outcome ? outcome.terminal.text : outcome.error}`);
		return true;
	});
	assert.equal(delivered.join(","), "agent:done");
	assert.equal(registry.count(owner()), 0);

	registry.bind(owner(), "later", () => {
		delivered.push("duplicate");
		return true;
	});
	assert.equal(delivered.join(","), "agent:done");
	stale.release();
});

test("batched bindings coalesce settlements and preserve insertion order", async () => {
	const registry = new PendingSubagentDeliveryRegistry(0);
	const first = Promise.resolve(terminal(owner(), "agent-1", "one"));
	const second = Promise.resolve(terminal(owner(), "agent-2", "two"));
	let resolveBatch!: (value: string[]) => void;
	const batch = new Promise<string[]>((resolve) => { resolveBatch = resolve; });
	registry.bindBatched(owner(), "batch", (settlements) => {
		resolveBatch(settlements.map(({ delivery, outcome }) => `${delivery.agentId}:${"terminal" in outcome ? outcome.terminal.text : outcome.error}`));
		return true;
	});
	registry.track({ owner: owner(), agent: "generic", agentId: "agent-1" }, first);
	registry.track({ owner: owner(), agent: "generic", agentId: "agent-2" }, second);
	assert.deepEqual(await batch, ["agent-1:one", "agent-2:two"]);
	assert.equal(registry.count(owner()), 0);
});

test("a rejected terminal batch remains available to a replacement binding", async () => {
	const registry = new PendingSubagentDeliveryRegistry(0);
	let rejected!: () => void;
	const rejection = new Promise<void>((resolve) => { rejected = resolve; });
	registry.bindBatched(owner(), "reject", () => {
		rejected();
		return false;
	});
	registry.track({ owner: owner(), agent: "generic", agentId: "agent" }, Promise.resolve(terminal()));
	await rejection;
	assert.equal(registry.count(owner()), 1);
	let accepted!: (agentId: string) => void;
	const delivery = new Promise<string>((resolve) => { accepted = resolve; });
	registry.bindBatched(owner(), "accept", (settlements) => {
		accepted(settlements[0]!.delivery.agentId);
		return true;
	});
	assert.equal(await delivery, "agent");
	assert.equal(registry.count(owner()), 0);
});

test("discard removes an obligation before a replacement owner can observe settlement", async () => {
	const registry = new PendingSubagentDeliveryRegistry();
	let resolve!: (value: TerminalResult) => void;
	const pending = new Promise<TerminalResult>((done) => { resolve = done; });
	registry.track({ owner: owner(), agent: "generic", agentId: "agent" }, pending);
	assert.equal(registry.discard(owner()), 1);
	resolve(terminal());
	await new Promise((done) => setImmediate(done));
	let deliveries = 0;
	registry.bind(owner(), "new-session", () => { deliveries++; return true; });
	assert.equal(deliveries, 0);
	assert.equal(registry.count(), 0);
});
