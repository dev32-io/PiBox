import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";
import type { EvaluationManifest, ExecutionStageContract, TaskManifest, WorkItemIndex } from "./types.js";
import { validateStageReviewPolicy } from "./stage-review-policy.js";
import { normalizeChecks } from "./verification-checks.js";
import { resolveVerificationProfile, type ResolvedVerificationProfile } from "./verification-config.js";

const execFileAsync = promisify(execFile);

export type TaskExecutionIsolation = "repository" | "worktree";
export type ResolvedStageMode = "sequential" | "concurrent";

export interface TaskExecutionTopology {
	stageId: string;
	stageIndex: number;
	stageTasks: string[];
	stageSize: number;
	mode: ResolvedStageMode;
	isolation: TaskExecutionIsolation;
	parallelism: "serial" | "allowed";
}

/** Resolve the durable mode, retaining the pre-mode singleton/multi-task behavior. */
export function resolveStageMode(stage: ExecutionStageContract): ResolvedStageMode {
	if (stage.mode === "sequential" || stage.mode === "concurrent") return stage.mode;
	return stage.tasks.length === 1 ? "sequential" : "concurrent";
}

/** Return the planner-authored task stages in durable order. */
export function orderedExecutionStages(item: WorkItemIndex): ExecutionStageContract[] {
	return (item.executionStages ?? []).map((stage) => {
		const review = stage.review?.mode === "skip"
			? { mode: "skip" as const, rationale: stage.review.rationale }
			: stage.review
				? { ...stage.review, ...(stage.review.focus ? { focus: [...stage.review.focus] } : {}) }
				: undefined;
		return { ...stage, tasks: [...stage.tasks], ...(stage.checks ? { checks: [...stage.checks] } : {}), ...(review ? { review } : {}) };
	});
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
	const mode = resolveStageMode(stage);
	// A persisted runtime allocation wins over a newly derived topology during recovery.
	const isolation = retainedRuntimeIsolation(item, task) ?? (mode === "concurrent" ? "worktree" : "repository");
	return {
		stageId: stage.id,
		stageIndex,
		stageTasks: [...stage.tasks],
		stageSize: stage.tasks.length,
		mode,
		isolation,
		parallelism: mode === "concurrent" ? "allowed" : "serial",
	};
}

/** Validate only declarations that can be checked without running project code. Values are never guessed. */
export async function preflightTaskChecks(item: WorkItemIndex, tasks: TaskManifest[], repositoryRoot?: string): Promise<{ missingCommands: string[]; missingEnvironment: string[] }> {
	const stageChecks = orderedExecutionStages(item).flatMap((stage) => normalizeChecks(stage.checks ?? [], `Stage ${stage.id} checks`));
	const taskChecks = [...new Set(tasks.flatMap((task) => task.verification.taskChecks).map((command) => command.trim()).filter(Boolean))].map((command, index) => ({ id: `task-check-${index + 1}`, command }));
	const checks = [...taskChecks, ...stageChecks];
	const missingCommands = new Set<string>();
	const missingEnvironment = new Set<string>();
	const runProbe = async (profile: ResolvedVerificationProfile | undefined, probe: string): Promise<void> => {
		if (!profile) { await execFileAsync("sh", ["-lc", probe], { timeout: 2_000 }); return; }
		const script = [profile.legacy ? undefined : "set -e", profile.bootstrap, probe].filter(Boolean).join("\n");
		await execFileAsync(profile.shell, [profile.legacy ? "-lc" : "-c", script], { cwd: repositoryRoot, timeout: 5_000 });
	};
	for (const check of checks) {
		const profile = repositoryRoot ? await resolveVerificationProfile(repositoryRoot, check) : undefined;
		// Shell syntax is intentionally not interpreted. This catches the common executable
		// and explicit environment prerequisites without pretending to understand every shell.
		const envRefs = [...check.command.matchAll(/(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))/g)]
			.map((m) => m[1] ?? m[2]).filter((name): name is string => Boolean(name));
		for (const name of envRefs) {
			try { await runProbe(profile, `test -n "\${${name}:-}"`); }
			catch { missingEnvironment.add(name); }
		}
		const command = check.command.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|env\s+)+/, "").match(/^(?:command\s+-v\s+)?([A-Za-z0-9_./-]+)/)?.[1];
		if (command && /(?:^|[/._-])(mvn|gradle|gradlew)(?:$|[/._-])/.test(command)) {
			try { await runProbe(profile, "command -v -- java >/dev/null && java -version >/dev/null 2>&1"); } catch { missingCommands.add("java"); }
		}
		if (command && !["if", "then", "fi", "for", "do", "done", "case", "test", "echo", "true", "false"].includes(command)) {
			try {
				const probe = command.includes("/") ? `test -x ${JSON.stringify(command)}` : `command -v -- ${JSON.stringify(command)} >/dev/null`;
				await runProbe(profile, probe);
			} catch { missingCommands.add(command); }
		}
	}
	return { missingCommands: [...missingCommands].sort(), missingEnvironment: [...missingEnvironment].sort() };
}

export interface ExecutionTopologyIssue {
	code: "empty-stage" | "invalid-review-policy" | "unknown-stage-task" | "duplicate-stage-task" | "resource-claim-conflict" | "same-stage-dependency" | "sequential-dependency-order" | "unassigned-task" | "unknown-dependency" | "dependency-order";
	message: string;
	stageId?: string;
	taskId?: string;
	dependency?: string;
	resourceClaim?: string;
}

/** Inspect a planning draft without rejecting temporarily incomplete topology. */
export function executionTopologyIssues(item: WorkItemIndex, tasks: TaskManifest[], evaluations: EvaluationManifest[] = []): ExecutionTopologyIssue[] {
	const issues: ExecutionTopologyIssue[] = [];
	const stages = orderedExecutionStages(item);
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const stageByTask = new Map<string, number>();

	for (const [stageIndex, stage] of stages.entries()) {
		if (stage.tasks.length === 0) issues.push({ code: "empty-stage", stageId: stage.id, message: `Execution stage ${stage.id} must contain at least one task` });
		try { validateStageReviewPolicy(stage.review, `Execution stage ${stage.id} review policy`); }
		catch (error) { issues.push({ code: "invalid-review-policy", stageId: stage.id, message: error instanceof Error ? error.message : String(error) }); }
		const mode = resolveStageMode(stage);
		const claims = new Map<string, string>();
		const taskOrder = new Map(stage.tasks.map((taskId, order) => [taskId, order]));
		for (const taskId of stage.tasks) {
			const task = taskById.get(taskId);
			if (!task) {
				issues.push({ code: "unknown-stage-task", stageId: stage.id, taskId, message: `Execution stage ${stage.id} references unknown task ${taskId}` });
				continue;
			}
			if (stageByTask.has(taskId)) {
				issues.push({ code: "duplicate-stage-task", stageId: stage.id, taskId, message: `Task ${taskId} appears in more than one execution stage` });
				continue;
			}
			stageByTask.set(taskId, stageIndex);
			// Claims protect concurrent worktrees only. Sequential tasks intentionally share
			// the repository and may touch the same resources in declared order.
			if (mode !== "concurrent") continue;
			for (const claim of task.execution.resourceClaims) {
				const owner = claims.get(claim);
				if (owner) issues.push({ code: "resource-claim-conflict", stageId: stage.id, taskId, resourceClaim: claim, message: `Concurrent stage ${stage.id} has conflicting resource claim ${claim} in ${owner} and ${taskId}` });
				else claims.set(claim, taskId);
			}
		}
		// Same-stage dependencies cannot express a meaningful barrier in a concurrent
		// stage. In a sequential stage, order is the barrier; only an earlier declared
		// task may be named as a redundant dependency.
		for (const taskId of stage.tasks) {
			const task = taskById.get(taskId);
			if (!task) continue;
			for (const dependency of task.dependsOn) {
				if (stageByTask.get(dependency) !== stageIndex) continue;
				if (mode === "concurrent") issues.push({ code: "same-stage-dependency", stageId: stage.id, taskId, dependency, message: `Concurrent stage ${stage.id} cannot contain same-stage dependency ${taskId} -> ${dependency}; blockers must be placed in an earlier execution stage` });
				else if ((taskOrder.get(dependency) ?? -1) >= (taskOrder.get(taskId) ?? -1)) issues.push({ code: "sequential-dependency-order", stageId: stage.id, taskId, dependency, message: `Sequential stage ${stage.id} declares ${taskId} before its dependency ${dependency}` });
			}
		}
	}

	for (const task of tasks) {
		const taskStage = stageByTask.get(task.id);
		if (taskStage === undefined) issues.push({ code: "unassigned-task", taskId: task.id, message: `Task ${task.id} is not assigned to an execution stage` });
		for (const dependency of task.dependsOn) {
			const dependencyStage = stageByTask.get(dependency);
			if (!taskById.has(dependency) || dependencyStage === undefined) issues.push({ code: "unknown-dependency", taskId: task.id, dependency, message: `Task ${task.id} depends on unknown or unscheduled task ${dependency}` });
			else if (taskStage !== undefined && dependencyStage > taskStage) issues.push({ code: "dependency-order", taskId: task.id, dependency, message: `Task ${task.id} depends on ${dependency}, but blockers must be placed in an earlier execution stage` });
			// Same-stage dependencies are checked above: concurrent stages reject them,
			// while sequential stages require the dependency to precede the task.
		}
	}
	// Evaluations are runtime-owned gates and are deliberately outside the planner graph.
	void evaluations;
	return issues;
}

/** Compile the complete plan at submission and again before execution. */
export function validateExecutionTopology(item: WorkItemIndex, tasks: TaskManifest[], evaluations: EvaluationManifest[] = []): void {
	const issues = executionTopologyIssues(item, tasks, evaluations);
	if (issues.length === 0) return;
	throw new HarnessError("INVALID_ARTIFACT", `Plan compilation failed with ${issues.length} execution-topology issue${issues.length === 1 ? "" : "s"}:\n${issues.map((issue) => `- ${issue.message}`).join("\n")}`, { issues });
}
