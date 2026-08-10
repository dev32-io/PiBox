import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";
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
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new HarnessError("INVALID_ARTIFACT", `Unsafe harness identifier: ${value}`);
	return value;
}

export interface AllocatedWorktree {
	path: string;
	branch: string;
	baseCommit: string;
}

export interface IntegrationResult {
	commit: string;
	unitId: string;
	tasks: string[];
	checks: Array<{ command: string; code: number; stdout: string; stderr: string }>;
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

	async allocate(workItemId: string, task: TaskManifest): Promise<AllocatedWorktree> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId);
		if (item.planning.status !== "approved" || item.planning.approvedRevision !== item.planning.revision) {
			throw new HarnessError("STALE_PLANNING_REVISION", `Work item ${workItemId} does not have current user approval`);
		}
		for (const dependency of task.dependsOn) {
			const dependencyTask = await this.workItems.readTask(workItemId, dependency);
			if (dependencyTask.status !== "integrated") throw new HarnessError("INVALID_ARTIFACT", `Dependency is not integrated: ${dependency}`);
		}
		const branch = `harness/${safeSegment(workItemId)}/${safeSegment(task.id)}`;
		const path = join(this.worktreeRoot, workItemId, task.id);
		if (!(await isGitPathIgnored(this.identity.root, ".worktree/pibox/.ignore-check"))) {
			throw new HarnessError("CONFIG_INVALID", "Repository-local harness worktrees require an effective /.worktree/ ignore rule. Run /harness init or add it to .gitignore before task launch.");
		}
		const baseCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		await mkdir(join(this.worktreeRoot, workItemId), { recursive: true, mode: 0o700 });

		if (await exists(path)) {
			const actualBranch = await runGit(path, ["branch", "--show-current"]);
			if (actualBranch !== branch) throw new HarnessError("GIT_OPERATION_FAILED", `Existing worktree belongs to ${actualBranch || "detached HEAD"}`);
			const status = await runGit(path, ["status", "--porcelain=v1"]);
			if (status && task.status !== "running" && task.status !== "paused") {
				throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Recovered task worktree is dirty outside a resumable run: ${path}`, { status });
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

	async integrateUnit(workItemId: string, unitId: string, checks?: string[]): Promise<IntegrationResult> {
		await assertCleanRepository(this.identity.root);
		const item = await this.workItems.read(workItemId);
		if (item.planning.status !== "approved") throw new HarnessError("STALE_PLANNING_REVISION", "Planning is not approved");
		const unit = item.integrationUnits.find((candidate) => candidate.id === unitId);
		if (!unit) throw new HarnessError("INVALID_ARTIFACT", `Unknown integration unit: ${unitId}`);
		const tasks = await Promise.all(unit.tasks.map((taskId) => this.workItems.readTask(workItemId, taskId)));
		for (const task of tasks) {
			if (task.status !== "contribution_complete" && task.status !== "staged") {
				throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} is not contribution-complete`);
			}
			if (!task.runtime?.branch || !task.runtime.baseCommit) throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} has no recorded branch/base`);
		}

		const expectedBase = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		const candidatePath = join(this.identity.privateRoot, "integration", workItemId, `${unitId}-${randomUUID()}`);
		await mkdir(join(this.identity.privateRoot, "integration", workItemId), { recursive: true, mode: 0o700 });
		await runGit(this.identity.root, ["worktree", "add", "--detach", candidatePath, expectedBase]);
		const checkResults: IntegrationResult["checks"] = [];
		const effectiveChecks = checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))];
		try {
			for (const task of tasks) {
				await runGit(candidatePath, ["cherry-pick", "--no-commit", `${task.runtime?.baseCommit}..${task.runtime?.branch}`]).catch(async (error) => {
					await runGit(candidatePath, ["cherry-pick", "--abort"]).catch(() => undefined);
					throw new HarnessError("GIT_OPERATION_FAILED", `Integration conflict while applying ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
			for (const command of effectiveChecks) {
				const result = await runShell(command, candidatePath);
				checkResults.push({ command, ...result });
				if (result.code !== 0) throw new HarnessError("INVALID_HANDOFF", `Integration check failed: ${command}`, result);
			}
			const trailers = [
				`Harness-Work-Item: ${workItemId}`,
				`Harness-Integration-Unit: ${unitId}`,
				`Harness-Tasks: ${tasks.map((task) => task.id).join(", ")}`,
				`Source-Commits: ${tasks.map((task) => task.runtime?.completedCommit).filter(Boolean).join(", ")}`,
			].join("\n");
			await runGit(candidatePath, ["commit", "-m", `harness(${workItemId}): integrate ${unitId}`, "-m", trailers]);
			const commit = await runGit(candidatePath, ["rev-parse", "HEAD"]);
			if ((await runGit(this.identity.root, ["rev-parse", "HEAD"])) !== expectedBase) {
				throw new HarnessError("GIT_OPERATION_FAILED", "Canonical branch advanced while integration candidate was running");
			}
			await runGit(this.identity.root, ["merge", "--ff-only", commit]);
			for (const task of tasks) await this.workItems.updateTask(workItemId, task.id, { status: "integrated" });
			await this.workItems.refreshReadyTasks(workItemId);
			return { commit, unitId, tasks: tasks.map((task) => task.id), checks: checkResults };
		} finally {
			await runGit(this.identity.root, ["worktree", "remove", "--force", candidatePath]).catch(() => undefined);
			await rm(candidatePath, { recursive: true, force: true });
		}
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
