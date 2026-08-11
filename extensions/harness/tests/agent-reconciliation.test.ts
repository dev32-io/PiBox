import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileReportedAgents } from "../agent-reconciliation.js";
import { SessionAgentRegistry } from "../../workflows/agent-registry.js";
import { RepositoryMutex } from "../idempotency.js";
import { atomicWriteFile } from "../repository.js";
import { WorkItemStore } from "../work-items.js";

test("reconciles a structured explorer handoff after its original parent is gone", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-agent-reconcile-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const privateRoot = join(root, "private");
	const registry = new SessionAgentRegistry(privateRoot, "session-1");
	await registry.initialize("main:session-1");
	const assignment = { schemaVersion: 1 as const, mode: "lookup" as const, question: "Where?", decisionSupported: "Choose boundary", knownEvidence: [], scope: { start: ["src"] }, depth: "quick" as const, stopConditions: ["Cited"], requiredOutput: ["Answer"] };
	const agent = await registry.reserve({ operationId: "explore-1", parentAgentId: "main:session-1", parentDepth: 0, role: "explorer", provider: "test", model: "fake", effort: "low", assignment });
	const { attempt } = await registry.startAttempt(agent.id);
	await registry.markRunning(agent.id, attempt.id, process.pid);
	await registry.transition(agent.id, "reported");
	await atomicWriteFile(join(registry.root, "agents", agent.id, "handoff.json"), `${JSON.stringify({ schemaVersion: 1, type: "exploration_complete", agentId: agent.id, attemptId: attempt.id, mode: "lookup", answer: "In src/index.ts", evidence: [{ path: "src/index.ts", observation: "Definition" }], unknowns: [], completedAt: new Date().toISOString() })}\n`, 0o600);

	const result = await reconcileReportedAgents({ identity: { id: "repo", root, privateRoot }, registry, workItems: new WorkItemStore(root), mutex: new RepositoryMutex(privateRoot) });
	assert.deepEqual(result.completed, [agent.id]);
	assert.equal((await registry.get(agent.id)).state, "completed");
});
