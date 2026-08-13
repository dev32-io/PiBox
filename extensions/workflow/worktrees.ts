import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { taskExecutionTopology, type TaskExecutionIsolation } from "./execution-topology.js";
import { assertCleanRepository, atomicWriteFile, isGitPathIgnored, runGit, type RepositoryIdentity } from "./repository.js";
import type { TaskManifest, WorkItemIndex } from "./types.js";
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

export interface PreparedFeatureBranch {
	baseBranch: string;
	featureBranch: string;
	created: boolean;
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

	async prepareFeatureBranch(workItemId: string): Promise<PreparedFeatureBranch> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (!currentBranch) throw new HarnessError("GIT_OPERATION_FAILED", "Workflow start requires a named branch checkout");

		// Existing recorded branches remain authoritative for backward-compatible resume.
		if (item.delivery?.featureBranch && !item.delivery.branchMode) {
			if (!(await this.branchExists(item.delivery.featureBranch))) throw new HarnessError("GIT_OPERATION_FAILED", `Recorded delivery branch does not exist: ${item.delivery.featureBranch}`);
			if (currentBranch !== item.delivery.featureBranch) await runGit(this.identity.root, ["switch", item.delivery.featureBranch]);
			return { baseBranch: item.delivery.baseBranch, featureBranch: item.delivery.featureBranch, created: false };
		}

		const delivery = item.delivery;
		if (!delivery?.branchType || !delivery.branchMode) throw new HarnessError("INVALID_ARTIFACT", `Work item ${workItemId} must declare delivery.branchType (feature|fix), delivery.branchMode (create|continue), and baseBranch develop before workflow start`);
		const baseBranch = delivery.baseBranch;
		if (baseBranch !== "develop") throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} must use develop as its base branch`);
		const featureBranch = delivery.featureBranch ?? `${delivery.branchType}/${safeSegment(workItemId)}`;

		// branchMode records whether this delivery originally created or continued a branch;
		// it is not rewritten after startup. A matching started delivery branch is therefore
		// authoritative on resume, including when reload occurs while develop is checked out.
		if (delivery.branchMode === "create" && await this.startedDeliveryExists(workItemId, featureBranch)) {
			if (currentBranch !== featureBranch) {
				if (currentBranch !== baseBranch) throw new HarnessError("CAPABILITY_DENIED", `Resumed workflow ${workItemId} requires ${featureBranch} or its base ${baseBranch}; current branch is ${currentBranch}`);
				await runGit(this.identity.root, ["switch", featureBranch]);
			}
			return { baseBranch, featureBranch, created: false };
		}

		if (delivery.branchMode === "continue") {
			if (currentBranch !== featureBranch) throw new HarnessError("CAPABILITY_DENIED", `Continued workflow ${workItemId} requires current branch ${featureBranch}; current branch is ${currentBranch}`);
			if (!(await this.branchExists(featureBranch))) throw new HarnessError("GIT_OPERATION_FAILED", `Continued delivery branch does not exist: ${featureBranch}`);
			return { baseBranch, featureBranch, created: false };
		}

		if (currentBranch !== baseBranch) throw new HarnessError("CAPABILITY_DENIED", `New workflow ${workItemId} must start from ${baseBranch}; current branch is ${currentBranch}. Switch intentionally after preserving any branch-local planning work.`);
		// Local-only repositories have no upstream to synchronize. If origin is configured,
		// keep failing closed on an inaccessible remote rather than silently using stale state.
		if (await this.remoteExists("origin")) await runGit(this.identity.root, ["pull", "--ff-only", "origin", baseBranch]);
		if (await this.branchExists(featureBranch)) throw new HarnessError("GIT_OPERATION_FAILED", `New delivery branch already exists: ${featureBranch}; use branchMode continue to add work to it`);
		await runGit(this.identity.root, ["switch", "-c", featureBranch]);
		const path = join(this.workItems.workItemRoot(workItemId), "index.yaml");
		const updated: WorkItemIndex = { ...item, delivery: { ...delivery, baseBranch, featureBranch, startedAt: delivery.startedAt ?? new Date().toISOString() } };
		await atomicWriteFile(path, stringify(updated));
		await runGit(this.identity.root, ["add", "--", relative(this.identity.root, path)]);
		await runGit(this.identity.root, ["commit", "-m", `harness(${workItemId}): start ${delivery.branchType} branch`]);
		return { baseBranch, featureBranch, created: true };
	}

	private async branchExists(branch: string): Promise<boolean> {
		return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.identity.root }).then(() => true, () => false);
	}

	private async remoteExists(remote: string): Promise<boolean> {
		return execFileAsync("git", ["remote", "get-url", remote], { cwd: this.identity.root }).then(() => true, () => false);
	}

	private async startedDeliveryExists(workItemId: string, featureBranch: string): Promise<boolean> {
		if (!(await this.branchExists(featureBranch))) return false;
		const indexPath = relative(this.identity.root, join(this.workItems.workItemRoot(workItemId), "index.yaml"));
		try {
			const candidate = parse(await runGit(this.identity.root, ["show", `${featureBranch}:${indexPath}`])) as Partial<WorkItemIndex>;
			return candidate.id === workItemId
				&& candidate.delivery?.branchMode === "create"
				&& candidate.delivery.featureBranch === featureBranch
				&& Boolean(candidate.delivery.startedAt);
		} catch {
			return false;
		}
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
		const featureBranch = item.delivery?.featureBranch;
		if (!featureBranch) throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} has no prepared delivery branch`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== featureBranch) throw new HarnessError("CAPABILITY_DENIED", `Workflow ${workItemId} must run on ${featureBranch}; current branch is ${currentBranch || "detached HEAD"}`);
		const topology = taskExecutionTopology(item, task);
		if (topology.isolation === "repository") {
			const baseCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			return { path: this.identity.root, branch: featureBranch, baseCommit, isolation: "repository" };
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

	async mergeTask(workItemId: string, taskId: string, checks?: string[]): Promise<IntegrationResult> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId);
		const featureBranch = item.delivery?.featureBranch;
		if (!featureBranch) throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} has no prepared delivery branch`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== featureBranch) throw new HarnessError("CAPABILITY_DENIED", `Task merges require ${featureBranch}; current branch is ${currentBranch || "detached HEAD"}`);

		const requestedTask = await this.workItems.readTask(workItemId, taskId);
		const topology = taskExecutionTopology(item, requestedTask);
		const taskIds = topology.isolation === "worktree" && topology.stageSize > 1 ? topology.stageTasks : [taskId];
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
			if (topology.isolation === "repository") {
				const completedCommit = pending[0]!.runtime!.completedCommit!;
				const present = await execFileAsync("git", ["merge-base", "--is-ancestor", completedCommit, "HEAD"], { cwd: this.identity.root }).then(() => true, () => false);
				if (!present) throw new HarnessError("INVALID_HANDOFF", `Repository task ${pending[0]!.id} commit is not present on ${featureBranch}`);
			} else {
				for (const task of pending) {
					const taskBranch = task.runtime?.branch;
					if (!taskBranch) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} has no recorded branch`);
					await runGit(this.identity.root, ["merge", "--no-ff", "--no-edit", taskBranch]);
				}
			}

			const stage = (item.executionStages ?? []).find((candidate) => candidate.id === topology.stageId);
			const commands = checks ?? stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))];
			for (const command of commands) {
				const result = await runShell(command, this.identity.root);
				checkResults.push({ command, ...result });
				if (result.code !== 0) throw new HarnessError("INVALID_HANDOFF", `Post-stage check failed: ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, result);
			}
			const integratedCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			for (const task of pending) await this.workItems.updateTask(workItemId, task.id, { status: "merged", runtime: { mergedCommit: integratedCommit } });
		} catch (error) {
			await runGit(this.identity.root, ["merge", "--abort"]).catch(() => undefined);
			await runGit(this.identity.root, ["reset", "--hard", baseCommit]).catch(() => undefined);
			if (error instanceof HarnessError) throw error;
			throw new HarnessError("GIT_OPERATION_FAILED", `Atomic stage merge failed for ${topology.stageId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (topology.stageSize > 1) await runGit(this.identity.root, ["update-ref", "-d", this.stageBaseRef(workItemId, topology.stageId)]).catch(() => undefined);
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
