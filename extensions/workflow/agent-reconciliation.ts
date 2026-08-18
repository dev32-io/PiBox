import { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { RepositoryMutex } from "./idempotency.js";
import type { RepositoryIdentity } from "./repository.js";
import { runGit } from "./repository.js";
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
				if (run.planningRevision !== undefined && item.planning.revision !== run.planningRevision) throw new Error(`Planning advanced from revision ${run.planningRevision} to ${item.planning.revision}`);
				const workspace = agent.workspace ?? run.workspace;
				const status = await runGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
				const head = await runGit(workspace, ["rev-parse", "HEAD"]);
				const commits = (await runGit(workspace, ["rev-list", "--reverse", `${run.baseCommit}..HEAD`])).split("\n").filter(Boolean);
				const artifactChanges = await runGit(workspace, ["diff", "--name-only", `${run.baseCommit}..HEAD`, "--", "agent-artifacts"]);
				if (status || artifactChanges || !handoff.commits.includes(head) || handoff.commits.some((commit) => !commits.includes(commit))) throw new Error("Recovered task handoff failed Git or scope validation");
				await input.workItems.coordinator.run(`reconcile-task:${agent.id}`, async () => {
					const currentRun = await runs.read(agent.runId!);
					const currentTask = await input.workItems.readTask(agent.workItemId!, agent.taskId!);
					if (currentTask.runtime?.completedCommit !== head || !["contribution_complete", "reviewing", "changes_requested", "accepted", "merge_queued", "merging", "merged", "staged", "integrating", "integrated"].includes(currentTask.status)) {
						await input.workItems.updateTask(agent.workItemId!, agent.taskId!, { status: "contribution_complete", runtime: { completedCommit: head } });
					}
					if (currentRun.state !== "completed") await runs.update(agent.runId!, { state: "completed", exitCode: 0 }, "run.reconciled_completed");
				});
				await input.registry.transition(agent.id, "completed", { summary: handoff.summary });
				result.completed.push(agent.id);
				continue;
			}

			if (agent.workItemId && agent.runId && agent.evaluationId) {
				const runs = new HarnessRunStore(input.identity.privateRoot, agent.workItemId);
				const handoff = await runs.readEvaluationHandoff(agent.runId);
				if (!handoff) { result.pending.push(agent.id); continue; }
				// The attempt check, canonical record, and run settlement are one mutation:
				// a second reconciler cannot observe the old attempt between these steps.
				const settled = await input.workItems.coordinator.run(`reconcile-evaluation:${agent.id}`, async () => {
					// The run must be read after acquiring the canonical lock. Otherwise an
					// evaluation checkpoint can race this settlement and produce a second
					// completion event from stale state.
					const run = await runs.read(agent.runId!);
					const current = await input.workItems.readEvaluation(agent.workItemId!, agent.evaluationId!);
					if (current.attempt < run.attempt) await input.workItems.recordEvaluation({ workItemId: agent.workItemId!, evaluationId: agent.evaluationId!, verdict: handoff.verdict, report: handoff.report, evidence: handoff.evidence, findings: handoff.findings, ...(handoff.residualRisks ? { residualRisks: handoff.residualRisks } : {}) });
					const freshRun = await runs.read(agent.runId!);
					if (freshRun.state !== "completed") await runs.update(agent.runId!, { state: "completed", exitCode: 0 }, "run.reconciled_completed");
					return input.workItems.readEvaluation(agent.workItemId!, agent.evaluationId!);
				});
				// A failed review is a checkpoint, not the end of the logical reviewer.
				// Keep it reported so a later repair/re-review can reuse its identity.
				if (settled.loop?.state === "awaiting_manager" || settled.loop?.state === "fixing" || settled.loop?.state === "rereviewing") {
					result.pending.push(agent.id);
					continue;
				}
				await input.registry.transition(agent.id, "completed", { summary: `Evaluation ${agent.evaluationId}: ${handoff.verdict}` });
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
