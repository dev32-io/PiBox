import { HarnessError } from "./errors.js";
import type { TaskManifest, WorkItemIndex } from "./types.js";

export type TaskExecutionIsolation = "repository" | "worktree";

export interface TaskExecutionTopology {
	stageId: string;
	stageIndex: number;
	stageTasks: string[];
	stageSize: number;
	isolation: TaskExecutionIsolation;
	parallelism: "serial" | "allowed";
}

export function orderedExecutionStages(item: WorkItemIndex): Array<{ id: string; tasks: string[]; checks?: string[] }> {
	return item.executionStages ?? item.integrationUnits.map((unit) => ({ id: unit.id, tasks: [...unit.tasks] }));
}

function retainedRuntimeIsolation(item: WorkItemIndex, task: TaskManifest): TaskExecutionIsolation | undefined {
	if (task.runtime?.executionMode) return task.runtime.executionMode;
	if (!task.runtime?.branch) return undefined;
	if (task.runtime.branch.startsWith("harness/")) return "worktree";
	if (item.delivery?.featureBranch && task.runtime.branch === item.delivery.featureBranch) return "repository";
	return undefined;
}

/** Runtime execution mechanics are derived from the reviewed stage graph, never selected by the planner. */
export function taskExecutionTopology(item: WorkItemIndex, task: TaskManifest): TaskExecutionTopology {
	const stages = orderedExecutionStages(item);
	const stageIndex = stages.findIndex((stage) => stage.tasks.includes(task.id));
	if (stageIndex < 0) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} is not assigned to an execution stage`);
	const stage = stages[stageIndex]!;
	const isolation = retainedRuntimeIsolation(item, task) ?? (stage.tasks.length > 1 ? "worktree" : "repository");
	return {
		stageId: stage.id,
		stageIndex,
		stageTasks: [...stage.tasks],
		stageSize: stage.tasks.length,
		isolation,
		parallelism: stage.tasks.length > 1 ? "allowed" : "serial",
	};
}

/** Validate the stage graph at submission, after draft mutations have had room to settle. */
export function validateExecutionTopology(item: WorkItemIndex, tasks: TaskManifest[]): void {
	const stages = orderedExecutionStages(item);
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const stageByTask = new Map<string, number>();

	for (const [stageIndex, stage] of stages.entries()) {
		if (stage.tasks.length === 0) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} must contain at least one task`);
		const claims = new Map<string, string>();
		for (const taskId of stage.tasks) {
			if (!taskById.has(taskId)) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} references unknown task ${taskId}`);
			if (stageByTask.has(taskId)) throw new HarnessError("INVALID_ARTIFACT", `Task ${taskId} appears in more than one execution stage`);
			stageByTask.set(taskId, stageIndex);
			if (stage.tasks.length === 1) continue;
			for (const claim of taskById.get(taskId)!.execution.resourceClaims) {
				const owner = claims.get(claim);
				if (owner) throw new HarnessError("INVALID_ARTIFACT", `Parallel stage ${stage.id} has conflicting resource claim ${claim} in ${owner} and ${taskId}`);
				claims.set(claim, taskId);
			}
		}
	}

	for (const task of tasks) {
		const taskStage = stageByTask.get(task.id);
		if (taskStage === undefined) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} is not assigned to an execution stage`);
		for (const dependency of task.dependsOn) {
			const dependencyStage = stageByTask.get(dependency);
			if (dependencyStage === undefined) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} depends on unknown or unscheduled task ${dependency}`);
			if (dependencyStage >= taskStage) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} depends on ${dependency}, but blockers must be placed in an earlier execution stage`);
		}
	}
}
