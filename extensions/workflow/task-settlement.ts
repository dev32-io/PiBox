import type { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { HarnessError } from "./errors.js";
import { HarnessRunStore, type RunRecord, type TaskHandoff } from "./run-store.js";
import type { TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { WorkflowControlStore } from "../workflow-runtime/control-store.js";

const SETTLED_TASK_STATES = new Set<TaskManifest["status"]>([
	"contribution_complete",
	"reviewing",
	"changes_requested",
	"accepted",
	"merge_queued",
	"merging",
	"merged",
	"staged",
	"integrating",
	"integrated",
]);

export interface ManagedTaskSettlementInput {
	workItems: WorkItemStore;
	runs: HarnessRunStore;
	workItemId: string;
	taskId: string;
	runId: string;
	handoff: TaskHandoff;
	completedCommit: string;
	exitCode: number;
	completionEvent: "run.completed" | "run.reconciled_completed";
	assertActive?: () => void | Promise<void>;
}

export interface ManagedTaskSettlement {
	run: RunRecord;
	task: TaskManifest;
	runSettled: boolean;
	taskSettled: boolean;
}

/**
 * Atomically project one durable task handoff into canonical run/task state.
 *
 * Live supervisor settlement and recovery reconciliation intentionally share
 * this operation. Either may win; the loser observes the same completed run
 * and contribution without emitting duplicate completion events or commits.
 */
export async function settleManagedTaskHandoff(input: ManagedTaskSettlementInput): Promise<ManagedTaskSettlement> {
	if (input.handoff.runId !== input.runId || input.handoff.taskId !== input.taskId) {
		throw new HarnessError("INVALID_HANDOFF", `Task handoff does not match run ${input.runId}`);
	}
	return input.workItems.coordinator.run(`managed-task-settlement:${input.runId}`, async () => {
		const assertCurrent = async () => {
			await input.assertActive?.();
			const currentRun = await input.runs.read(input.runId);
			if (["cancelled", "interrupted"].includes(currentRun.state)) throw new HarnessError("CAPABILITY_DENIED", `Task run ${input.runId} is ${currentRun.state}`);
			if (currentRun.workflowOwnerActivationId || currentRun.workflowOwnerProcessInstanceId) {
				const control = await new WorkflowControlStore(input.workItems.privateRoot).get(`work-item:${input.workItemId}`);
				let fencedState: "cancelled" | "interrupted" | undefined;
				if (control && (control.ownerActivationId !== currentRun.workflowOwnerActivationId || control.ownerProcessInstanceId !== currentRun.workflowOwnerProcessInstanceId)) fencedState = "interrupted";
				else if (!control || control.mode === "stopped" || control.mode === "completed" || (currentRun.workflowExecutionFence !== undefined && control.executionFence !== currentRun.workflowExecutionFence)) fencedState = "cancelled";
				if (fencedState) {
					await input.runs.update(input.runId, { state: fencedState, currentAgentAttemptId: undefined, currentAgentGeneration: undefined, credentialRevokedAt: new Date().toISOString(), error: fencedState === "cancelled" ? "Task cancelled by workflow stop" : "Task owner activation was replaced" }, `run.${fencedState}`);
					throw new HarnessError("CAPABILITY_DENIED", `Task run ${input.runId} belongs to a stopped or replaced workflow activation`);
				}
			}
			if (currentRun.workflowExecutionFence !== undefined) await input.runs.assertCanonicalMutationAllowed(input.runId);
		};
		await assertCurrent();
		let run = await input.runs.read(input.runId);
		if (run.workItemId !== input.workItemId || run.taskId !== input.taskId) {
			throw new HarnessError("INVALID_HANDOFF", `Task run ${input.runId} has a mismatched canonical scope`);
		}
		let task = await input.workItems.readTask(input.workItemId, input.taskId);
		if (task.runtime?.completedCommit && task.runtime.completedCommit !== input.completedCommit) {
			throw new HarnessError("INVALID_HANDOFF", `Task ${input.taskId} already settled at another contribution commit`);
		}

		let taskSettled = false;
		if (task.runtime?.completedCommit !== input.completedCommit || !SETTLED_TASK_STATES.has(task.status)) {
			await assertCurrent();
			task = await input.workItems.updateTask(input.workItemId, input.taskId, {
				status: "contribution_complete",
				runtime: { completedCommit: input.completedCommit },
			});
			taskSettled = true;
		}

		let runSettled = false;
		if (!taskSettled) await assertCurrent();
		run = await input.runs.read(input.runId);
		if (run.state !== "completed") {
			run = await input.runs.update(input.runId, { state: "completed", exitCode: input.exitCode }, input.completionEvent);
			runSettled = true;
		}
		return { run, task, runSettled, taskSettled };
	});
}

/** Complete a reported task agent without turning a concurrent replay into a failure. */
export async function finalizeTaskAgentAfterSettlement(registry: SessionAgentRegistry, agentId: string, summary: string): Promise<void> {
	let agent = await registry.get(agentId);
	if (agent.state === "completed") return;
	try {
		await registry.transition(agentId, "completed", { summary });
	} catch (error) {
		// Reconciliation and the live supervisor can settle the same durable
		// handoff concurrently. Completion by either owner satisfies the boundary.
		agent = await registry.get(agentId);
		if (agent.state === "completed") return;
		throw error;
	}
}
