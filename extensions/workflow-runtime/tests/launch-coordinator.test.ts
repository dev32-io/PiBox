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
	const coordinator = new LaunchCoordinator(registry, "main:session-1");
	const fake = join(root, "fake-child.mjs");
	await writeFile(fake, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"mapped repository"}]}}));\n`);

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
		persistentContext: "Persistent canonical context.",
		invocationResolver: (args) => {
			const promptIndex = args.indexOf("--append-system-prompt");
			effectiveSystemPrompt = readFileSync(args[promptIndex + 1]!, "utf8");
			return { command: process.execPath, args: [fake] };
		},
	});

	assert.equal(launched.result.text, "mapped repository");
	assert.match(effectiveSystemPrompt, /Agent instructions\.[\s\S]+Persistent canonical context\./);
	assert.equal(launched.agent.state, "completed");
	assert.equal(await registry.activeCount(), 0);
	const record = await registry.get(launched.agent.id);
	assert.equal(record.attempts.length, 1);
	assert.equal(record.attempts[0]?.exitCode, 0);
	const attemptRoot = join(registry.root, "agents", record.id, "attempts", record.attempts[0]!.id);
	await access(join(attemptRoot, "stdout.jsonl"));
	assert.match(await readFile(join(attemptRoot, "stdout.jsonl"), "utf8"), /mapped repository/);
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
