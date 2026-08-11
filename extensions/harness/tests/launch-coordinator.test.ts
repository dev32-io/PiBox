import assert from "node:assert/strict";
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
		invocationResolver: () => ({ command: process.execPath, args: [fake] }),
	});

	assert.equal(launched.result.text, "mapped repository");
	assert.equal(launched.agent.state, "completed");
	assert.equal(await registry.activeCount(), 0);
	const record = await registry.get(launched.agent.id);
	assert.equal(record.attempts.length, 1);
	assert.equal(record.attempts[0]?.exitCode, 0);
	const attemptRoot = join(registry.root, "agents", record.id, "attempts", record.attempts[0]!.id);
	await access(join(attemptRoot, "stdout.jsonl"));
	assert.match(await readFile(join(attemptRoot, "stdout.jsonl"), "utf8"), /mapped repository/);
});
