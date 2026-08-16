import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";
import type { EvaluationManifest, TaskManifest, WorkItemIndex } from "./types.js";

const execFileAsync = promisify(execFile);

export type TaskExecutionIsolation = "repository" | "worktree";

export interface TaskExecutionTopology {
	stageId: string;
	stageIndex: number;
	stageTasks: string[];
	stageSize: number;
	isolation: TaskExecutionIsolation;
	parallelism: "serial" | "allowed";
}

export type StagedNode = { kind: "task" | "evaluation"; id: string };
export type ExecutionStage = { id: string; tasks: string[]; nodes?: StagedNode[]; checks?: string[] };

/** Normalize both the unified graph and schema-v1 task-only stages without persisting it. */
export function orderedExecutionStages(item: WorkItemIndex): ExecutionStage[] {
	const raw = (item.executionStages ?? item.integrationUnits.map((unit) => ({ id: unit.id, tasks: [...unit.tasks] }))) as ExecutionStage[];
	return raw.map((stage) => ({
		...stage,
		tasks: [...stage.tasks],
		nodes: stage.nodes ? stage.nodes.map((node) => ({ ...node })) : stage.tasks.map((id) => ({ kind: "task" as const, id })),
	}));
}

export function stageNodes(stage: ExecutionStage): StagedNode[] {
	return stage.nodes ?? stage.tasks.map((id) => ({ kind: "task", id }));
}

function retainedRuntimeIsolation(item: WorkItemIndex, task: TaskManifest): TaskExecutionIsolation | undefined {
	if (task.runtime?.executionMode) return task.runtime.executionMode;
	if (!task.runtime?.branch) return undefined;
	if (task.runtime.branch.startsWith("harness/")) return "worktree";
	if (item.delivery?.workingBranch && task.runtime.branch === item.delivery.workingBranch) return "repository";
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

/** Validate only declarations that can be checked without running project code. Values are never guessed. */
export async function preflightTaskChecks(item: WorkItemIndex, tasks: TaskManifest[]): Promise<{ missingCommands: string[]; missingEnvironment: string[] }> {
	const stageChecks = orderedExecutionStages(item).flatMap((stage) => stage.checks ?? []);
	const checks = [...new Set([...tasks.flatMap((task) => task.verification.taskChecks), ...stageChecks].map((check) => check.trim()).filter(Boolean))];
	const missingCommands = new Set<string>();
	const missingEnvironment = new Set<string>();
	for (const check of checks) {
		// Shell syntax is intentionally not interpreted. This catches the common executable
		// and explicit environment prerequisites without pretending to understand every shell.
		const envRefs = [...check.matchAll(/(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))/g)]
			.map((m) => m[1] ?? m[2]).filter((name): name is string => Boolean(name));
		for (const name of envRefs) if (!process.env[name]?.trim()) missingEnvironment.add(name);
		const command = check.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|env\s+)+/, "").match(/^(?:command\s+-v\s+)?([A-Za-z0-9_./-]+)/)?.[1];
		if (command && /(?:^|[/._-])(mvn|gradle|gradlew)(?:$|[/._-])/.test(command)) {
			try { await execFileAsync("sh", ["-lc", "command -v -- java"], { timeout: 2_000 }); } catch { missingCommands.add("java"); }
		}
		if (command && !["if", "then", "fi", "for", "do", "done", "case", "test", "echo", "true", "false"].includes(command)) {
			try {
				const probe = command.includes("/") ? `test -x ${JSON.stringify(command)}` : `command -v -- ${JSON.stringify(command)}`;
				await execFileAsync("sh", ["-lc", probe], { timeout: 2_000 });
			} catch { missingCommands.add(command); }
		}
	}
	return { missingCommands: [...missingCommands].sort(), missingEnvironment: [...missingEnvironment].sort() };
}

/** Validate the unified staged graph at submission and transaction boundaries. */
export function validateExecutionTopology(item: WorkItemIndex, tasks: TaskManifest[], evaluations: EvaluationManifest[] = []): void {
	const stages = orderedExecutionStages(item);
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const evaluationById = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
	const stageByNode = new Map<string, number>();
	const key = (kind: StagedNode["kind"], id: string) => `${kind}:${id}`;

	for (const [stageIndex, stage] of stages.entries()) {
		const nodes = stageNodes(stage);
		if (nodes.length === 0) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} must contain at least one task or evaluation`);
		const claims = new Map<string, string>();
		for (const node of nodes) {
			if (node.kind === "task" && !taskById.has(node.id)) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} references unknown task ${node.id}`);
			if (node.kind === "evaluation" && !evaluationById.has(node.id)) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} references unknown evaluation ${node.id}`);
			const nodeKey = key(node.kind, node.id);
			if (stageByNode.has(nodeKey)) throw new HarnessError("INVALID_ARTIFACT", `${node.kind} ${node.id} appears in more than one execution stage`);
			stageByNode.set(nodeKey, stageIndex);
			if (node.kind !== "task" || nodes.length === 1) continue;
			for (const claim of taskById.get(node.id)!.execution.resourceClaims) {
				const owner = claims.get(claim);
				if (owner) throw new HarnessError("INVALID_ARTIFACT", `Parallel stage ${stage.id} has conflicting resource claim ${claim} in ${owner} and ${node.id}`);
				claims.set(claim, node.id);
			}
		}
	}

	for (const task of tasks) {
		const taskStage = stageByNode.get(key("task", task.id));
		if (taskStage === undefined) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} is not assigned to an execution stage`);
		for (const dependency of task.dependsOn) {
			const dependencyStage = stageByNode.get(key("task", dependency));
			if (dependencyStage === undefined) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} depends on unknown or unscheduled task ${dependency}`);
			if (dependencyStage >= taskStage) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} depends on ${dependency}, but blockers must be placed in an earlier execution stage`);
		}
	}
	for (const evaluation of evaluations) {
		const declaresStage = Boolean(evaluation.stageId || evaluation.scope.integrationUnit);
		if ((evaluation.dependsOn?.length ?? 0) > 0 && !declaresStage) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} declares graph blockers but has no execution stage`);
		if (!declaresStage) continue;
		const evaluationStage = stageByNode.get(key("evaluation", evaluation.id));
		if (evaluationStage === undefined) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} is not assigned to its declared execution stage`);
		for (const dependency of evaluation.dependsOn ?? []) {
			const explicit = dependency.match(/^(task|evaluation):(.+)$/);
			const candidates = explicit ? [key(explicit[1] as StagedNode["kind"], explicit[2]!)] : [key("task", dependency), key("evaluation", dependency)].filter((candidate) => stageByNode.has(candidate));
			if (candidates.length !== 1) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} dependency ${dependency} is unknown or ambiguous`);
			const dependencyStage = stageByNode.get(candidates[0]!);
			if (dependencyStage === undefined || dependencyStage >= evaluationStage) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${evaluation.id} depends on ${dependency}, but blockers must be placed in an earlier execution stage`);
		}
	}
}
