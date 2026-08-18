import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";
import { taskExecutionTopology, type TaskExecutionIsolation } from "./execution-topology.js";
import { assertCleanRepository, isGitPathIgnored, runGit, type RepositoryIdentity } from "./repository.js";
import type { TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function safeSegment(value: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new HarnessError("INVALID_ARTIFACT", `Unsafe workflow identifier: ${value}`);
	return value;
}

export interface AllocatedWorktree {
	path: string;
	branch: string;
	baseCommit: string;
	isolation: TaskExecutionIsolation;
}

export interface IntegrationResult {
	commit: string;
	taskId: string;
	taskIds: string[];
	stageId: string;
	checks: Array<{ command: string; code: number; stdout: string; stderr: string }>;
}

export interface ValidatedWorkingBranch {
	workingBranch: string;
	createdFromCommit: string;
	executionStartCommit?: string;
}

export interface ManagedWorktree {
	name: string;
	path: string;
	branch?: string;
	status: "clean" | "modified";
	active: boolean;
	bytes: number;
}

async function directorySize(path: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		const info = await lstat(child);
		if (info.isDirectory()) total += await directorySize(child);
		else total += info.size;
	}
	return total;
}

export class ResourceLockSet {
	readonly lockRoot: string;
	#acquired: string[] = [];

	constructor(privateRoot: string) {
		this.lockRoot = join(privateRoot, "locks", "resources");
	}

	async acquire(claims: string[], owner: string): Promise<void> {
		for (const claim of [...new Set(claims)].sort()) {
			if (!claim || claim.length > 512 || /[\u0000-\u001f\u007f]/.test(claim)) throw new HarnessError("INVALID_ARTIFACT", "Resource claims must be non-empty, at most 512 characters, and contain no control bytes");
			const lockId = createHash("sha256").update(claim).digest("hex");
			const path = join(this.lockRoot, lockId);
			try {
				await mkdir(path, { recursive: false });
				await import("node:fs/promises").then(({ writeFile }) => writeFile(join(path, "owner"), `${JSON.stringify({ owner, claim })}\n`, { mode: 0o600 }));
				this.#acquired.push(path);
			} catch (error) {
				await this.release();
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					await mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
					return this.acquire(claims, owner);
				}
				throw new HarnessError("CAPABILITY_DENIED", `Resource is locked: ${claim}`);
			}
		}
	}

	async release(): Promise<void> {
		for (const path of this.#acquired.reverse()) await rm(path, { recursive: true, force: true });
		this.#acquired = [];
	}
}

export class WorktreeManager {
	readonly identity: RepositoryIdentity;
	readonly workItems: WorkItemStore;
	readonly worktreeRoot: string;

	constructor(identity: RepositoryIdentity) {
		this.identity = identity;
		this.workItems = new WorkItemStore(identity.root);
		this.worktreeRoot = join(identity.root, ".worktree", "pibox");
	}

	async validateWorkingBranch(workItemId: string): Promise<ValidatedWorkingBranch> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId).catch((error) => error instanceof HarnessError && ["WORK_ITEM_NOT_FOUND", "CAPABILITY_DENIED"].includes(error.code) ? undefined : Promise.reject(error));
		const delivery = item?.delivery ?? await this.workItems.findDelivery(workItemId);
		if (!delivery) throw new HarnessError("INVALID_ARTIFACT", `Work item ${workItemId} has no workingBranch contract`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== delivery.workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Workflow ${workItemId} is bound to ${delivery.workingBranch}; current branch is ${currentBranch || "detached HEAD"}. Workflow start and resume never switch branches.`);
		const exists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${delivery.workingBranch}`], { cwd: this.identity.root }).then(() => true, () => false);
		if (!exists) throw new HarnessError("GIT_OPERATION_FAILED", `Recorded working branch does not exist: ${delivery.workingBranch}`);
		const containsAnchor = await execFileAsync("git", ["merge-base", "--is-ancestor", delivery.createdFromCommit, "HEAD"], { cwd: this.identity.root }).then(() => true, () => false);
		if (!containsAnchor) throw new HarnessError("GIT_OPERATION_FAILED", `Working branch ${delivery.workingBranch} no longer contains its creation anchor ${delivery.createdFromCommit}`);
		return { workingBranch: delivery.workingBranch, createdFromCommit: delivery.createdFromCommit, ...(delivery.executionStartCommit ? { executionStartCommit: delivery.executionStartCommit } : {}) };
	}

	private stageBaseRef(workItemId: string, stageId: string): string {
		return `refs/pibox/stages/${safeSegment(workItemId)}/${safeSegment(stageId)}`;
	}

	private async parallelStageBase(workItemId: string, stageId: string): Promise<string> {
		const ref = this.stageBaseRef(workItemId, stageId);
		const existing = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: this.identity.root, encoding: "utf8" }).then((result) => result.stdout.trim(), () => undefined);
		if (existing) return existing;
		const head = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		await runGit(this.identity.root, ["update-ref", ref, head]);
		return head;
	}

	async allocate(workItemId: string, task: TaskManifest): Promise<AllocatedWorktree> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId);
		for (const dependency of task.dependsOn) {
			const dependencyTask = await this.workItems.readTask(workItemId, dependency);
			if (!["merged", "integrated"].includes(dependencyTask.status)) throw new HarnessError("INVALID_ARTIFACT", `Dependency is not merged: ${dependency}`);
		}
		const workingBranch = item.delivery?.workingBranch;
		if (!workingBranch) throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} has no recorded working branch`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Workflow ${workItemId} must run on ${workingBranch}; current branch is ${currentBranch || "detached HEAD"}`);
		const topology = taskExecutionTopology(item, task);
		if (topology.isolation === "repository") {
			const baseCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			return { path: this.identity.root, branch: workingBranch, baseCommit, isolation: "repository" };
		}
		const branch = `harness/${safeSegment(workItemId)}/${safeSegment(task.id)}`;
		const path = join(this.worktreeRoot, workItemId, task.id);
		if (!(await isGitPathIgnored(this.identity.root, ".worktree/pibox/.ignore-check"))) {
			throw new HarnessError("CONFIG_INVALID", "Repository-local workflow worktrees require an effective /.worktree/ ignore rule. Run /workflow init or add it to .gitignore before task launch.");
		}
		const baseCommit = task.runtime?.baseCommit ?? await this.parallelStageBase(workItemId, topology.stageId);
		await mkdir(join(this.worktreeRoot, workItemId), { recursive: true, mode: 0o700 });

		if (await exists(path)) {
			const actualBranch = await runGit(path, ["branch", "--show-current"]);
			if (actualBranch !== branch) throw new HarnessError("GIT_OPERATION_FAILED", `Existing worktree belongs to ${actualBranch || "detached HEAD"}`);
			const status = await runGit(path, ["status", "--porcelain=v1"]);
			const recordedWorktreeMatches = task.runtime?.worktree === path && task.runtime?.branch === branch;
			if (status && task.status !== "running" && task.status !== "paused" && !recordedWorktreeMatches) {
				throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Recovered task worktree is dirty outside a recorded resumable assignment: ${path}`, { status });
			}
			return { path, branch, baseCommit: task.runtime?.baseCommit ?? baseCommit, isolation: "worktree" };
		}

		const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.identity.root }).then(
			() => true,
			() => false,
		);
		if (branchExists) await runGit(this.identity.root, ["worktree", "add", path, branch]);
		else await runGit(this.identity.root, ["worktree", "add", "-b", branch, path, baseCommit]);
		return { path, branch, baseCommit, isolation: "worktree" };
	}

	async listManaged(): Promise<ManagedWorktree[]> {
		const activePaths = new Set<string>();
		for (const item of await this.workItems.list()) {
			for (const entry of item.tasks) {
				const task = await this.workItems.readTask(item.id, entry.id);
				if (task.runtime?.worktree && !["merged", "integrated", "cancelled"].includes(task.status)) activePaths.add(task.runtime.worktree);
			}
		}
		const output = await runGit(this.identity.root, ["worktree", "list", "--porcelain"]);
		const records: ManagedWorktree[] = [];
		for (const block of output.split("\n\n")) {
			const lines = block.split("\n");
			const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
			if (!path || !path.startsWith(`${this.worktreeRoot}/`) || !(await exists(path))) continue;
			const name = relative(this.worktreeRoot, path);
			const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
			const porcelain = await runGit(path, ["status", "--porcelain=v1"]);
			records.push({ name, path, ...(branchRef ? { branch: branchRef.replace("refs/heads/", "") } : {}), status: porcelain ? "modified" : "clean", active: activePaths.has(path), bytes: await directorySize(path) });
		}
		return records.sort((left, right) => left.name.localeCompare(right.name));
	}

	async removeManaged(name: string, force = false): Promise<ManagedWorktree> {
		const worktree = (await this.listManaged()).find((candidate) => candidate.name === name);
		if (!worktree) throw new HarnessError("INVALID_ARTIFACT", `Unknown PiBox worktree: ${name}`);
		if (worktree.active) throw new HarnessError("CAPABILITY_DENIED", `Worktree is active and cannot be removed: ${name}`);
		if (worktree.status === "modified" && !force) throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Worktree has uncommitted changes: ${name}. Re-run with --force only after preserving the changes.`);
		await runGit(this.identity.root, ["worktree", "remove", ...(force ? ["--force"] : []), "--", worktree.path]);
		await rm(dirname(worktree.path), { recursive: false, force: true }).catch(() => undefined);
		return worktree;
	}

	async cleanupManaged(): Promise<ManagedWorktree[]> {
		const removable = (await this.listManaged()).filter((worktree) => !worktree.active && worktree.status === "clean");
		for (const worktree of removable) await this.removeManaged(worktree.name);
		return removable;
	}

	/** Return private conflict evidence captured after the canonical checkout was rolled back clean. */
	async activeConflict(workItemId: string): Promise<{ stageId: string; taskIds: string[]; evidencePath: string } | undefined> {
		const root = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId));
		const entries = (await readdir(root).catch(() => [])).filter((entry) => entry.endsWith(".txt")).sort();
		const evidencePath = entries.length ? join(root, entries[entries.length - 1]!) : undefined;
		if (!evidencePath) return undefined;
		const content = await readFile(evidencePath, "utf8");
		const headers = new Map<string, string>();
		for (const line of content.split(/\\r?\\n/)) {
			const separator = line.indexOf(":");
			if (separator < 0) continue;
			headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
		}
		const stageId = headers.get("stage");
		const taskIds = (headers.get("tasks") ?? "").split(",").map((taskId) => taskId.trim()).filter(Boolean);
		const validId = (value: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(value);
		if (!stageId || !validId(stageId) || taskIds.length === 0 || taskIds.some((taskId) => !validId(taskId))) {
			throw new HarnessError("INVALID_ARTIFACT", `Malformed integration conflict evidence: ${evidencePath}`);
		}
		return { stageId, taskIds, evidencePath };
	}

	async runStageChecks(workItemId: string, stageId: string, taskIds: string[]): Promise<IntegrationResult["checks"]> {
		const item = await this.workItems.read(workItemId);
		const tasks = await Promise.all(taskIds.map((taskId) => this.workItems.readTask(workItemId, taskId)));
		const stage = (item.executionStages ?? []).find((candidate) => candidate.id === stageId);
		const commands = stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))];
		const results: IntegrationResult["checks"] = [];
		for (const command of commands) {
			const result = await runShell(command, this.identity.root);
			results.push({ command, ...result });
			if (result.code !== 0) throw new HarnessError("GIT_OPERATION_FAILED", `Post-repair check failed: ${command}\n${result.stderr || result.stdout}`);
		}
		return results;
	}

	async clearConflict(workItemId: string, evidencePath: string): Promise<void> {
		const conflictRoot = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId));
		const expected = join(conflictRoot, evidencePath.slice(conflictRoot.length + 1));
		if (expected !== evidencePath || !evidencePath.startsWith(`${conflictRoot}/`)) throw new HarnessError("INVALID_ARTIFACT", "Conflict evidence path escapes its private work-item root");
		await rm(evidencePath, { force: true });
		const remaining = await readdir(conflictRoot).catch(() => []);
		if (remaining.length === 0) await rm(conflictRoot, { recursive: true, force: true });
	}

	async mergeTask(workItemId: string, taskId: string, checks?: string[]): Promise<IntegrationResult> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId);
		const workingBranch = item.delivery?.workingBranch;
		if (!workingBranch) throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} has no recorded working branch`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Task merges require ${workingBranch}; current branch is ${currentBranch || "detached HEAD"}`);

		const requestedTask = await this.workItems.readTask(workItemId, taskId);
		const topology = taskExecutionTopology(item, requestedTask);
		// The resolved stage mode owns the integration boundary. Sequential tasks are
		// integrated one at a time so the canonical branch is the next task's base;
		// concurrent stages alone use the listed-order stage barrier.
		const concurrentStage = topology.mode === "concurrent";
		const taskIds = concurrentStage ? topology.stageTasks : [taskId];
		const tasks = await Promise.all(taskIds.map((id) => this.workItems.readTask(workItemId, id)));
		const pending = tasks.filter((task) => !["merged", "integrated"].includes(task.status));
		if (pending.length === 0) {
			return { commit: requestedTask.runtime?.mergedCommit ?? await runGit(this.identity.root, ["rev-parse", "HEAD"]), taskId, taskIds, stageId: topology.stageId, checks: [] };
		}
		for (const task of pending) {
			if (!task.runtime?.completedCommit) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} has no completed contribution commit`);
			if (!["contribution_complete", "accepted", "merge_queued", "merging", "staged", "integrating"].includes(task.status)) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} is not ready to merge from ${task.status}`);
		}

		const baseCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		const checkResults: IntegrationResult["checks"] = [];
		try {
			if (!concurrentStage) {
				const completedCommit = pending[0]!.runtime!.completedCommit!;
				const present = await execFileAsync("git", ["merge-base", "--is-ancestor", completedCommit, "HEAD"], { cwd: this.identity.root }).then(() => true, () => false);
				if (!present) throw new HarnessError("INVALID_HANDOFF", `Repository task ${pending[0]!.id} commit is not present on ${workingBranch}`);
			} else {
				for (const task of pending) {
					const taskBranch = task.runtime?.branch;
					if (!taskBranch) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} has no recorded branch`);
					await runGit(this.identity.root, ["merge", "--no-ff", "--no-edit", taskBranch]);
				}
			}

			const stage = (item.executionStages ?? []).find((candidate) => candidate.id === topology.stageId);
			const isFinalSequentialTask = topology.mode === "sequential" && topology.stageTasks.indexOf(taskId) === topology.stageTasks.length - 1;
			const commands = concurrentStage || isFinalSequentialTask ? checks ?? stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))] : [];
			for (const command of commands) {
				const result = await runShell(command, this.identity.root);
				checkResults.push({ command, ...result });
				if (result.code !== 0) throw new HarnessError("INVALID_HANDOFF", `Post-stage check failed: ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, result);
			}
			const integratedCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			for (const task of pending) await this.workItems.updateTask(workItemId, task.id, { status: "merged", runtime: { mergedCommit: integratedCommit } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = await runGit(this.identity.root, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "");
			const conflicted = /(^|\\n)UU |(^|\\n)AA |(^|\\n)DD |(^|\\n)AU |(^|\\n)UA /.test(status) || message.includes("CONFLICT");
			if (conflicted) {
				// Capture the failed merge before restoring the canonical branch. Contributor
				// branches remain intact, so a harness-owned repair can reproduce the merge
				// without exposing users to a dirty or half-merged working branch.
				const evidencePath = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId), `${safeSegment(topology.stageId)}-${Date.now()}.txt`);
				await mkdir(dirname(evidencePath), { recursive: true });
				const diff = await runGit(this.identity.root, ["diff", "--cc"]).catch(() => "");
				await writeFile(evidencePath, `stage: ${topology.stageId}\ntasks: ${taskIds.join(", ")}\nbase: ${baseCommit}\nstatus:\n${status}\nconflict:\n${message}\ncombined diff:\n${diff}`, "utf8");
				await runGit(this.identity.root, ["merge", "--abort"]).catch(() => undefined);
				await runGit(this.identity.root, ["reset", "--hard", baseCommit]);
				throw new HarnessError("GIT_OPERATION_FAILED", `Stage ${topology.stageId} integration conflict requires managed repair. The working branch was restored clean; contributor branches and private evidence are preserved at ${evidencePath}. Resume through the harness repair path.`, { conflict: true, stageId: topology.stageId, taskIds, evidencePath, baseCommit });
			}
			// Non-conflict failures retain the prior atomic rollback behavior.
			await runGit(this.identity.root, ["merge", "--abort"]).catch(() => undefined);
			await runGit(this.identity.root, ["reset", "--hard", baseCommit]).catch(() => undefined);
			if (error instanceof HarnessError) throw error;
			throw new HarnessError("GIT_OPERATION_FAILED", `Atomic stage merge failed for ${topology.stageId}: ${message}`);
		}
		// Stage refs are concurrency barriers, never sequential-task state.
		if (concurrentStage) await runGit(this.identity.root, ["update-ref", "-d", this.stageBaseRef(workItemId, topology.stageId)]).catch(() => undefined);
		await this.workItems.refreshReadyTasks(workItemId);
		return { commit: await runGit(this.identity.root, ["rev-parse", "HEAD"]), taskId, taskIds, stageId: topology.stageId, checks: checkResults };
	}
}

function runShell(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("/bin/sh", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data.toString()));
		child.stderr.on("data", (data) => (stderr += data.toString()));
		child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}
