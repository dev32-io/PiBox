import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";
import { taskExecutionTopology, type TaskExecutionIsolation } from "./execution-topology.js";
import { assertCleanRepository, isGitPathIgnored, runGit, type RepositoryIdentity } from "./repository.js";
import { CanonicalMutationCoordinator } from "./canonical-mutation.js";
import type { TaskManifest, VerificationCheckSpec } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { normalizeChecks } from "./verification-checks.js";
import { VerificationRunner, verificationFailureSummary } from "./verification-runner.js";

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
	checks: Array<{ id: string; profile: string; command: string; code: number; stdout: string; stderr: string; attemptPath: string }>;
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
	bytes?: number;
}

export type WorktreeProgressPhase = "inventory" | "status" | "size" | "removing" | "removed";

export interface WorktreeProgress {
	phase: WorktreeProgressPhase;
	current: number;
	total: number;
	name?: string;
}

export interface WorktreeListOptions {
	includeBytes?: boolean | undefined;
	signal?: AbortSignal | undefined;
	onProgress?: ((progress: WorktreeProgress) => void) | undefined;
}

export interface WorktreeCleanupOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ((progress: WorktreeProgress) => void) | undefined;
}

const WORKTREE_INSPECTION_TIMEOUT_MS = 60_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;
const STATUS_CONCURRENCY = 4;
const SIZE_CONCURRENCY = 2;
const DIRECTORY_CONCURRENCY = 8;
const STAT_CONCURRENCY = 32;

function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(values.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (cursor < values.length) {
			const index = cursor++;
			results[index] = await operation(values[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function directorySize(path: string, signal?: AbortSignal): Promise<number> {
	let total = 0;
	const directories = [path];
	while (directories.length > 0) {
		throwIfAborted(signal);
		const batch = directories.splice(0, DIRECTORY_CONCURRENCY);
		const listings = await Promise.all(batch.map((directory) => readdir(directory, { withFileTypes: true })));
		const files: string[] = [];
		for (const [index, entries] of listings.entries()) {
			const directory = batch[index]!;
			for (const entry of entries) {
				const child = join(directory, entry.name);
				if (entry.isDirectory()) directories.push(child);
				else files.push(child);
			}
		}
		const sizes = await mapConcurrent(files, STAT_CONCURRENCY, async (file) => {
			throwIfAborted(signal);
			return (await lstat(file)).size;
		});
		for (const size of sizes) total += size;
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
	readonly coordinator: CanonicalMutationCoordinator;

	constructor(identity: RepositoryIdentity, coordinator?: CanonicalMutationCoordinator) {
		this.identity = identity;
		this.coordinator = coordinator ?? new CanonicalMutationCoordinator(identity.root, identity.commonDir ?? identity.root);
		this.workItems = new WorkItemStore(identity.root, this.coordinator);
		this.worktreeRoot = join(identity.root, ".worktree", "pibox");
	}

	async validateWorkingBranch(workItemId: string, options: { allowDirty?: boolean } = {}): Promise<ValidatedWorkingBranch> {
		if (!options.allowDirty) await assertCleanRepository(this.identity.root);
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
		return this.coordinator.run(`allocate:${workItemId}:${task.id}`, () => this.allocateUnlocked(workItemId, task));
	}

	private async allocateUnlocked(workItemId: string, task: TaskManifest): Promise<AllocatedWorktree> {
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

	private async activeWorktreePaths(signal?: AbortSignal): Promise<Set<string>> {
		const activePaths = new Set<string>();
		for (const item of await this.workItems.list()) {
			throwIfAborted(signal);
			for (const task of await this.workItems.readTasks(item.id)) {
				if (task.runtime?.worktree && !["merged", "integrated", "cancelled"].includes(task.status)) activePaths.add(task.runtime.worktree);
			}
		}
		return activePaths;
	}

	private async managedGitRecords(signal?: AbortSignal): Promise<Array<{ name: string; path: string; branch?: string }>> {
		throwIfAborted(signal);
		const output = await runGit(this.identity.root, ["worktree", "list", "--porcelain"], { signal, timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS });
		const candidates = output.split("\n\n").flatMap((block) => {
			const lines = block.split("\n");
			const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
			if (!path || !path.startsWith(`${this.worktreeRoot}/`)) return [];
			const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
			return [{ name: relative(this.worktreeRoot, path), path, ...(branchRef ? { branch: branchRef.replace("refs/heads/", "") } : {}) }];
		});
		const present = await mapConcurrent(candidates, STATUS_CONCURRENCY, async (candidate) => {
			throwIfAborted(signal);
			return await exists(candidate.path) ? candidate : undefined;
		});
		return present.filter((candidate): candidate is { name: string; path: string; branch?: string } => candidate !== undefined);
	}

	async listManaged(options: WorktreeListOptions = {}): Promise<ManagedWorktree[]> {
		options.onProgress?.({ phase: "inventory", current: 0, total: 0 });
		const [activePaths, candidates] = await Promise.all([
			this.activeWorktreePaths(options.signal),
			this.managedGitRecords(options.signal),
		]);
		let statusesCompleted = 0;
		const records = await mapConcurrent(candidates, STATUS_CONCURRENCY, async (candidate) => {
			throwIfAborted(options.signal);
			const porcelain = await runGit(candidate.path, ["status", "--porcelain=v1"], { signal: options.signal, timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS });
			options.onProgress?.({ phase: "status", current: ++statusesCompleted, total: candidates.length, name: candidate.name });
			return { ...candidate, status: porcelain ? "modified" as const : "clean" as const, active: activePaths.has(candidate.path) };
		});
		if (!options.includeBytes) return records.sort((left, right) => left.name.localeCompare(right.name));
		let sizesCompleted = 0;
		const sized = await mapConcurrent(records, SIZE_CONCURRENCY, async (record) => {
			throwIfAborted(options.signal);
			const bytes = await directorySize(record.path, options.signal);
			options.onProgress?.({ phase: "size", current: ++sizesCompleted, total: records.length, name: record.name });
			return { ...record, bytes };
		});
		return sized.sort((left, right) => left.name.localeCompare(right.name));
	}

	private async isActiveManagedWorktree(name: string, path: string, signal?: AbortSignal): Promise<boolean> {
		throwIfAborted(signal);
		const segments = name.split("/");
		if (segments.length !== 2) throw new HarnessError("INVALID_ARTIFACT", `Malformed PiBox worktree name: ${name}`);
		try {
			const task = await this.workItems.readTask(segments[0]!, segments[1]!);
			return task.runtime?.worktree === path && !["merged", "integrated", "cancelled"].includes(task.status);
		} catch (error) {
			if (error instanceof HarnessError && (error.code === "WORK_ITEM_NOT_FOUND" || (error.code === "INVALID_ARTIFACT" && error.message.includes("Unknown task")))) return false;
			throw error;
		}
	}

	async removeManaged(name: string, force = false, options: { signal?: AbortSignal | undefined } = {}): Promise<ManagedWorktree> {
		throwIfAborted(options.signal);
		return this.coordinator.run(`remove-worktree:${name}`, () => this.removeManagedUnlocked(name, force, options.signal));
	}

	private async removeManagedUnlocked(name: string, force = false, signal?: AbortSignal): Promise<ManagedWorktree> {
		throwIfAborted(signal);
		const candidate = (await this.managedGitRecords(signal)).find((record) => record.name === name);
		if (!candidate) throw new HarnessError("INVALID_ARTIFACT", `Unknown PiBox worktree: ${name}`);
		const active = await this.isActiveManagedWorktree(candidate.name, candidate.path, signal);
		if (active) throw new HarnessError("CAPABILITY_DENIED", `Worktree is active and cannot be removed: ${name}`);
		const porcelain = await runGit(candidate.path, ["status", "--porcelain=v1"], { signal, timeoutMs: WORKTREE_INSPECTION_TIMEOUT_MS });
		const worktree: ManagedWorktree = { ...candidate, status: porcelain ? "modified" : "clean", active };
		if (worktree.status === "modified" && !force) throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Worktree has uncommitted changes: ${name}. Re-run with --force only after preserving the changes.`);
		throwIfAborted(signal);
		// Do not terminate Git midway through destructive cleanup. Cancellation stops
		// at the next worktree boundary so Git metadata and the checkout stay coherent.
		await runGit(this.identity.root, ["worktree", "remove", ...(force ? ["--force"] : []), "--", worktree.path], { timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS });
		await rm(dirname(worktree.path), { recursive: false, force: true }).catch(() => undefined);
		return worktree;
	}

	async cleanupManaged(options: WorktreeCleanupOptions = {}): Promise<ManagedWorktree[]> {
		const removable = (await this.listManaged({ signal: options.signal, onProgress: options.onProgress }))
			.filter((worktree) => !worktree.active && worktree.status === "clean");
		const removed: ManagedWorktree[] = [];
		for (const [index, worktree] of removable.entries()) {
			throwIfAborted(options.signal);
			options.onProgress?.({ phase: "removing", current: index + 1, total: removable.length, name: worktree.name });
			removed.push(await this.removeManaged(worktree.name, false, { signal: options.signal }));
			options.onProgress?.({ phase: "removed", current: index + 1, total: removable.length, name: worktree.name });
		}
		return removed;
	}

	/** Return private conflict evidence captured after the canonical checkout was rolled back clean. */
	async activeConflict(workItemId: string): Promise<{ stageId: string; taskIds: string[]; evidencePath: string } | undefined> {
		const root = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId));
		const entries = (await readdir(root).catch(() => [])).filter((entry) => entry.endsWith(".txt")).sort();
		const evidencePath = entries.length ? join(root, entries[entries.length - 1]!) : undefined;
		if (!evidencePath) return undefined;
		const content = await readFile(evidencePath, "utf8");
		const headers = new Map<string, string>();
		for (const line of content.split(/\r?\n/)) {
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
		const checks = normalizeChecks(stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))], `Stage ${stageId} checks`);
		const results: IntegrationResult["checks"] = [];
		const candidateCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		const runner = new VerificationRunner(this.identity);
		for (const check of checks) {
			const result = await runner.run(workItemId, stageId, check, this.identity.root, candidateCommit);
			results.push({ id: check.id, profile: result.profile, command: check.command, code: result.code, stdout: result.stdout, stderr: result.stderr, attemptPath: result.attemptPath });
			if (result.code !== 0) throw new HarnessError("GIT_OPERATION_FAILED", `Post-repair check failed: ${check.command}\n${verificationFailureSummary(result)}`, { stageId, checkId: check.id, attemptPath: result.attemptPath, code: result.code });
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

	async mergeTask(workItemId: string, taskId: string, checks?: VerificationCheckSpec[]): Promise<IntegrationResult> {
		return this.coordinator.run(`integration:${workItemId}:${taskId}`, () => this.mergeTaskUnlocked(workItemId, taskId, checks));
	}

	private async mergeTaskUnlocked(workItemId: string, taskId: string, checks?: VerificationCheckSpec[]): Promise<IntegrationResult> {
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
			const checksToRun = normalizeChecks(concurrentStage || isFinalSequentialTask ? checks ?? stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))] : [], `Stage ${topology.stageId} checks`);
			const candidateCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			const runner = new VerificationRunner(this.identity);
			for (const check of checksToRun) {
				const result = await runner.run(workItemId, topology.stageId, check, this.identity.root, candidateCommit);
				checkResults.push({ id: check.id, profile: result.profile, command: check.command, code: result.code, stdout: result.stdout, stderr: result.stderr, attemptPath: result.attemptPath });
				if (result.code !== 0) throw new HarnessError("INVALID_HANDOFF", `Post-stage check failed: ${check.command}\n${verificationFailureSummary(result)}`, { stageId: topology.stageId, checkId: check.id, attemptPath: result.attemptPath, code: result.code });
			}
			const integratedCommit = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
			for (const task of pending) await this.workItems.updateTask(workItemId, task.id, { status: "merged", runtime: { mergedCommit: integratedCommit } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = await runGit(this.identity.root, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "");
			const conflicted = /(^|\n)UU |(^|\n)AA |(^|\n)DD |(^|\n)AU |(^|\n)UA /.test(status) || message.includes("CONFLICT");
			if (conflicted) {
				// Capture the failed merge before restoring the canonical branch. Contributor
				// branches remain intact, so a harness-owned repair can reproduce the merge
				// without exposing users to a dirty or half-merged working branch.
				const evidencePath = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId), `${safeSegment(topology.stageId)}-${Date.now()}.txt`);
				await mkdir(dirname(evidencePath), { recursive: true });
				const diff = await runGit(this.identity.root, ["diff", "--cc"]).catch(() => "");
				await writeFile(evidencePath, `stage: ${topology.stageId}\ntasks: ${taskIds.join(", ")}\nbase: ${baseCommit}\nstatus:\n${status}\nconflict:\n${message}\ncombined diff:\n${diff}`, "utf8");
				try { await runGit(this.identity.root, ["merge", "--abort"]); } catch (rollbackError) { throw new HarnessError("GIT_OPERATION_FAILED", `Integration rollback failed after conflict: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { baseCommit, evidencePath }); }
				await runGit(this.identity.root, ["reset", "--hard", baseCommit]);
				throw new HarnessError("GIT_OPERATION_FAILED", `Stage ${topology.stageId} integration conflict requires managed repair. The working branch was restored clean; contributor branches and private evidence are preserved at ${evidencePath}. Resume through the harness repair path.`, { conflict: true, stageId: topology.stageId, taskIds, evidencePath, baseCommit });
			}
			// Never suppress rollback failures: managed recovery needs the original
			// failure and the repository evidence, not a falsely clean result.
			const mergeInProgress = await runGit(this.identity.root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
			if (mergeInProgress) {
				try { await runGit(this.identity.root, ["merge", "--abort"]); } catch (rollbackError) { throw new HarnessError("GIT_OPERATION_FAILED", `Integration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; original: ${message}`, { baseCommit, rollbackError }); }
			}
			try { await runGit(this.identity.root, ["reset", "--hard", baseCommit]); } catch (rollbackError) { throw new HarnessError("GIT_OPERATION_FAILED", `Integration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; original: ${message}`, { baseCommit, rollbackError }); }
			if (error instanceof HarnessError) throw error;
			throw new HarnessError("GIT_OPERATION_FAILED", `Atomic stage merge failed for ${topology.stageId}: ${message}`);
		}
		// Settlement is deliberately still inside mergeTask's coordinator lease.  Do
		// not delete the barrier ref until canonical readiness metadata has settled:
		// a failure must be loud and recoverable, never a silently stale ref/task pair.
		try {
			await this.workItems.refreshReadyTasks(workItemId);
			// Stage refs are concurrency barriers, never sequential-task state.
			if (concurrentStage) await runGit(this.identity.root, ["update-ref", "-d", this.stageBaseRef(workItemId, topology.stageId)]);
		} catch (settlementError) {
			const message = settlementError instanceof Error ? settlementError.message : String(settlementError);
			throw new HarnessError("GIT_OPERATION_FAILED", `Stage ${topology.stageId} merged, but post-merge settlement requires managed recovery: ${message}. Canonical commits and task ownership were preserved; the stage barrier ref is retained when deletion did not complete.`, { stageId: topology.stageId, taskIds, settlementError: message });
		}
		return { commit: await runGit(this.identity.root, ["rev-parse", "HEAD"]), taskId, taskIds, stageId: topology.stageId, checks: checkResults };
	}
}
