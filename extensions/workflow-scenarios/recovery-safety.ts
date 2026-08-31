import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { LaunchCoordinator } from "../workflow-runtime/launch-coordinator.js";
import { SubagentProcessManager } from "../subagent/process-manager.js";
import { HarnessRunStore } from "../workflow/run-store.js";
import type { ScenarioDimension, WorkflowScenarioResult } from "./types.js";

function result(id: string, findings: string[]): WorkflowScenarioResult {
	const dimension = (name: ScenarioDimension["name"], weight: number, selected: string[]): ScenarioDimension => ({ name, weight, score: selected.length ? 0 : 100, findings: selected });
	const dimensions = [dimension("outcome", 25, findings), dimension("scheduling", 25, []), dimension("safety", 25, findings), dimension("autonomy", 15, []), dimension("protocol", 10, findings)];
	return { scenarioId: id, passed: findings.length === 0, score: findings.length ? 40 : 100, terminal: findings.length ? "paused" : "complete", peakConcurrency: 1, stepStatuses: {}, dimensions, findings, trace: [] };
}

export async function runInterruptedRecoveryScenario(): Promise<WorkflowScenarioResult> {
	const root = await mkdtemp(join(tmpdir(), "pibox-recovery-bench-")); const findings: string[] = [];
	try {
		const store = new HarnessRunStore(root, "recovery");
		const dead = await store.create({ repositoryId: "repo", workItemId: "recovery", taskId: "dead", role: "implementer", attempt: 1, state: "running", workspace: root, baseCommit: "base" });
		const handedOff = await store.create({ repositoryId: "repo", workItemId: "recovery", taskId: "handoff", role: "implementer", attempt: 1, state: "running", workspace: root, baseCommit: "base" });
		await store.writeHandoff(handedOff.record.id, { schemaVersion: 1, type: "task_complete", runId: handedOff.record.id, taskId: "handoff", summary: "done", commits: ["commit"], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString() });
		const malformedRoot = join(store.workItemPrivateRoot, "runs", "malformed-record"); await mkdir(malformedRoot, { recursive: true }); await writeFile(join(malformedRoot, "run.yaml"), "not: [valid");
		const recovered = await store.recoverInterrupted();
		if (!recovered.some((run) => run.id === dead.record.id && run.state === "interrupted")) findings.push("Dead run without a handoff was not marked interrupted.");
		if (!recovered.some((run) => run.id === handedOff.record.id && run.state === "interrupted")) findings.push("Handed-off run retained stale process ownership.");
		if (!await store.readHandoff(handedOff.record.id)) findings.push("Recovery discarded durable handoff evidence needed by a fresh attempt.");
		return result("interrupted-run-recovery", findings);
	} finally { await rm(root, { recursive: true, force: true }); }
}

export async function runDurableChangeRequestScenario(): Promise<WorkflowScenarioResult> {
	const root = await mkdtemp(join(tmpdir(), "pibox-message-bench-")); const findings: string[] = [];
	try {
		const registry = new SessionAgentRegistry(root, "session", 4, 1); await registry.initialize("main:session");
		const reserved = await registry.reserve({ operationId: "attempt-1", parentAgentId: "main:session", parentDepth: 0, role: "implementer", provider: "fake", model: "fake", effort: "medium", assignment: { task: "one" }, workItemId: "change", taskId: "one", workspace: root });
		const { attempt } = await registry.startAttempt(reserved.id); await registry.markRunning(reserved.id, attempt.id);
		const message = await registry.recordMessage(reserved.id, { operationId: "change-1", type: "change_request", blocking: true, summary: "Contract conflicts with repository", rationale: "The persisted field is required", evidence: [{ source: "src/schema.ts", observation: "Field cannot be omitted" }], options: ["Amend the task"], recommendation: "Amend the task" });
		await registry.settleAttempt(reserved.id, attempt.id, { exitCode: 0, reason: "completed", targetState: "completed" });
		if ((await registry.get(reserved.id)).state !== "waiting_decision") findings.push("Blocking change request did not stop the logical agent for a decision.");
		await registry.respondMessage(reserved.id, message.id, "Preserve the field and amend the task acceptance.");
		const fake = join(root, "fake-resume.mjs"); await writeFile(fake, "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'resumed'}]}})); console.log(JSON.stringify({type:'agent_settled'}));\n");
		const service = new SubagentProcessManager({ owner: { sessionId: "session", processInstanceId: "benchmark", activationId: "benchmark" }, sessionDirectory: join(root, "transcripts"), invocationResolver: () => ({ command: process.execPath, args: [fake] }) });
		const coordinator = new LaunchCoordinator(registry, "main:session", service);
		const resumed = await coordinator.launch({ operationId: "attempt-2", existingAgentId: reserved.id, role: "implementer", task: "Resume after durable response", assignment: { task: "one" }, cwd: root, provider: "fake", model: "fake", effort: "medium", tools: [], workItemId: "change", taskId: "one", workspace: root });
		if (resumed.agent.id !== reserved.id) findings.push("Resume allocated a new logical agent instead of reusing identity.");
		if (resumed.agent.attempts.length !== 2) findings.push(`Resume recorded ${resumed.agent.attempts.length} attempts instead of 2.`);
		const answered = (await registry.listMessages(reserved.id)).find((candidate) => candidate.id === message.id);
		if (answered?.response !== "Preserve the field and amend the task acceptance.") findings.push("Orchestrator response was not retained durably.");
		return result("durable-change-request-resume", findings);
	} finally { await rm(root, { recursive: true, force: true }); }
}

export const recoverySafetyScenarios = [runInterruptedRecoveryScenario, runDurableChangeRequestScenario];
