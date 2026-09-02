import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCooldowns } from "../../provider-fallback/index.js";
import { WorkflowSubagentLauncher } from "../subagent-launcher.js";
import { FakeSubagentService } from "./fixtures/fake-subagent-service.js";

const common = { storyId: "story", slotId: "task:one", action: "task-launch", role: "implementer", cwd: "/tmp", stableSystemContext: "stable", attemptUserPrompt: "attempt one", provider: "healthy", model: "one", effort: "medium", tools: ["read"], attemptToken: "token-one" };

test("direct service launcher rebinds the exact attempt token and continues only a compatible settled slot", async () => {
	const service = new FakeSubagentService(() => ({ status: "completed", reason: "completed", exitCode: 0, text: "done" }));
	const first = new WorkflowSubagentLauncher(service, ["/workflow.ts"], new ProviderCooldowns());
	const settled = await first.launch(common);
	const rebound = await new WorkflowSubagentLauncher(service, ["/workflow.ts"], new ProviderCooldowns()).launch(common);
	assert.equal(rebound.serviceAttemptId, settled.serviceAttemptId);
	assert.equal(service.requests.length, 1, "reload waits on the exact service attempt instead of spawning or continuing");
	await first.launch({ ...common, attemptToken: "token-two", attemptUserPrompt: "attempt two", action: "task-repair" });
	assert.deepEqual(service.requests.map((request) => request.kind), ["launch", "continue"]);
	assert.equal(service.requests[0]?.agentId, service.requests[1]?.agentId);
});

test("stop filters active service snapshots by story metadata and release removes settled transcripts", async () => {
	const service = new FakeSubagentService(() => new Promise(() => {}));
	const launcher = new WorkflowSubagentLauncher(service);
	const left = launcher.launch(common);
	const right = launcher.launch({ ...common, storyId: "other", attemptToken: "other-token" });
	while (service.requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await launcher.stopStory("story"), 1);
	assert.equal((await left).terminalReason, "explicit_stop");
	assert.equal(launcher.activeCount("other"), 1);
	await launcher.stopStory("other"); await right;
	assert.equal(await launcher.releaseStory("story"), 1);
	assert.equal(service.released.length, 1);
});

test("terminal service events wake capacity subscribers without polling", async () => {
	const service = new FakeSubagentService(() => ({ status: "completed", reason: "completed", exitCode: 0, text: "done" }));
	const launcher = new WorkflowSubagentLauncher(service);
	let wakes = 0;
	const unsubscribe = launcher.subscribeCapacity(() => { wakes++; });
	await launcher.launch(common);
	assert.equal(wakes, 1);
	unsubscribe();
	await launcher.launch({ ...common, attemptToken: "token-after-unsubscribe", slotId: "task:two" });
	assert.equal(wakes, 1);
});

test("provider fallback uses a fresh incompatible service transcript without direct Pi fallback", async () => {
	const service = new FakeSubagentService((request) => request.kind === "launch" && request.spec.provider === "limited"
		? { status: "failed", reason: "failure", exitCode: 1, stderr: "HTTP 429 Retry-After: 1", text: "" }
		: { status: "completed", reason: "completed", exitCode: 0, text: "fallback" });
	const launcher = new WorkflowSubagentLauncher(service, [], new ProviderCooldowns());
	const settled = await launcher.launch({ ...common, provider: "limited", providerCandidates: [{ provider: "limited", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "high" }] });
	assert.equal(settled.provider, "healthy");
	assert.deepEqual(service.requests.map((request) => request.kind === "launch" ? request.spec.provider : "continued"), ["limited", "healthy"]);
	assert.equal(new Set(service.requests.map((request) => request.agentId)).size, 2);
});
