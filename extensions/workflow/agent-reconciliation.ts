import { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { finalizeReviewerAfterSettlement, settleManagedEvaluation } from "./evaluation-settlement.js";
import { RepositoryMutex } from "./idempotency.js";
import type { RepositoryIdentity } from "./repository.js";
import { runGit } from "./repository.js";
import { HarnessRunStore } from "./run-store.js";
import { WorkItemStore } from "./work-items.js";
import { finalizeTaskAgentAfterSettlement, settleManagedTaskHandoff } from "./task-settlement.js";

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
	excludedRunIds?: ReadonlySet<string>;
}): Promise<ReconciliationResult> {
	const result: ReconciliationResult = { completed: [], pending: [], errors: [] };
	for (const agent of (await input.registry.list()).filter((candidate) => candidate.state === "reported" && (!candidate.runId || !input.excludedRunIds?.has(candidate.runId)))) {
		try {
			if (agent.workItemId && agent.runId && agent.taskId) {
				const runs = new HarnessRunStore(input.identity, agent.workItemId);
				const run = await runs.read(agent.runId);
				const handoff = await runs.readHandoff(agent.runId);
				if (!handoff || ["submitted", "awaiting_ci", "changes_requested"].includes(run.state)) { result.pending.push(agent.id); continue; }
				const item = await input.workItems.read(agent.workItemId);
				if (run.planningRevision !== undefined && item.planning.revision !== run.planningRevision) throw new Error(`Planning advanced from revision ${run.planningRevision} to ${item.planning.revision}`);
				const workspace = agent.workspace ?? run.workspace;
				const status = await runGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
				const head = await runGit(workspace, ["rev-parse", "HEAD"]);
				const commits = (await runGit(workspace, ["rev-list", "--reverse", `${run.baseCommit}..HEAD`])).split("\n").filter(Boolean);
				const artifactChanges = await runGit(workspace, ["diff", "--name-only", `${run.baseCommit}..HEAD`, "--", "agent-artifacts"]);
				if (status || artifactChanges || !handoff.commits.includes(head) || handoff.commits.some((commit) => !commits.includes(commit))) throw new Error("Recovered task handoff failed Git or scope validation");
				await settleManagedTaskHandoff({
					workItems: input.workItems,
					runs,
					workItemId: agent.workItemId,
					taskId: agent.taskId,
					runId: agent.runId,
					handoff,
					completedCommit: head,
					exitCode: 0,
					completionEvent: "run.reconciled_completed",
				});
				await finalizeTaskAgentAfterSettlement(input.registry, agent.id, handoff.summary);
				result.completed.push(agent.id);
				continue;
			}

			if (agent.workItemId && agent.runId && agent.evaluationId) {
				const runs = new HarnessRunStore(input.identity, agent.workItemId);
				const handoff = await runs.readEvaluationHandoff(agent.runId);
				if (!handoff) { result.pending.push(agent.id); continue; }
				const run = await runs.read(agent.runId);
				await settleManagedEvaluation({
					workItems: input.workItems,
					runs,
					workItemId: agent.workItemId,
					evaluationId: agent.evaluationId,
					runId: agent.runId,
					handoff,
					reviewerAgentId: agent.id,
					reviewedCommit: run.baseCommit,
					exitCode: 0,
					completionEvent: "run.reconciled_completed",
				});
				// Verdict, not a potentially stale legacy loop label, owns reviewer
				// lifetime. Failed/blocked reviewers persist for repair and re-review.
				const reviewerSettlement = await finalizeReviewerAfterSettlement(input.registry, agent.id, handoff.verdict);
				if (reviewerSettlement !== "completed") result.pending.push(agent.id);
				else result.completed.push(agent.id);
				continue;
			}

			result.pending.push(agent.id);
		} catch (error) {
			result.errors.push({ agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}
