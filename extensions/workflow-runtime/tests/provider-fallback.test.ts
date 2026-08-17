import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderCooldowns } from "../../provider-fallback/index.js";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-provider-fallback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const limited = join(root, "limited.mjs");
	const context = join(root, "context.mjs");
	const success = join(root, "success.mjs");
	await writeFile(limited, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"HTTP 429 usage limit reached",content:[]}})); process.exitCode=1;\n`);
	await writeFile(context, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"context_length_exceeded",content:[]}})); process.exitCode=1;\n`);
	await writeFile(success, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"fallback completed"}]}}));\n`);
	const registry = new SessionAgentRegistry(root, "session-1", 16, 1);
	await registry.initialize("main:session-1");
	return { root, limited, context, success, registry };
}

test("keeps one logical foreground launch pending through provider fallback", async (t) => {
	const f = await fixture(t);
	const sessions: string[] = [];
	const visibleText: string[] = [];
	const startedRoutes: string[] = [];
	const coordinator = new LaunchCoordinator(f.registry, "main:session-1", undefined, [], new ProviderCooldowns());
	const launched = await coordinator.launch({
		operationId: "fallback-1", role: "explorer", task: "Inspect", assignment: { task: "Inspect" }, cwd: f.root,
		provider: "limited", model: "one", effort: "medium",
		providerCandidates: [
			{ provider: "limited", model: "one", effort: "medium" },
			{ provider: "healthy", model: "two", effort: "high" },
		],
		tools: [], agentPrompt: "Inspect safely.", onText: (text) => visibleText.push(text),
		onStarted: (agent) => startedRoutes.push(`${agent.provider}/${agent.model}#${agent.effort}`),
		invocationResolver: (args) => {
			sessions.push(args[args.indexOf("--session") + 1]!);
			const model = args[args.indexOf("--model") + 1];
			return { command: process.execPath, args: [model === "limited/one" ? f.limited : f.success] };
		},
	});
	assert.equal(launched.result.provider, "healthy");
	assert.equal(launched.result.text, "fallback completed");
	assert.deepEqual(visibleText, ["fallback completed"]);
	assert.deepEqual(startedRoutes, ["limited/one#medium", "healthy/two#high"]);
	assert.equal(new Set(sessions).size, 1);
	assert.equal(launched.agent.attempts.length, 2);
	assert.deepEqual(launched.agent.attempts.map(({ provider, model }) => `${provider}/${model}`), ["limited/one", "healthy/two"]);
});

test("does not fallback for context overflow", async (t) => {
	const f = await fixture(t);
	const coordinator = new LaunchCoordinator(f.registry, "main:session-1", undefined, [], new ProviderCooldowns());
	const launched = await coordinator.launch({
		operationId: "context-1", role: "explorer", task: "Inspect", assignment: {}, cwd: f.root,
		provider: "context", model: "one", effort: "medium",
		providerCandidates: [{ provider: "context", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "medium" }],
		tools: [], agentPrompt: "Inspect safely.",
		invocationResolver: (args) => ({ command: process.execPath, args: [args[args.indexOf("--model") + 1] === "context/one" ? f.context : f.success] }),
	});
	assert.equal(launched.result.provider, "context");
	assert.equal(launched.agent.attempts.length, 1);
	assert.equal(launched.agent.state, "failed");
});

test("keeps an exhausted logical agent waiting for provider capacity", async (t) => {
	const f = await fixture(t);
	const coordinator = new LaunchCoordinator(f.registry, "main:session-1", undefined, [], new ProviderCooldowns());
	const launched = await coordinator.launch({
		operationId: "waiting-1", role: "explorer", task: "Inspect", assignment: {}, cwd: f.root,
		provider: "limited", model: "one", effort: "medium", providerCandidates: [{ provider: "limited", model: "one", effort: "medium" }],
		tools: [], agentPrompt: "Inspect safely.", invocationResolver: () => ({ command: process.execPath, args: [f.limited] }),
	});
	assert.equal(launched.agent.state, "waiting_capacity");
	assert.equal(await f.registry.activeCount(), 1);
});

test("skips a provider already cooling down", async (t) => {
	const f = await fixture(t);
	const cooldowns = new ProviderCooldowns();
	cooldowns.mark("limited", 60_000);
	const coordinator = new LaunchCoordinator(f.registry, "main:session-1", undefined, [], cooldowns);
	const launched = await coordinator.launch({
		operationId: "cooldown-1", role: "explorer", task: "Inspect", assignment: {}, cwd: f.root,
		provider: "limited", model: "one", effort: "medium",
		providerCandidates: [{ provider: "limited", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "medium" }],
		tools: [], agentPrompt: "Inspect safely.", invocationResolver: () => ({ command: process.execPath, args: [f.success] }),
	});
	assert.equal(launched.result.provider, "healthy");
	assert.equal(launched.agent.attempts.length, 1);
});
