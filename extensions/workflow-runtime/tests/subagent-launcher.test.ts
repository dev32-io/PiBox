import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderCooldowns } from "../../provider-fallback/index.js";
import { SubagentProcessManager, type LaunchSpec, type SubagentInvocation } from "../../subagent/index.js";
import { WorkflowSubagentLauncher } from "../subagent-launcher.js";
import { FakeSubagentService, fakeOwner } from "./fixtures/fake-subagent-service.js";

const common = { storyId: "story", slotId: "task:one", action: "task-launch", role: "implementer", tier: "high" as const, cwd: "/tmp", stableSystemContext: "stable", attemptUserPrompt: "attempt one", provider: "healthy", model: "one", effort: "medium", tools: ["read"], attemptToken: "token-one" };

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
	const launched = service.requests[0];
	assert.equal(launched?.kind, "launch");
	if (launched?.kind === "launch") assert.deepEqual(launched.spec.workflowMetadata, {
		PIBOX_WORKFLOW_STORY_ID: "story",
		PIBOX_WORKFLOW_SLOT_ID: "task:one",
		PIBOX_WORKFLOW_TIER: "high",
	});
	assert.equal(service.inspect(fakeOwner)[0]?.workflowMetadata?.PIBOX_WORKFLOW_TIER, "high", "the logical agent preserves tier metadata after continuation");
});

test("mutable initial seed does not break compatible continuation and workflow identity reaches child environment", async () => {
	const service = new FakeSubagentService(() => ({ status: "completed", reason: "completed", exitCode: 0, text: "done" }));
	const launcher = new WorkflowSubagentLauncher(service);
	await launcher.launch({ ...common, initialSystemSupplement: "ledger version one" });
	await launcher.launch({ ...common, attemptToken: "token-two", action: "task-repair", attemptUserPrompt: "repair", initialSystemSupplement: "ledger version two" });
	assert.deepEqual(service.requests.map((request) => request.kind), ["launch", "continue"]);
	assert.equal(service.requests[0]!.agentId, service.requests[1]!.agentId);
	const first = service.requests[0];
	assert.equal(first?.kind, "launch");
	if (first?.kind === "launch") {
		assert.equal(first.spec.stableSystemContext, "stable\n\nledger version one");
		assert.deepEqual({
			story: first.spec.env?.PIBOX_WORKFLOW_STORY_ID,
			slot: first.spec.env?.PIBOX_WORKFLOW_SLOT_ID,
			token: first.spec.workflowCredentials?.PIBOX_WORKFLOW_ATTEMPT_TOKEN,
			action: first.spec.env?.PIBOX_WORKFLOW_ACTION,
		}, { story: "story", slot: "task:one", token: "token-one", action: "task-launch" });
	}
	const second = service.requests[1];
	assert.equal(second?.kind, "continue");
	if (second?.kind === "continue") {
		assert.equal(second.spec.workflowCredentials?.PIBOX_WORKFLOW_ATTEMPT_TOKEN, "token-two");
		assert.equal(second.spec.env?.PIBOX_WORKFLOW_ACTION, "task-repair");
	}
});

test("workflow results preserve the complete protocol text and attempt report reference", async () => {
	const text = `${"protocol-line\n".repeat(100_000)}🙂`;
	const service = new FakeSubagentService(() => ({ status: "completed", reason: "completed", exitCode: 0, text }));
	const launch = service.launch.bind(service);
	service.launch = async (spec) => {
		const started = await launch(spec);
		return {
			...started,
			result: started.result.then((terminal) => ({
				...terminal,
				reportPath: "/tmp/pibox-subagent-attempt-test/report.md",
				reportBytes: Buffer.byteLength(text),
				reportCharacters: Array.from(text).length,
			})),
		};
	};
	const settled = await new WorkflowSubagentLauncher(service).launch(common);
	assert.equal(settled.text, text);
	assert.equal(settled.reportPath, "/tmp/pibox-subagent-attempt-test/report.md");
	assert.equal(settled.reportBytes, Buffer.byteLength(text));
	assert.equal(settled.reportCharacters, Array.from(text).length);
});

test("the workflow abort signal is rechecked by the service pre-spawn fence", async () => {
	let enterService!: () => void;
	let releaseService!: () => void;
	const enteredService = new Promise<void>((resolve) => { enterService = resolve; });
	const serviceGate = new Promise<void>((resolve) => { releaseService = resolve; });
	class DelayedLaunchService extends FakeSubagentService {
		override async launch(spec: LaunchSpec) {
			enterService();
			await serviceGate;
			return super.launch(spec);
		}
	}
	const service = new DelayedLaunchService();
	const launcher = new WorkflowSubagentLauncher(service);
	const controller = new AbortController();
	const reason = new Error("workflow action stopped");
	const launched = launcher.launch({ ...common, signal: controller.signal });
	await enteredService;
	controller.abort(reason);
	releaseService();
	await assert.rejects(launched, (error) => error === reason);
	assert.equal(service.requests.length, 0, "the aborted service fence prevents launch publication");
});

test("same-activation stop settles a published pre-spawn launch without leaving a child", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-launch-stop-"));
	const marker = join(root, "spawned");
	let invocationRequested!: () => void;
	let resolveInvocation!: (invocation: SubagentInvocation) => void;
	const requested = new Promise<void>((resolve) => { invocationRequested = resolve; });
	const invocation = new Promise<SubagentInvocation>((resolve) => { resolveInvocation = resolve; });
	const service = new SubagentProcessManager({
		owner: fakeOwner,
		sessionDirectory: join(root, "sessions"),
		invocationResolver() {
			invocationRequested();
			return invocation;
		},
	});
	t.after(async () => { await service.teardown(); await rm(root, { recursive: true, force: true }); });
	const launcher = new WorkflowSubagentLauncher(service);
	const controller = new AbortController();
	const launched = launcher.launch({ ...common, cwd: root, signal: controller.signal });
	await requested;
	assert.equal(service.inspect(fakeOwner)[0]?.state, "launching");

	controller.abort(new Error("workflow stopped"));
	const stopped = launcher.stopStory(common.storyId);
	resolveInvocation({ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`] });

	assert.equal(await stopped, 1);
	assert.equal((await launched).terminalReason, "explicit_stop");
	assert.equal(launcher.activeCount(common.storyId), 0);
	assert.equal(service.inspect(fakeOwner)[0]?.state, "cancelled");
	await assert.rejects(access(marker), /ENOENT/, "the aborted pre-spawn launch never creates a process");
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
