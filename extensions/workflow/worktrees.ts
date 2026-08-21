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
import { readStageVerificationActivity, VerificationRunner, verificationFailureSummary } from "./verification-runner.js";

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

export interface StageTrainState {
	schemaVersion: 1;
	workItemId: string;
	stageId: string;
	baseCommit: string;
	taskIds: string[];
	contributionCommits: string[];
	prefixCommits: string[];
	candidateBranch: string;
	candidatePath: string;
	state: "assembling" | "repairing" | "awaiting_ci" | "green" | "promoted";
	repairGeneration?: number;
	lastFailureSignature?: string;
	updatedAt: string;
}

export interface IntegrationFailureEvidence {
	kind: "merge_conflict" | "candidate_check" | "post_repair_check";
	stageId: string;
	taskIds: string[];
	evidencePath: string;
	baseCommit: string;
	candidateCommit: string;
	candidateBranch: string;
	candidatePath: string;
	position?: number;
	ownerTaskId?: string;
	checkId?: string;
	command?: string;
	attemptPath?: string;
	repairGeneration?: number;
	failureSignature?: string;
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

	private trainRoot(workItemId: string, stageId: string): string {
		return join(this.identity.privateRoot, "work-items", safeSegment(workItemId), "integration", safeSegment(stageId));
	}

	private trainPath(workItemId: string, stageId: string): string {
		return join(this.trainRoot(workItemId, stageId), "train.json");
	}

	private candidateBranch(workItemId: string, stageId: string): string {
		return `pibox/integration/${safeSegment(workItemId)}/${safeSegment(stageId)}`;
	}

	private candidatePath(workItemId: string, stageId: string): string {
		return join(this.identity.root, ".worktree", "pibox-integration", safeSegment(workItemId), safeSegment(stageId));
	}

	private async readTrain(workItemId: string, stageId: string): Promise<StageTrainState | undefined> {
		const content = await readFile(this.trainPath(workItemId, stageId), "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!content) return undefined;
		const state = JSON.parse(content) as StageTrainState;
		if (state.schemaVersion !== 1 || state.workItemId !== workItemId || state.stageId !== stageId) throw new HarnessError("INVALID_ARTIFACT", `Invalid integration train state for ${workItemId}/${stageId}`);
		return state;
	}

	private async writeTrain(state: StageTrainState): Promise<void> {
		await mkdir(dirname(this.trainPath(state.workItemId, state.stageId)), { recursive: true, mode: 0o700 });
		state.updatedAt = new Date().toISOString();
		await writeFile(this.trainPath(state.workItemId, state.stageId), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	private async prepareTrain(workItemId: string, stageId: string, taskIds: string[], contributionCommits: string[], baseCommit: string): Promise<StageTrainState> {
		const candidateBranch = this.candidateBranch(workItemId, stageId);
		const candidatePath = this.candidatePath(workItemId, stageId);
		let state = await this.readTrain(workItemId, stageId);
		if (state) {
			const status = await runGit(state.candidatePath, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "");
			if (status) return state;
			const firstChanged = taskIds.findIndex((id, index) => state!.taskIds[index] !== id || state!.contributionCommits[index] !== contributionCommits[index]);
			const shapeChanged = state.taskIds.length !== taskIds.length;
			if (firstChanged >= 0 || shapeChanged || state.baseCommit !== baseCommit) {
				const resetIndex = state.baseCommit === baseCommit && !shapeChanged && firstChanged > 0 ? firstChanged : 0;
				const resetCommit = resetIndex > 0 ? state.prefixCommits[resetIndex - 1] : baseCommit;
				if (!resetCommit) throw new HarnessError("INVALID_ARTIFACT", `Integration train ${stageId} lost its sealed prefix`);
				await runGit(state.candidatePath, ["reset", "--hard", resetCommit]);
				state = { ...state, baseCommit, taskIds, contributionCommits, prefixCommits: state.prefixCommits.slice(0, resetIndex), state: "assembling" };
				await this.writeTrain(state);
			}
			return state;
		}
		await mkdir(dirname(candidatePath), { recursive: true, mode: 0o700 });
		const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidateBranch}`], { cwd: this.identity.root }).then(() => true, () => false);
		if (await exists(candidatePath)) throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Unrecorded integration candidate worktree exists: ${candidatePath}`);
		if (branchExists) await runGit(this.identity.root, ["branch", "-D", candidateBranch]);
		await runGit(this.identity.root, ["worktree", "add", "-b", candidateBranch, candidatePath, baseCommit]);
		state = { schemaVersion: 1, workItemId, stageId, baseCommit, taskIds, contributionCommits, prefixCommits: [], candidateBranch, candidatePath, state: "assembling", updatedAt: new Date().toISOString() };
		await this.writeTrain(state);
		return state;
	}

	private async recordIntegrationFailure(state: StageTrainState, failure: Omit<IntegrationFailureEvidence, "stageId" | "taskIds" | "evidencePath" | "baseCommit" | "candidateCommit" | "candidateBranch" | "candidatePath"> & { detail: string }): Promise<IntegrationFailureEvidence> {
		const root = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(state.workItemId));
		await mkdir(root, { recursive: true });
		const evidencePath = join(root, `${safeSegment(state.stageId)}-${Date.now()}.txt`);
		const candidateCommit = await runGit(state.candidatePath, ["rev-parse", "HEAD"]);
		const failureSignature = createHash("sha256").update(JSON.stringify({ kind: failure.kind, checkId: failure.checkId, command: failure.command, ownerTaskId: failure.ownerTaskId })).digest("hex");
		const repairGeneration = failure.kind === "post_repair_check" ? (state.repairGeneration ?? 0) + 1 : (state.repairGeneration ?? 0);
		state.repairGeneration = repairGeneration;
		state.lastFailureSignature = failureSignature;
		const evidence: IntegrationFailureEvidence = {
			kind: failure.kind,
			stageId: state.stageId,
			taskIds: state.taskIds,
			evidencePath,
			baseCommit: state.baseCommit,
			candidateCommit,
			candidateBranch: state.candidateBranch,
			candidatePath: state.candidatePath,
			...(failure.position !== undefined ? { position: failure.position } : {}),
			...(failure.ownerTaskId ? { ownerTaskId: failure.ownerTaskId } : {}),
			...(failure.checkId ? { checkId: failure.checkId } : {}),
			...(failure.command ? { command: failure.command } : {}),
			...(failure.attemptPath ? { attemptPath: failure.attemptPath } : {}),
			repairGeneration,
			failureSignature,
		};
		await writeFile(evidencePath, [
			`kind: ${evidence.kind}`, `stage: ${state.stageId}`, `tasks: ${state.taskIds.join(", ")}`, `base: ${state.baseCommit}`,
			`candidate: ${candidateCommit}`, `candidateBranch: ${state.candidateBranch}`, `candidatePath: ${state.candidatePath}`,
			...(evidence.position !== undefined ? [`position: ${evidence.position}`] : []), ...(evidence.ownerTaskId ? [`ownerTask: ${evidence.ownerTaskId}`] : []),
			...(evidence.checkId ? [`check: ${evidence.checkId}`] : []), ...(evidence.command ? [`command: ${evidence.command}`] : []),
			...(evidence.attemptPath ? [`attemptPath: ${evidence.attemptPath}`] : []), `repairGeneration: ${repairGeneration}`, `failureSignature: ${failureSignature}`, "detail:", failure.detail,
		].join("\n"), "utf8");
		state.state = "repairing";
		await this.writeTrain(state);
		return evidence;
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

	/** Return private deterministic integration evidence and its isolated candidate ownership. */
	async activeConflict(workItemId: string): Promise<IntegrationFailureEvidence | undefined> {
		const root = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId));
		const entries = (await readdir(root).catch(() => [])).filter((entry) => entry.endsWith(".txt")).sort();
		const evidencePath = entries.length ? join(root, entries[entries.length - 1]!) : undefined;
		if (!evidencePath) return undefined;
		const content = await readFile(evidencePath, "utf8");
		const headers = new Map<string, string>();
		for (const line of content.split(/\r?\n/)) {
			if (line.trim() === "detail:") break;
			const separator = line.indexOf(":");
			if (separator < 0) continue;
			headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
		}
		const stageId = headers.get("stage");
		const taskIds = (headers.get("tasks") ?? "").split(",").map((taskId) => taskId.trim()).filter(Boolean);
		const kind = headers.get("kind") as IntegrationFailureEvidence["kind"] | undefined;
		const baseCommit = headers.get("base");
		const candidateCommit = headers.get("candidate");
		const candidateBranch = headers.get("candidateBranch");
		const candidatePath = headers.get("candidatePath");
		const validId = (value: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(value);
		if (!stageId || !validId(stageId) || !kind || !["merge_conflict", "candidate_check", "post_repair_check"].includes(kind) || !baseCommit || !candidateCommit || !candidateBranch || !candidatePath || taskIds.length === 0 || taskIds.some((taskId) => !validId(taskId))) {
			throw new HarnessError("INVALID_ARTIFACT", `Malformed integration conflict evidence: ${evidencePath}`);
		}
		const position = headers.get("position");
		const ownerTaskId = headers.get("ownerTask");
		const checkId = headers.get("check");
		const command = headers.get("command");
		const attemptPath = headers.get("attemptPath");
		const repairGeneration = headers.get("repairGeneration");
		const failureSignature = headers.get("failureSignature");
		return {
			kind, stageId, taskIds, evidencePath, baseCommit, candidateCommit, candidateBranch, candidatePath,
			...(position !== undefined ? { position: Number(position) } : {}),
			...(ownerTaskId ? { ownerTaskId } : {}),
			...(checkId ? { checkId } : {}),
			...(command ? { command } : {}),
			...(attemptPath ? { attemptPath } : {}),
			...(repairGeneration !== undefined ? { repairGeneration: Number(repairGeneration) } : {}),
			...(failureSignature ? { failureSignature } : {}),
		};
	}

	/** Adopt a pre-merge-train failure without mutating terminal legacy agents or replaying CI on the canonical branch. */
	async migrateLegacyIntegrationFailure(workItemId: string): Promise<IntegrationFailureEvidence | undefined> {
		const root = join(this.identity.root, ".git", "pibox-conflicts", safeSegment(workItemId));
		const entries = (await readdir(root).catch(() => [])).filter((entry) => entry.endsWith(".txt")).sort();
		const legacyPath = entries.length ? join(root, entries[entries.length - 1]!) : undefined;
		if (!legacyPath) return undefined;
		const content = await readFile(legacyPath, "utf8");
		if (/^kind:\s/m.test(content)) return this.activeConflict(workItemId);
		const headers = new Map<string, string>();
		for (const line of content.split(/\r?\n/)) {
			const separator = line.indexOf(":");
			if (separator > 0) headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
		}
		const stageId = headers.get("stage");
		const taskIds = (headers.get("tasks") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
		if (!stageId || taskIds.length === 0) throw new HarnessError("INVALID_ARTIFACT", `Cannot migrate malformed legacy integration evidence: ${legacyPath}`);
		await assertCleanRepository(this.identity.root);
		const candidateBase = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		const tasks = await Promise.all(taskIds.map((id) => this.workItems.readTask(workItemId, id)));
		const contributions = tasks.map((task) => {
			if (!task.runtime?.completedCommit) throw new HarnessError("INVALID_HANDOFF", `Legacy integration migration lost ${task.id} contribution`);
			return task.runtime.completedCommit;
		});
		for (const commit of contributions) await runGit(this.identity.root, ["merge-base", "--is-ancestor", commit, candidateBase]).catch(() => { throw new HarnessError("INVALID_HANDOFF", `Legacy integrated branch does not contain contribution ${commit}`); });
		const state = await this.prepareTrain(workItemId, stageId, taskIds, contributions, candidateBase);
		state.prefixCommits = taskIds.map(() => candidateBase);
		state.state = "repairing";
		await this.writeTrain(state);
		const activity = await readStageVerificationActivity(this.identity, workItemId, stageId);
		const item = await this.workItems.read(workItemId);
		const stage = (item.executionStages ?? []).find((candidate) => candidate.id === stageId);
		const normalized = normalizeChecks(stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))], `Stage ${stageId} checks`);
		const failedCheck = activity ? normalized.find((check) => check.id === activity.checkId) : undefined;
		const attemptPath = activity ? join(".pibox", "work-items", workItemId, "verification", stageId, activity.checkId, "attempts", activity.attemptId) : undefined;
		const migrated = await this.recordIntegrationFailure(state, {
			kind: "post_repair_check",
			...(failedCheck ? { checkId: failedCheck.id, command: failedCheck.command } : {}),
			...(attemptPath ? { attemptPath } : {}),
			detail: `Migrated legacy integration repair evidence. The integrated candidate is preserved at ${candidateBase}; resolve the latest deterministic stage failure rather than replaying unchanged CI.\n${content.slice(0, 8_000)}`,
		});
		await this.clearConflict(workItemId, legacyPath);
		return migrated;
	}

	async refreshIntegrationFailureAttempt(workItemId: string): Promise<IntegrationFailureEvidence | undefined> {
		const failure = await this.activeConflict(workItemId);
		if (!failure) return undefined;
		const activity = await readStageVerificationActivity(this.identity, workItemId, failure.stageId);
		if (!activity) return failure;
		const item = await this.workItems.read(workItemId);
		const tasks = await Promise.all(failure.taskIds.map((id) => this.workItems.readTask(workItemId, id)));
		const stage = (item.executionStages ?? []).find((candidate) => candidate.id === failure.stageId);
		const check = normalizeChecks(stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))], `Stage ${failure.stageId} checks`).find((candidate) => candidate.id === activity.checkId);
		const attemptPath = join(".pibox", "work-items", workItemId, "verification", failure.stageId, activity.checkId, "attempts", activity.attemptId);
		let content = await readFile(failure.evidencePath, "utf8");
		content = content.replace(/^check:.*$/m, `check: ${activity.checkId}`).replace(/^attemptPath:.*$/m, `attemptPath: ${attemptPath}`);
		if (check) content = content.replace(/^command:.*$/m, `command: ${check.command}`);
		await writeFile(failure.evidencePath, content, "utf8");
		return this.activeConflict(workItemId);
	}

	async runStageChecks(workItemId: string, stageId: string, taskIds: string[], cwd = this.identity.root): Promise<IntegrationResult["checks"]> {
		const item = await this.workItems.read(workItemId);
		const tasks = await Promise.all(taskIds.map((taskId) => this.workItems.readTask(workItemId, taskId)));
		const stage = (item.executionStages ?? []).find((candidate) => candidate.id === stageId);
		const checks = normalizeChecks(stage?.checks ?? [...new Set(tasks.flatMap((task) => task.verification.taskChecks))], `Stage ${stageId} checks`);
		const results: IntegrationResult["checks"] = [];
		const candidateCommit = await runGit(cwd, ["rev-parse", "HEAD"]);
		const runner = new VerificationRunner(this.identity);
		for (const check of checks) {
			const result = await runner.run(workItemId, stageId, check, cwd, candidateCommit);
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

	private async promoteTrain(state: StageTrainState, taskId: string, checks: IntegrationResult["checks"]): Promise<IntegrationResult> {
		await assertCleanRepository(this.identity.root);
		const canonicalHead = await runGit(this.identity.root, ["rev-parse", "HEAD"]);
		const containsBase = await execFileAsync("git", ["merge-base", "--is-ancestor", state.baseCommit, canonicalHead], { cwd: this.identity.root }).then(() => true, () => false);
		if (!containsBase) throw new HarnessError("GIT_OPERATION_FAILED", `Integration train ${state.stageId} cannot promote because the working branch no longer contains its pinned base ${state.baseCommit}`, { stageId: state.stageId, baseCommit: state.baseCommit, canonicalHead });
		const sourceDrift = await runGit(this.identity.root, ["diff", "--name-only", `${state.baseCommit}..${canonicalHead}`, "--", ".", ":(exclude)agent-artifacts/**"]);
		if (sourceDrift) throw new HarnessError("GIT_OPERATION_FAILED", `Integration train ${state.stageId} cannot promote across unvalidated source changes on the working branch`, { stageId: state.stageId, baseCommit: state.baseCommit, canonicalHead, sourceDrift });
		const candidateCommit = await runGit(state.candidatePath, ["rev-parse", "HEAD"]);
		await runGit(this.identity.root, ["merge", "--no-ff", "--no-edit", candidateCommit]);
		state.state = "promoted";
		await this.writeTrain(state);
		try {
			for (const id of state.taskIds) await this.workItems.updateTask(state.workItemId, id, { status: "merged", runtime: { mergedCommit: candidateCommit, deterministicFailure: undefined, ciRepairGeneration: undefined } });
			await this.workItems.refreshReadyTasks(state.workItemId);
			await runGit(this.identity.root, ["update-ref", "-d", this.stageBaseRef(state.workItemId, state.stageId)]);
			await runGit(this.identity.root, ["worktree", "remove", "--force", "--", state.candidatePath]);
			await runGit(this.identity.root, ["branch", "-D", state.candidateBranch]);
			await rm(this.trainRoot(state.workItemId, state.stageId), { recursive: true, force: true });
		} catch (error) {
			throw new HarnessError("GIT_OPERATION_FAILED", `Stage ${state.stageId} candidate was promoted, but post-merge settlement requires managed recovery: ${error instanceof Error ? error.message : String(error)}. Candidate state and the stage barrier were retained.`, { stageId: state.stageId, taskIds: state.taskIds, candidateCommit });
		}
		return { commit: await runGit(this.identity.root, ["rev-parse", "HEAD"]), taskId, taskIds: state.taskIds, stageId: state.stageId, checks };
	}

	private async runCandidateChecksAndPromote(state: StageTrainState, taskId: string, taskChecks: VerificationCheckSpec[], stageChecks: VerificationCheckSpec[], priorEvidencePath?: string, failureKind: IntegrationFailureEvidence["kind"] = "candidate_check"): Promise<IntegrationResult> {
		const normalized = [
			...normalizeChecks(taskChecks, `Combined task checks`).map((check) => ({ ...check, id: `task-${check.id}` })),
			...normalizeChecks(stageChecks, `Stage ${state.stageId} checks`).map((check) => ({ ...check, id: `stage-${check.id}` })),
		];
		const unique = normalized.filter((check, index) => normalized.findIndex((candidate) => candidate.command === check.command && candidate.profile === check.profile) === index);
		const results: IntegrationResult["checks"] = [];
		const candidateCommit = await runGit(state.candidatePath, ["rev-parse", "HEAD"]);
		state.state = "awaiting_ci";
		await this.writeTrain(state);
		const runner = new VerificationRunner(this.identity);
		for (const check of unique) {
			const result = await runner.run(state.workItemId, state.stageId, check, state.candidatePath, candidateCommit);
			results.push({ id: check.id, profile: result.profile, command: check.command, code: result.code, stdout: result.stdout, stderr: result.stderr, attemptPath: result.attemptPath });
			if (result.code === 0) continue;
			const evidence = await this.recordIntegrationFailure(state, { kind: failureKind, checkId: check.id, command: check.command, attemptPath: result.attemptPath, detail: verificationFailureSummary(result) });
			if (priorEvidencePath && priorEvidencePath !== evidence.evidencePath) await this.clearConflict(state.workItemId, priorEvidencePath);
			throw new HarnessError("INVALID_HANDOFF", `Integration candidate CI failed: ${check.command}\n${verificationFailureSummary(result)}`, { workerRoutable: true, ...evidence, code: result.code });
		}
		state.state = "green";
		await this.writeTrain(state);
		if (priorEvidencePath) await this.clearConflict(state.workItemId, priorEvidencePath);
		return this.promoteTrain(state, taskId, results);
	}

	private async mergeConcurrentStage(workItemId: string, taskId: string, stageId: string, taskIds: string[], tasks: TaskManifest[], checks?: VerificationCheckSpec[]): Promise<IntegrationResult> {
		const baseCommit = await this.parallelStageBase(workItemId, stageId);
		const contributions = tasks.map((task) => task.runtime!.completedCommit!);
		const state = await this.prepareTrain(workItemId, stageId, taskIds, contributions, baseCommit);
		for (let index = state.prefixCommits.length; index < tasks.length; index++) {
			const task = tasks[index]!;
			try {
				await runGit(state.candidatePath, ["merge", "--no-ff", "--no-edit", task.runtime!.completedCommit!]);
				state.prefixCommits[index] = await runGit(state.candidatePath, ["rev-parse", "HEAD"]);
				await this.writeTrain(state);
			} catch (error) {
				const status = await runGit(state.candidatePath, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "");
				const diff = await runGit(state.candidatePath, ["diff", "--cc"]).catch(() => "");
				const detail = `${error instanceof Error ? error.message : String(error)}\nstatus:\n${status}\ncombined diff:\n${diff}`;
				const evidence = await this.recordIntegrationFailure(state, { kind: "merge_conflict", position: index, ownerTaskId: task.id, detail });
				throw new HarnessError("GIT_OPERATION_FAILED", `Stage ${stageId} candidate conflicts while applying ${task.id}; deterministic repair owns ${evidence.evidencePath}`, { workerRoutable: true, ...evidence });
			}
		}
		const item = await this.workItems.read(workItemId);
		const stage = (item.executionStages ?? []).find((candidate) => candidate.id === stageId);
		const allTaskChecks = [...new Set(tasks.flatMap((task) => task.verification.taskChecks))];
		return this.runCandidateChecksAndPromote(state, taskId, allTaskChecks, checks ?? stage?.checks ?? []);
	}

	async settleIntegrationRepair(workItemId: string, stageId: string, taskIds: string[], evidencePath: string): Promise<IntegrationResult> {
		const state = await this.readTrain(workItemId, stageId);
		if (!state || state.taskIds.join("\0") !== taskIds.join("\0")) throw new HarnessError("INVALID_ARTIFACT", `Integration repair lost train state for ${workItemId}/${stageId}`);
		const status = await runGit(state.candidatePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
		if (status) throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Integration repair left the candidate dirty: ${state.candidatePath}`, { status, evidencePath });
		const tasks = await Promise.all(taskIds.map((id) => this.workItems.readTask(workItemId, id)));
		for (const task of tasks) {
			if (!task.runtime?.completedCommit) throw new HarnessError("INVALID_HANDOFF", `Integration repair lost completed commit for ${task.id}`);
			await runGit(state.candidatePath, ["merge-base", "--is-ancestor", task.runtime.completedCommit, "HEAD"]).catch(() => { throw new HarnessError("INVALID_HANDOFF", `Integration candidate does not contain ${task.id} contribution ${task.runtime!.completedCommit}`); });
		}
		const item = await this.workItems.read(workItemId);
		const stage = (item.executionStages ?? []).find((candidate) => candidate.id === stageId);
		return this.runCandidateChecksAndPromote(state, taskIds[0]!, [...new Set(tasks.flatMap((task) => task.verification.taskChecks))], stage?.checks ?? [], evidencePath, "post_repair_check");
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
		if (concurrentStage) return this.mergeConcurrentStage(workItemId, taskId, topology.stageId, taskIds, tasks, checks);

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
