import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { HarnessError } from "./errors.js";
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
}

export interface IntegrationResult {
	commit: string;
	taskId: string;
	checks: Array<{ command: string; code: number; stdout: string; stderr: string }>;
}

export interface PreparedFeatureBranch {
	baseBranch: string;
	featureBranch: string;
	created: boolean;
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
		const item = await this.workItems.assertCurrentApproval(workItemId);
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

		if (delivery.branchMode === "continue") {
			if (currentBranch !== featureBranch) throw new HarnessError("CAPABILITY_DENIED", `Continued workflow ${workItemId} requires current branch ${featureBranch}; current branch is ${currentBranch}`);
			if (!(await this.branchExists(featureBranch))) throw new HarnessError("GIT_OPERATION_FAILED", `Continued delivery branch does not exist: ${featureBranch}`);
			return { baseBranch, featureBranch, created: false };
		}

		if (currentBranch !== baseBranch) throw new HarnessError("CAPABILITY_DENIED", `New workflow ${workItemId} must start from ${baseBranch}; current branch is ${currentBranch}. Switch intentionally after preserving any branch-local planning work.`);
		await runGit(this.identity.root, ["pull", "--ff-only", "origin", baseBranch]);
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

	async allocate(workItemId: string, task: TaskManifest): Promise<AllocatedWorktree> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.assertCurrentApproval(workItemId);
		for (const dependency of task.dependsOn) {
			const dependencyTask = await this.workItems.readTask(workItemId, dependency);
			if (!["merged", "integrated"].includes(dependencyTask.status)) throw new HarnessError("INVALID_ARTIFACT", `Dependency is not merged: ${dependency}`);
		}
		const featureBranch = item.delivery?.featureBranch;
		if (!featureBranch) throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} has no prepared delivery branch`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== featureBranch) throw new HarnessError("CAPABILITY_DENIED", `Workflow ${workItemId} must run on ${featureBranch}; current branch is ${currentBranch || "detached HEAD"}`);
		if (task.execution.isolation === "repository") {
			const baseCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			return { path: this.identity.root, branch: featureBranch, baseCommit };
		}
		const branch = `harness/${safeSegment(workItemId)}/${safeSegment(task.id)}`;
		const path = join(this.worktreeRoot, workItemId, task.id);
		if (!(await isGitPathIgnored(this.identity.root, ".worktree/pibox/.ignore-check"))) {
			throw new HarnessError("CONFIG_INVALID", "Repository-local workflow worktrees require an effective /.worktree/ ignore rule. Run /workflow init or add it to .gitignore before task launch.");
		}
		const baseCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		await mkdir(join(this.worktreeRoot, workItemId), { recursive: true, mode: 0o700 });

		if (await exists(path)) {
			const actualBranch = await runGit(path, ["branch", "--show-current"]);
			if (actualBranch !== branch) throw new HarnessError("GIT_OPERATION_FAILED", `Existing worktree belongs to ${actualBranch || "detached HEAD"}`);
			const status = await runGit(path, ["status", "--porcelain=v1"]);
			const recordedWorktreeMatches = task.runtime?.worktree === path && task.runtime?.branch === branch;
			if (status && task.status !== "running" && task.status !== "paused" && !recordedWorktreeMatches) {
				throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Recovered task worktree is dirty outside a recorded resumable assignment: ${path}`, { status });
			}
			return { path, branch, baseCommit: task.runtime?.baseCommit ?? baseCommit };
		}

		const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.identity.root }).then(
			() => true,
			() => false,
		);
		if (branchExists) await runGit(this.identity.root, ["worktree", "add", path, branch]);
		else await runGit(this.identity.root, ["worktree", "add", "-b", branch, path, baseCommit]);
		return { path, branch, baseCommit };
	}

	async mergeTask(workItemId: string, taskId: string, checks?: string[]): Promise<IntegrationResult> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.assertCurrentApproval(workItemId);
		const featureBranch = item.delivery?.featureBranch;
		if (!featureBranch) throw new HarnessError("INVALID_ARTIFACT", `Workflow ${workItemId} has no prepared delivery branch`);
		const currentBranch = await runGit(this.identity.root, ["branch", "--show-current"]);
		if (currentBranch !== featureBranch) throw new HarnessError("CAPABILITY_DENIED", `Task merges require ${featureBranch}; current branch is ${currentBranch || "detached HEAD"}`);
		let task = await this.workItems.readTask(workItemId, taskId);
		if (["merged", "integrated"].includes(task.status)) return { commit: task.runtime?.mergedCommit ?? await runGit(this.identity.root, ["rev-parse", "HEAD"]), taskId, checks: [] };
		if (!task.runtime?.completedCommit) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} has no completed contribution commit`);
		if (task.execution.isolation === "repository") {
			const present = await execFileAsync("git", ["merge-base", "--is-ancestor", task.runtime.completedCommit, "HEAD"], { cwd: this.identity.root }).then(() => true, () => false);
			if (!present) throw new HarnessError("INVALID_HANDOFF", `Repository task ${task.id} commit is not present on ${featureBranch}`);
		} else {
			if (!["contribution_complete", "accepted", "merge_queued", "merging", "staged", "integrating"].includes(task.status)) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} is not ready to merge from ${task.status}`);
			if (task.status === "contribution_complete" || task.status === "accepted") task = await this.workItems.updateTask(workItemId, task.id, { status: "merge_queued" });
			if (task.status === "merge_queued" || task.status === "staged") task = await this.workItems.updateTask(workItemId, task.id, { status: "merging" });
			const taskBranch = task.runtime?.branch;
			if (!taskBranch) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} has no recorded branch`);
			await runGit(this.identity.root, ["merge", "--no-ff", "--no-edit", taskBranch]).catch(async (error) => {
				await runGit(this.identity.root, ["merge", "--abort"]).catch(() => undefined);
				throw new HarnessError("GIT_OPERATION_FAILED", `Merge conflict for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		const checkResults: IntegrationResult["checks"] = [];
		for (const command of checks ?? task.verification.taskChecks) {
			const result = await runShell(command, this.identity.root);
			checkResults.push({ command, ...result });
			if (result.code !== 0) throw new HarnessError("INVALID_HANDOFF", `Post-merge check failed: ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, result);
		}
		const commit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		await this.workItems.updateTask(workItemId, task.id, { status: "merged", runtime: { mergedCommit: commit } });
		await this.workItems.refreshReadyTasks(workItemId);
		return { commit, taskId, checks: checkResults };
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
