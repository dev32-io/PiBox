import { join } from "node:path";
import { SessionAgentRegistry } from "./agent-registry.js";
import { validateExplorationHandoff, type ExplorationAssignment, type ExplorationHandoff } from "./exploration-contracts.js";
import { RepositoryMutex } from "./idempotency.js";
import type { RepositoryIdentity } from "./repository.js";
import { readTextIfExists, runGit } from "./repository.js";
import { HarnessRunStore } from "./run-store.js";
import { WorkItemStore } from "./work-items.js";

export interface ReconciliationResult {
	completed: string[];
	pending: string[];
	errors: Array<{ agentId: string; error: string }>;
}

/** Finalize durable child reports after the original in-memory supervisor is gone. */
export async function reconcileReportedAgents(input: {
	identity: RepositoryIdentity;
	registry: SessionAgentRegistry;
	workItems: WorkItemStore;
	mutex: RepositoryMutex;
}): Promise<ReconciliationResult> {
	const result: ReconciliationResult = { completed: [], pending: [], errors: [] };
	for (const agent of (await input.registry.list()).filter((candidate) => candidate.state === "reported")) {
		try {
			if (agent.workItemId && agent.runId && agent.taskId) {
				const runs = new HarnessRunStore(input.identity.privateRoot, agent.workItemId);
				const run = await runs.read(agent.runId);
				const handoff = await runs.readHandoff(agent.runId);
				if (!handoff) { result.pending.push(agent.id); continue; }
				const item = await input.workItems.read(agent.workItemId);
				if (item.planning.status !== "approved" || item.planning.revision !== run.planningRevision) throw new Error(`Planning changed to ${item.planning.status} r${item.planning.revision}`);
				const workspace = agent.workspace ?? run.workspace;
				const status = await runGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
				const head = await runGit(workspace, ["rev-parse", "HEAD"]);
				const commits = (await runGit(workspace, ["rev-list", "--reverse", `${run.baseCommit}..HEAD`])).split("\n").filter(Boolean);
				const artifactChanges = await runGit(workspace, ["diff", "--name-only", `${run.baseCommit}..HEAD`, "--", "agent-artifacts"]);
				if (status || artifactChanges || !handoff.commits.includes(head) || handoff.commits.some((commit) => !commits.includes(commit))) throw new Error("Recovered task handoff failed Git or scope validation");
				await input.mutex.run(`reconcile-task:${agent.id}`, async () => {
					await input.workItems.updateTask(agent.workItemId!, agent.taskId!, { status: "contribution_complete", runtime: { completedCommit: head } });
					await runs.update(agent.runId!, { state: "completed", exitCode: 0 }, "run.reconciled_completed");
				});
				await input.registry.transition(agent.id, "completed", { summary: handoff.summary });
				result.completed.push(agent.id);
				continue;
			}

			if (agent.workItemId && agent.runId && agent.evaluationId) {
				const runs = new HarnessRunStore(input.identity.privateRoot, agent.workItemId);
				const handoff = await runs.readEvaluationHandoff(agent.runId);
				if (!handoff) { result.pending.push(agent.id); continue; }
				await input.mutex.run(`reconcile-evaluation:${agent.id}`, async () => {
					await input.workItems.recordEvaluation({ workItemId: agent.workItemId!, evaluationId: agent.evaluationId!, verdict: handoff.verdict, report: handoff.report, evidence: handoff.evidence, findings: handoff.findings, ...(handoff.residualRisks ? { residualRisks: handoff.residualRisks } : {}) });
					await runs.update(agent.runId!, { state: "completed", exitCode: 0 }, "run.reconciled_completed");
				});
				await input.registry.transition(agent.id, "completed", { summary: `Evaluation ${agent.evaluationId}: ${handoff.verdict}` });
				result.completed.push(agent.id);
				continue;
			}

			const root = join(input.registry.root, "agents", agent.id);
			if (agent.role === "explorer") {
				const assignmentText = await readTextIfExists(join(input.registry.root, agent.assignmentPath));
				const handoffText = await readTextIfExists(join(root, "handoff.json"));
				if (!assignmentText || !handoffText) { result.pending.push(agent.id); continue; }
				const assignment = JSON.parse(assignmentText) as ExplorationAssignment;
				const handoff = JSON.parse(handoffText) as ExplorationHandoff;
				validateExplorationHandoff(handoff, assignment);
				await input.registry.transition(agent.id, "completed", { summary: handoff.answer });
				result.completed.push(agent.id);
				continue;
			}
			result.pending.push(agent.id);
		} catch (error) {
			result.errors.push({ agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}
