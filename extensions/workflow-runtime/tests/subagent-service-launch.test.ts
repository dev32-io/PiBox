import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderCooldowns } from "../../provider-fallback/index.js";
import { resetActiveFastModePolicy, setActiveFastModePolicy } from "../../fast-mode/runtime.js";
import { SubagentProcessManager, type RuntimeOwner, type SubagentInvocationRequest } from "../../subagent/index.js";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";

const owner: RuntimeOwner = { sessionId: "workflow-session", processInstanceId: "process-live", activationId: "activation-live" };

test("production workflow launches use service handles while preserving durable logical identity and safe continuation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-service-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => resetActiveFastModePolicy());
	setActiveFastModePolicy({ main: false, subagents: "max" });
	const child = join(root, "child.mjs");
	await writeFile(child, [
		`console.log(JSON.stringify({type:"turn_end",message:{usage:{input:9,output:7,cacheRead:6,cacheWrite:2,totalTokens:12}}}));`,
		`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"service complete"}]}}));`,
		`console.log(JSON.stringify({type:"agent_settled"}));`,
	].join("\n"));
	const requests: SubagentInvocationRequest[] = [];
	const service = new SubagentProcessManager({
		owner,
		sessionDirectory: join(root, "transcripts"),
		invocationResolver(request) {
			requests.push(request);
			return { command: process.execPath, args: [child] };
		},
	});
	t.after(() => service.teardown());
	const registry = new SessionAgentRegistry(root, owner.sessionId);
	await registry.initialize(`main:${owner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${owner.sessionId}`, service, ["/workflow.ts", "/fast.ts"], new ProviderCooldowns());
	const progress: number[] = [];
	const common = {
		role: "reviewer",
		assignment: { evaluation: "eval-1" },
		cwd: root,
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		effort: "high",
		capabilityTier: "low" as const,
		tools: ["read", "workflow_evaluation"],
		agentPrompt: "Stable reviewer contract.",
		additionalPrompt: "Stable workflow protocol.",
		persistentContext: "Stable reviewed context.",
		skillPaths: ["/review-skill"],
		deferCompletion: true,
		workItemId: "story",
		evaluationId: "eval-1",
		onProgress: (value: { outputTokens: number }) => progress.push(value.outputTokens),
	};
	const first = await coordinator.launch({ ...common, operationId: "run-1", runId: "run-1", task: "Review generation one", env: { PIBOX_HARNESS_CREDENTIAL: "credential-one" } });
	assert.equal(first.agent.state, "reported");
	const mapped = service.inspect(owner, { workflowMetadata: { PIBOX_WORKFLOW_SESSION_ID: owner.sessionId, PIBOX_WORKFLOW_LOGICAL_AGENT_ID: first.agent.id } });
	assert.equal(mapped.length, 1);
	assert.notEqual(mapped[0]?.handle.agentId, first.agent.id);
	const reboundCoordinator = new LaunchCoordinator(registry, `main:${owner.sessionId}`, service, ["/workflow.ts", "/fast.ts"], new ProviderCooldowns());
	const second = await reboundCoordinator.launch({ ...common, operationId: "run-2", runId: "run-2", existingAgentId: first.agent.id, task: "Review generation two", env: { PIBOX_HARNESS_CREDENTIAL: "credential-two" } });
	assert.equal(second.agent.id, first.agent.id);
	assert.equal(second.agent.attempts.length, 2);
	assert.equal(second.agent.attempts[0]?.contextHashes?.stableSystemContextHash, second.agent.attempts[1]?.contextHashes?.stableSystemContextHash);
	assert.notEqual(second.agent.attempts[0]?.contextHashes?.attemptUserTurnHash, second.agent.attempts[1]?.contextHashes?.attemptUserTurnHash);
	assert.equal(second.agent.attempts[1]?.progress?.cacheReadTokens, 6);
	assert.equal(second.agent.attempts[1]?.progress?.cacheWriteTokens, 2);
	assert.equal(second.result.progress?.cacheReadTokens, 6);
	assert.equal(second.result.progress?.cacheWriteTokens, 2);
	assert.deepEqual(requests.map((request) => request.continuation), [false, true]);
	assert.equal(new Set(requests.map((request) => request.agentId)).size, 1, "same safe prefix reuses the service transcript handle");
	assert.equal(requests[0]?.workflowMetadata?.PIBOX_WORKFLOW_LOGICAL_AGENT_ID, first.agent.id);
	assert.notEqual(requests[0]?.agentId, first.agent.id, "service identity is not workflow logical identity");
	assert.equal(requests[0]?.attemptMetadata?.PIBOX_WORKFLOW_RUN_ID, "run-1");
	assert.equal(requests[1]?.attemptMetadata?.PIBOX_WORKFLOW_RUN_ID, "run-2");
	assert.equal(requests[0]?.workflowCredentials?.PIBOX_HARNESS_CREDENTIAL, "credential-one");
	assert.equal(requests[1]?.workflowCredentials?.PIBOX_HARNESS_CREDENTIAL, "credential-two");
	assert.equal(requests[0]?.provider, "openai-codex");
	assert.equal(requests[0]?.model, "gpt-5.6-luna");
	assert.equal(requests[0]?.effort, "high");
	assert.deepEqual(requests[0]?.tools, common.tools);
	assert.deepEqual(requests[0]?.extensionPaths, ["/workflow.ts", "/fast.ts"]);
	assert.deepEqual(requests[0]?.skillPaths, ["/review-skill"]);
	assert.equal(requests[0]?.fast, true);
	assert.match(requests[0]?.stableSystemContext ?? "", /Stable reviewer contract\.[\s\S]+Stable workflow protocol\.[\s\S]+Stable reviewed context\./);
	assert.ok(progress.includes(7));

	const third = await reboundCoordinator.launch({ ...common, tools: ["read"], operationId: "run-3", runId: "run-3", existingAgentId: first.agent.id, task: "Review with changed tools" });
	assert.equal(third.agent.id, first.agent.id);
	assert.equal(requests[2]?.continuation, false, "a changed tool prefix starts a fresh service logical agent");
	assert.notEqual(requests[2]?.agentId, requests[1]?.agentId);
	await reboundCoordinator.launch({ ...common, tools: ["read"], persistentContext: "Changed reviewed context.", operationId: "run-4", runId: "run-4", existingAgentId: first.agent.id, task: "Review with changed system context" });
	assert.equal(requests[3]?.continuation, false, "a changed system prefix starts a fresh service logical agent");
	assert.notEqual(requests[3]?.agentId, requests[2]?.agentId);
});

test("service-backed provider fallback keeps one workflow logical agent but starts a fresh service transcript", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-service-fallback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const limited = join(root, "limited.mjs");
	const success = join(root, "success.mjs");
	await writeFile(limited, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"HTTP 429 Retry-After: 1"}}));\nconsole.log(JSON.stringify({type:"agent_settled"}));\nprocess.exitCode=1;\n`);
	await writeFile(success, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"fallback service complete"}]}}));\nconsole.log(JSON.stringify({type:"agent_settled"}));\n`);
	const requests: SubagentInvocationRequest[] = [];
	const service = new SubagentProcessManager({ owner, sessionDirectory: join(root, "transcripts"), invocationResolver(request) {
		requests.push(request);
		return { command: process.execPath, args: [request.provider === "limited" ? limited : success] };
	} });
	t.after(() => service.teardown());
	const registry = new SessionAgentRegistry(root, owner.sessionId);
	await registry.initialize(`main:${owner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${owner.sessionId}`, service, [], new ProviderCooldowns());
	const launched = await coordinator.launch({
		operationId: "fallback", role: "reviewer", task: "Review", assignment: {}, cwd: root,
		provider: "limited", model: "one", effort: "medium",
		providerCandidates: [{ provider: "limited", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "high" }],
		tools: [], agentPrompt: "Review safely.",
	});
	assert.equal(launched.agent.state, "completed");
	assert.equal(launched.result.provider, "healthy");
	assert.deepEqual(requests.map((request) => request.provider), ["limited", "healthy"]);
	assert.equal(new Set(requests.map((request) => request.agentId)).size, 2, "provider changes cannot continue an incompatible transcript prefix");
	assert.equal(launched.agent.attempts.length, 2);
});

test("review-rereview and integration-fix retries continue real service handles with attempt-local facts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-service-loops-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const child = join(root, "child.mjs");
	await writeFile(child, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"settled"}]}}));\nconsole.log(JSON.stringify({type:"agent_settled"}));\n`);
	const requests: SubagentInvocationRequest[] = [];
	const service = new SubagentProcessManager({ owner, sessionDirectory: join(root, "transcripts"), invocationResolver(request) {
		requests.push(request);
		return { command: process.execPath, args: [child] };
	} });
	t.after(() => service.teardown());
	const registry = new SessionAgentRegistry(root, owner.sessionId);
	await registry.initialize(`main:${owner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${owner.sessionId}`, service);
	const common = { assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: ["read"], deferCompletion: true };
	const review = await coordinator.launch({ ...common, operationId: "review-1", role: "code-reviewer", agentPrompt: "Stable reviewer.", persistentContext: "Stable spec/task contract.", task: "Initial review at commit A; no prior findings." });
	await coordinator.launch({ ...common, operationId: "review-2", existingAgentId: review.agent.id, role: "code-reviewer", agentPrompt: "Stable reviewer.", persistentContext: "Stable spec/task contract.", task: "Re-review repair diff A..B; prior finding F1; manager requested closure." });
	const fixer = await coordinator.launch({ ...common, operationId: "fix-1", role: "repair-implementer", agentPrompt: "Stable fixer.", persistentContext: "Stable integration contract.", task: "Repair generation 1 at candidate A." });
	await coordinator.launch({ ...common, operationId: "fix-2", existingAgentId: fixer.agent.id, role: "repair-implementer", agentPrompt: "Stable fixer.", persistentContext: "Stable integration contract.", task: "Repair generation 2 with current CI diff B..C." });
	assert.deepEqual(requests.map((request) => request.continuation), [false, true, false, true]);
	assert.equal(requests[0]?.agentId, requests[1]?.agentId, "reviewer transcript continues into rereview");
	assert.equal(requests[2]?.agentId, requests[3]?.agentId, "integration fixer transcript continues into the next deterministic repair");
	assert.notEqual(requests[0]?.agentId, requests[2]?.agentId, "incompatible stable roles remain separate logical service agents");
	assert.match(requests[1]?.attemptUserPrompt ?? "", /prior finding F1/);
	assert.match(requests[3]?.attemptUserPrompt ?? "", /generation 2/);
});
