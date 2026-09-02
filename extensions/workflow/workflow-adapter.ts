import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	WorkflowAdapter,
	WorkflowAttentionDecision,
	WorkflowExecutionControl,
	WorkflowPreflight,
	WorkflowSnapshot,
} from "../workflow-runtime/api.js";
import type { WorkflowSubagentLauncher } from "../workflow-runtime/subagent-launcher.js";
import {
	activateWorkflowAction,
	advanceStageStateMachine,
	createStoryRuntimeState,
	interruptOwnedAttempts,
	resumeInterruptedWorkflow,
	resolveWorkflowAttention,
	settleWorkflowAction,
	startWorkflow,
	type ActionSettlement,
	type StageMachinePlan,
	type WorkflowAction,
} from "./stage-state-machine.js";
import {
	createAttemptToken,
	hasWorkflowAttention,
	StoryRuntimeStore,
	transitionWorkflowClock,
	type FailureSummary,
	type LedgerEntry,
	type RuntimeOwner,
	type StoryContractDigests,
	type StoryRuntimeState,
	type StructuredFinding,
	type WorkflowMetricCategory,
} from "./story-runtime-store.js";
import { normalizeChecks, verificationCommand, type NormalizedVerificationCheck } from "./verification-checks.js";
import { assertCleanRepository, atomicWriteFile, isGitPathIgnored, runGit, type RepositoryIdentity } from "./repository.js";
import { resolveHarnessModel } from "./model-resolver.js";
import { DEFAULT_SUBAGENT_TOOLS, resolveToolSelectors } from "./tool-groups.js";
import { mcpLaunchEnvironment, mcpServerAllowlist } from "../subagent/mcp-capabilities.js";
import { isSubagentFastActive } from "../fast-mode/runtime.js";
import type {
	AuthoredTaskDocument,
	HarnessConfig,
	StoryDocument,
	StoryPlanDocument,
} from "./types.js";
import { validateEvidenceSource, type WorkItemStore } from "./work-items.js";
import { validateCompiledStory } from "./authored-markdown.js";
import { compiledConfigurationIssues } from "./orchestrator-resources.js";

export interface HarnessWorkflowRuntime {
	identity: RepositoryIdentity;
	workItems: WorkItemStore;
	launcher: WorkflowSubagentLauncher;
	config: HarnessConfig;
	mutex: { run<T>(owner: string, operation: () => Promise<T>): Promise<T> };
	sessionId?: string;
}

export interface StoryWorkflowActionContext {
	ctx: ExtensionContext;
	runtime: HarnessWorkflowRuntime;
	story: StoryDocument;
	plan: StoryPlanDocument;
	tasks: ReadonlyMap<string, AuthoredTaskDocument>;
	state: StoryRuntimeState;
	action: WorkflowAction;
	token: string;
	owner: RuntimeOwner;
	signal: AbortSignal;
	ledger: readonly LedgerEntry[];
}

export type StoryWorkflowActionResult = Omit<ActionSettlement, "action" | "token" | "owner">;
export type StoryWorkflowActionExecutor = (context: StoryWorkflowActionContext) => Promise<StoryWorkflowActionResult>;

export interface HarnessWorkflowAdapterOptions {
	runtimeFor(ctx: ExtensionContext): Promise<HarnessWorkflowRuntime>;
	/** Explicit test/integration seam. Production defaults use the injected coordinator and native Git/check operations. */
	executeAction?: StoryWorkflowActionExecutor;
	now?: () => Date;
}

interface LoadedStory {
	story: StoryDocument;
	plan: StoryPlanDocument;
	tasks: Map<string, AuthoredTaskDocument>;
	machinePlan: StageMachinePlan;
	canonicalBranch: string;
	contracts: StoryContractDigests;
}

const WORK_ITEM = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const STORE_CACHE = Symbol.for("pibox:story-runtime-store-cache:v1");
const ACTIVE_ACTIONS = Symbol.for("pibox:story-runtime-active-actions:v1");
const LIFECYCLE_LISTENERS = Symbol.for("pibox:story-runtime-listeners:v1");
type RuntimeGlobals = typeof globalThis & {
	[STORE_CACHE]?: Map<string, StoryRuntimeStore>;
	[ACTIVE_ACTIONS]?: Map<string, { promise: Promise<void>; controller: AbortController; childBacked: boolean; owner: RuntimeOwner }>;
	[LIFECYCLE_LISTENERS]?: Map<string, Set<() => void>>;
};

function globals(): Required<Pick<RuntimeGlobals, typeof STORE_CACHE | typeof ACTIVE_ACTIONS | typeof LIFECYCLE_LISTENERS>> {
	const root = globalThis as RuntimeGlobals;
	return {
		[STORE_CACHE]: root[STORE_CACHE] ??= new Map(),
		[ACTIVE_ACTIONS]: root[ACTIVE_ACTIONS] ??= new Map(),
		[LIFECYCLE_LISTENERS]: root[LIFECYCLE_LISTENERS] ??= new Map(),
	};
}

function storyId(ref: string): string {
	const match = WORK_ITEM.exec(ref);
	if (!match) throw new Error(`A workflow must reference a target story: ${ref}`);
	return match[1]!;
}

function runtimeKey(root: string, id: string): string { return `${root}\0${id}`; }
function attemptKey(root: string, id: string, token: string): string { return `${runtimeKey(root, id)}\0${token}`; }
function storeFor(root: string, id: string): StoryRuntimeStore {
	const key = runtimeKey(root, id);
	const stores = globals()[STORE_CACHE];
	let store = stores.get(key);
	if (!store) { store = new StoryRuntimeStore(root, id); stores.set(key, store); }
	return store;
}
function emit(root: string, id: string): void {
	for (const listener of globals()[LIFECYCLE_LISTENERS].get(runtimeKey(root, id)) ?? []) listener();
}

function sameOwner(left: RuntimeOwner | undefined, right: RuntimeOwner): boolean {
	return left?.sessionId === right.sessionId && left.processInstanceId === right.processInstanceId && left.activationId === right.activationId;
}

export async function reconcileHarnessActivation(runtime: HarnessWorkflowRuntime): Promise<WorkflowExecutionControl[]> {
	const owner = runtime.launcher.service.owner; const controls: WorkflowExecutionControl[] = [];
	for (const item of await runtime.workItems.list()) {
		const store = storeFor(runtime.identity.root, item.id); const durable = await store.readState();
		if (!durable || (durable.status !== "running" && durable.status !== "paused") || !durable.activationOwner) continue;
		if (sameOwner(durable.activationOwner, owner)) { controls.push({ workflowRef: `work-item:${item.id}`, mode: durable.status, ownerSessionId: owner.sessionId, ownerProcessInstanceId: owner.processInstanceId, ownerActivationId: owner.activationId }); continue; }
		const lostOwner = durable.activationOwner;
		await withGitLock(runtime, `story-reconcile:${item.id}`, () => store.updateState((current) => current ? interruptOwnedAttempts(current, lostOwner) : (() => { throw new Error(`Workflow ${item.id} state disappeared during first-demand reconciliation`); })(), { type: "workflow.interrupted", resultCode: "activation_first_demand_owner_mismatch" }));
	}
	return controls;
}

function checkId(check: AuthoredTaskDocument["checks"][number], index: number): string {
	return typeof check === "string" ? `check-${index + 1}` : check.id ?? `check-${index + 1}`;
}

function contractDigest(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function loadStory(runtime: HarnessWorkflowRuntime, id: string): Promise<LoadedStory> {
	const [story, plan, authoredTasks, delivery] = await Promise.all([
		runtime.workItems.readStory(id),
		runtime.workItems.readStoryPlan(id),
		runtime.workItems.listAuthoredTasks(id),
		runtime.workItems.findDelivery(id),
	]);
	if (!delivery?.workingBranch) throw new Error(`Story ${id} has no persisted canonical feature/fix branch`);
	validateCompiledStory(story.spec, story.design, story.e2e);
	if (plan.stages.length === 0) throw new Error("Plan must contain at least one stage");
	const taskIds = plan.stages.flatMap((stage) => stage.tasks);
	if (new Set(taskIds).size !== taskIds.length || taskIds.length !== authoredTasks.length || taskIds.some((taskId) => !authoredTasks.some((task) => task.id === taskId))) throw new Error(`Plan ${id} must reference every authored task exactly once`);
	const taskList = taskIds.map((taskId) => authoredTasks.find((task) => task.id === taskId)!);
	const configurationIssues = compiledConfigurationIssues(runtime.config, taskList, plan.stages);
	if (configurationIssues.length) throw new Error(`Workflow compilation failed with ${configurationIssues.length} issue${configurationIssues.length === 1 ? "" : "s"}:\n${configurationIssues.map((issue) => `- ${issue}`).join("\n")}`);
	const tasks = new Map(taskList.map((task) => [task.id, task]));
	const stageIndex = new Map(plan.stages.map((stage, index) => [stage.id, index]));
	const taskStage = new Map(plan.stages.flatMap((stage) => stage.tasks.map((taskId) => [taskId, stage.id] as const)));
	for (const task of taskList) {
		for (const dependency of task.dependsOn) {
			const dependencyStage = taskStage.get(dependency);
			const currentStage = taskStage.get(task.id);
			if (!dependencyStage || !currentStage) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
			const dependencyIndex = stageIndex.get(dependencyStage)!;
			const currentIndex = stageIndex.get(currentStage)!;
			if (dependencyIndex > currentIndex) throw new Error(`Task ${task.id} depends on later task ${dependency}`);
			if (dependencyIndex === currentIndex) {
				const stage = plan.stages[currentIndex]!;
				if (stage.mode === "concurrent" || stage.tasks.indexOf(dependency) >= stage.tasks.indexOf(task.id)) throw new Error(`Task ${task.id} has an unschedulable same-stage dependency on ${dependency}`);
			}
		}
	}
	const machinePlan: StageMachinePlan = {
		stages: plan.stages.map((stage) => ({
			id: stage.id,
			mode: stage.mode,
			tasks: stage.tasks.map((taskId) => {
				const task = tasks.get(taskId);
				if (!task) throw new Error(`Plan ${id} references missing task ${taskId}`);
				return { id: task.id, checks: task.checks.map((check, index) => ({ id: checkId(check, index) })) };
			}),
			checks: normalizeChecks(stage.checks, `Stage ${stage.id} checks`).map(({ id: checkIdValue }) => ({ id: checkIdValue })),
			...(stage.review ? { review: { mode: stage.review.mode, ...(stage.review.focus ? { focus: stage.review.focus } : {}) } } : {}),
		})),
	};
	const contracts: StoryContractDigests = {
		story: contractDigest(story),
		plan: contractDigest(plan),
		tasks: Object.fromEntries([...tasks].sort(([left], [right]) => left.localeCompare(right)).map(([taskId, task]) => [taskId, contractDigest(task)])),
	};
	return { story, plan, tasks, machinePlan, canonicalBranch: delivery.workingBranch, contracts };
}

async function assertCanonicalBranch(runtime: HarnessWorkflowRuntime, state: Pick<StoryRuntimeState, "git">): Promise<void> {
	const current = await runGit(runtime.identity.root, ["branch", "--show-current"]);
	if (current !== state.git.canonicalBranch) throw new Error(`Workflow canonical branch is ${state.git.canonicalBranch}; current branch is ${current || "detached HEAD"}`);
}

function requiredRuntimeIgnorePaths(storyId: string): string[] {
	return [
		".worktree/pibox/.ignore-check",
		`agent-artifacts/${storyId}/state.yaml`,
		`agent-artifacts/${storyId}/ledger.yaml`,
		`agent-artifacts/${storyId}/events.jsonl`,
	];
}

async function missingRuntimeIgnorePaths(repositoryRoot: string, storyId: string): Promise<string[]> {
	const required = requiredRuntimeIgnorePaths(storyId);
	const ignored = await Promise.all(required.map((path) => isGitPathIgnored(repositoryRoot, path)));
	return required.filter((_path, index) => !ignored[index]);
}

function runtimeIgnoreDetail(missing: readonly string[]): string {
	return `Workflow execution requires effective Git ignore rules for runtime-owned paths: ${missing.join(", ")}. Run workflow_init on develop or add equivalent repository/local excludes before starting or resuming.`;
}

async function assertRuntimePathsIgnored(repositoryRoot: string, storyId: string): Promise<void> {
	const missing = await missingRuntimeIgnorePaths(repositoryRoot, storyId);
	if (missing.length) throw new Error(runtimeIgnoreDetail(missing));
}

async function initialState(runtime: HarnessWorkflowRuntime, loaded: LoadedStory): Promise<StoryRuntimeState> {
	const [canonicalBranch, baseCommit] = await Promise.all([
		runGit(runtime.identity.root, ["branch", "--show-current"]),
		runGit(runtime.identity.root, ["rev-parse", "HEAD"]),
	]);
	if (canonicalBranch !== loaded.canonicalBranch) throw new Error(`Workflow must start on its persisted canonical branch ${loaded.canonicalBranch}; current branch is ${canonicalBranch || "detached HEAD"}`);
	return createStoryRuntimeState(loaded.machinePlan, { storyId: loaded.story.id, contracts: loaded.contracts, git: { canonicalBranch: loaded.canonicalBranch, baseCommit } });
}

function stateMatchesPlan(state: StoryRuntimeState, loaded: LoadedStory): void {
	if (state.storyId !== loaded.story.id || state.git.canonicalBranch !== loaded.canonicalBranch || JSON.stringify(state.contracts) !== JSON.stringify(loaded.contracts)) {
		throw new Error(`Runtime state contract does not match the persisted story, plan, tasks, or canonical branch for ${loaded.story.id}`);
	}
	if (state.stages.length !== loaded.machinePlan.stages.length) throw new Error(`Runtime state does not match plan ${loaded.story.id}`);
	for (const [index, stage] of state.stages.entries()) {
		const planned = loaded.machinePlan.stages[index];
		if (!planned || planned.id !== stage.id || planned.tasks.map((task) => task.id).join("\0") !== stage.tasks.map((task) => task.id).join("\0")) {
			throw new Error(`Runtime state does not match stage ${planned?.id ?? index}`);
		}
	}
}

function activeActions(state: StoryRuntimeState): Array<{ action: WorkflowAction; token: string; owner: RuntimeOwner }> {
	const actions: Array<{ action: WorkflowAction; token: string; owner: RuntimeOwner }> = [];
	const add = (action: WorkflowAction, slot: { attempt?: { token: string; owner: RuntimeOwner }; failure?: FailureSummary }) => {
		if (slot.attempt) actions.push({ action: { ...action, ...(slot.failure ? { reason: slot.failure } : {}) }, token: slot.attempt.token, owner: slot.attempt.owner });
	};
	for (const stage of state.stages) {
		for (const task of stage.tasks) {
			if (task.status === "implementing") add({ kind: "task-launch", stageId: stage.id, taskId: task.id }, task);
			else if (task.status === "checking") add({ kind: "task-check", stageId: stage.id, taskId: task.id }, task);
			else if (task.status === "repairing") add({ kind: "task-repair", stageId: stage.id, taskId: task.id }, task);
		}
		if (stage.integration.status === "integrating") add({ kind: "integration", stageId: stage.id }, stage.integration);
		else if (stage.integration.status === "repairing") add({ kind: "integration-repair", stageId: stage.id }, stage.integration);
		if (stage.verification.status === "checking") add({ kind: "verification", stageId: stage.id }, stage.verification);
		else if (stage.verification.status === "repairing") add({ kind: "verification-repair", stageId: stage.id }, stage.verification);
		if (stage.review.status === "reviewing") add({ kind: "review", stageId: stage.id }, stage.review);
		else if (stage.review.status === "fixing") add({ kind: "review-fix", stageId: stage.id }, stage.review);
	}
	if (state.finalReview.status === "reviewing") add({ kind: "final-review" }, state.finalReview);
	else if (state.finalReview.status === "fixing") add({ kind: "final-review-fix" }, state.finalReview);
	if (state.e2e.status === "testing") add({ kind: "e2e" }, state.e2e);
	else if (state.e2e.status === "fixing") add({ kind: "e2e-fix" }, state.e2e);
	return actions;
}

function actionFailure(state: StoryRuntimeState, action: WorkflowAction): FailureSummary | undefined {
	const stage = action.stageId ? state.stages.find((candidate) => candidate.id === action.stageId) : undefined;
	if (action.taskId) return stage?.tasks.find((task) => task.id === action.taskId)?.failure;
	if (action.kind.startsWith("integration")) return stage?.integration.failure;
	if (action.kind.startsWith("verification")) return stage?.verification.failure;
	if (action.kind === "review" || action.kind === "review-fix") return stage?.review.failure;
	if (action.kind.startsWith("final-review")) return state.finalReview.failure;
	if (action.kind === "e2e" || action.kind === "e2e-fix") return state.e2e.failure;
	return undefined;
}

function childBacked(action: WorkflowAction): boolean {
	return !["task-check", "integration", "verification", "completion", "attention"].includes(action.kind);
}

function canonicalRepair(action: WorkflowAction): boolean {
	return ["integration-repair", "verification-repair", "review-fix", "final-review-fix", "e2e-fix"].includes(action.kind);
}

function sameWorkflowAction(left: WorkflowAction, right: WorkflowAction): boolean {
	return left.kind === right.kind && left.stageId === right.stageId && left.taskId === right.taskId;
}

function categoryFor(action: WorkflowAction): WorkflowMetricCategory | undefined {
	if (action.kind.startsWith("task-")) return "implementation";
	if (action.kind.startsWith("integration")) return "integration";
	if (action.kind.startsWith("verification")) return "verification";
	if (action.kind === "review" || action.kind === "review-fix" || action.kind.startsWith("final-review")) return "review";
	if (action.kind === "e2e" || action.kind === "e2e-fix") return "e2e";
	return undefined;
}

function snapshotStatus(state: StoryRuntimeState): WorkflowSnapshot["status"] {
	if (state.status === "completed") return "done";
	if (state.status === "attention" || state.status === "failed") return "attention";
	if (state.status === "paused" || state.status === "stopped") return "paused";
	if (state.status === "running") return "running";
	return "ready";
}

function workflowSnapshot(ref: string, title: string, state: StoryRuntimeState, plan: StoryPlanDocument): WorkflowSnapshot {
	return {
		ref,
		title,
		status: snapshotStatus(state),
		runtime: structuredClone(state),
		stageTopology: plan.stages.map(({ id, mode }) => ({ id, mode })),
	};
}

function failure(code: string, summary: string): FailureSummary {
	return { code, summary: summary.slice(0, 2_000) };
}

function isContainedPath(parent: string, candidate: string): boolean {
	const child = relative(parent, candidate);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export async function createE2eScratchDirectory(repositoryRoot: string, preferredTemporaryRoot = tmpdir()): Promise<string> {
	const canonicalRepository = await realpath(repositoryRoot);
	const canonicalTemporaryRoot = await realpath(preferredTemporaryRoot);
	const scratchRoot = isContainedPath(canonicalRepository, canonicalTemporaryRoot)
		? await realpath(resolve(canonicalRepository, ".."))
		: canonicalTemporaryRoot;
	if (isContainedPath(canonicalRepository, scratchRoot)) throw new Error("E2E scratch output cannot be isolated outside the repository");
	return mkdtemp(join(scratchRoot, ".pibox-e2e-"));
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(() => true, () => false);
}

interface ResolvedCheckProfile { name: string; shell: string; bootstrap?: string; requiredEnvironment: string[]; legacy: boolean }

function verificationProfile(config: HarnessConfig, check: NormalizedVerificationCheck): ResolvedCheckProfile {
	const policy = config.verification;
	if (!policy) {
		if (check.profile) throw new Error(`Verification check ${check.id} selects profile ${check.profile}, but .pi/harness.yaml has no verification section`);
		return { name: "default-shell", shell: "/bin/sh", requiredEnvironment: [], legacy: true };
	}
	const name = check.profile ?? policy.defaultProfile;
	if (!name) throw new Error(`Verification check ${check.id} requires a profile because verification.defaultProfile is not configured`);
	const profile = policy.profiles[name];
	if (!profile) throw new Error(`Verification check ${check.id} selects unknown profile: ${name}`);
	return { name, ...profile, legacy: false };
}

async function runShell(command: string, cwd: string, signal: AbortSignal, profile: ResolvedCheckProfile = { name: "default-shell", shell: "/bin/sh", requiredEnvironment: [], legacy: true }): Promise<{ code: number; stdout: string; stderr: string }> {
	if (signal.aborted) throw signal.reason;
	const required = profile.requiredEnvironment.map((name) => `if [ -z "\${${name}:-}" ]; then printf '%s\\n' 'Required verification environment is missing: ${name}' >&2; exit 78; fi`);
	const script = [profile.legacy ? undefined : "set -e", profile.bootstrap, ...required, command].filter(Boolean).join("\n");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(profile.shell, [profile.legacy ? "-lc" : "-c", script], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-16_384); });
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_384); });
		const stop = () => child.kill("SIGTERM");
		signal.addEventListener("abort", stop, { once: true });
		child.once("error", reject);
		child.once("close", (code) => { signal.removeEventListener("abort", stop); resolvePromise({ code: code ?? 1, stdout, stderr }); });
	});
}

async function executableAvailable(command: string, repositoryRoot: string): Promise<boolean> {
	const candidates = command.includes("/")
		? [resolve(repositoryRoot, command)]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, command));
	for (const candidate of candidates) if (await access(candidate, constants.X_OK).then(() => true, () => false)) return true;
	return false;
}

/** Static preflight only: never invoke a shell, command, or configured bootstrap before user confirmation. */
async function preflightChecks(loaded: LoadedStory, repositoryRoot: string, config: HarnessConfig): Promise<{ missingCommands: string[]; missingEnvironment: string[] }> {
	const checks = [...loaded.tasks.values()].flatMap((task) => normalizeChecks(task.checks, `Task ${task.id} checks`))
		.concat(loaded.plan.stages.flatMap((stage) => normalizeChecks(stage.checks, `Stage ${stage.id} checks`)));
	const missingCommands = new Set<string>();
	const missingEnvironment = new Set<string>();
	for (const check of checks) {
		const declaration = check.command;
		const profile = verificationProfile(config, check);
		if (!await executableAvailable(profile.shell, repositoryRoot)) missingCommands.add(profile.shell);
		for (const name of profile.requiredEnvironment) if (!process.env[name]) missingEnvironment.add(name);
		for (const match of declaration.matchAll(/(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))/g)) {
			const name = match[1] ?? match[2];
			if (name && !process.env[name]) missingEnvironment.add(name);
		}
		const command = declaration.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|env\s+)+/, "").match(/^(?:command\s+-v\s+)?([A-Za-z0-9_./-]+)/)?.[1];
		if (!command || ["if", "then", "fi", "for", "do", "done", "case", "test", "echo", "true", "false"].includes(command)) continue;
		if (!await executableAvailable(command, repositoryRoot)) missingCommands.add(command);
	}
	return { missingCommands: [...missingCommands].sort(), missingEnvironment: [...missingEnvironment].sort() };
}

async function withGitLock<T>(runtime: HarnessWorkflowRuntime, key: string, operation: () => Promise<T>): Promise<T> {
	return runtime.mutex.run(key, operation);
}

function stageDefinition(context: StoryWorkflowActionContext) {
	const stage = context.plan.stages.find((candidate) => candidate.id === context.action.stageId);
	if (!stage) throw new Error(`Unknown stage ${context.action.stageId}`);
	return stage;
}

class WorkspaceInvariantError extends Error {
	constructor(message: string) { super(message); this.name = "WorkspaceInvariantError"; }
}

function stageBase(state: StoryRuntimeState, stageId: string): string {
	const index = state.stages.findIndex((stage) => stage.id === stageId);
	if (index < 0) throw new Error(`Unknown stage ${stageId}`);
	if (index === 0) return state.git.baseCommit;
	const prior = state.stages[index - 1]!;
	if (prior.status !== "completed" || !prior.integration.integratedCommit) throw new Error(`Stage ${stageId} has no completed predecessor integration commit`);
	return prior.integration.integratedCommit;
}

async function taskWorkspace(context: StoryWorkflowActionContext): Promise<{ path: string; base: string }> {
	const taskId = context.action.taskId!;
	const stage = stageDefinition(context);
	const root = context.runtime.identity.root;
	const shared = stage.mode === "sequential";
	const workspaceId = shared ? `stage-${stage.id}` : taskId;
	const path = join(root, ".worktree", "pibox", context.story.id, workspaceId);
	const base = stageBase(context.state, stage.id);
	return withGitLock(context.runtime, `story-worktree:${context.story.id}:${workspaceId}`, async () => {
		if (await exists(join(path, ".git"))) {
			const containsBase = await runGit(path, ["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true, () => false);
			if (!containsBase) throw new WorkspaceInvariantError(`Retained workspace ${workspaceId} is not descended from pinned stage base ${base}`);
			return { path, base };
		}
		await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
		const branch = shared ? `harness/${context.story.id}/stage/${stage.id}` : `harness/${context.story.id}/task/${taskId}`;
		const branchExists = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
		if (branchExists) await runGit(root, ["worktree", "add", path, branch]);
		else await runGit(root, ["worktree", "add", "-b", branch, path, base]);
		const containsBase = await runGit(path, ["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true, () => false);
		if (!containsBase) throw new WorkspaceInvariantError(`Workspace branch ${branch} is not descended from pinned stage base ${base}`);
		return { path, base };
	});
}

function stableTaskContext(task: AuthoredTaskDocument): string {
	return [
		`# Task ${task.id}: ${task.title}`,
		"## Description", task.description,
		"## Scope", task.scope,
		"## Delivery", task.delivery,
		"The harness owns deterministic checks, Git integration, scheduling, retries, and workflow state. Do not edit workflow runtime files or launch subagents.",
	].join("\n\n");
}

function reviewContext(context: StoryWorkflowActionContext): string {
	const stage = context.action.stageId ? context.plan.stages.find((candidate) => candidate.id === context.action.stageId) : undefined;
	const taskIds = stage?.tasks ?? [...context.tasks.keys()];
	const taskContracts = taskIds.map((id) => stableTaskContext(context.tasks.get(id)!)).join("\n\n---\n\n");
	return [
		`# ${context.action.kind.startsWith("final-") ? "Whole-branch" : `Stage ${stage?.id}`} review`,
		"## Story specification", context.story.spec,
		"## Story design", context.story.design,
		stage?.review?.focus ? `## Review focus\n${stage.review.focus}` : undefined,
		"## Task contracts", taskContracts,
		"Return only JSON with result (passed|repairable|critical|needs_user|unsafe), summary, and findings. Each finding has id, severity (critical|major|minor), code, summary, and optional path/line.",
	].filter(Boolean).join("\n\n");
}

function reviewLedgerPrefix(action: WorkflowAction): string | undefined {
	if (action.kind === "review") return `review-finding:stage:${action.stageId}:`;
	if (action.kind === "final-review") return "review-finding:final:";
	return undefined;
}

function selectedLedger(entries: readonly LedgerEntry[]): string {
	const selected = entries.slice(-8);
	if (!selected.length) return "Curated ledger: none recorded.";
	return ["Curated ledger entries:", ...selected.map((entry) => `- [${entry.id}] ${entry.summary}${entry.evidence?.length ? ` (evidence: ${entry.evidence.slice(0, 8).join(", ")})` : ""}`)].join("\n").slice(0, 12_000);
}

async function reviewCoordinates(context: StoryWorkflowActionContext): Promise<{ base: string; head: string; prompt: string }> {
	const base = context.action.stageId ? stageBase(context.state, context.action.stageId) : context.state.git.baseCommit;
	const head = await runGit(context.runtime.identity.root, ["rev-parse", "HEAD"]);
	return { base, head, prompt: [`Base commit: ${base}`, `Head commit: ${head}`, `Review diff: ${base}..${head}`, selectedLedger(context.ledger)].join("\n") };
}

class OwnerLostTerminal extends Error {
	constructor() { super("Subagent owner activation was lost"); this.name = "OwnerLostTerminal"; }
}

async function launchAgent(context: StoryWorkflowActionContext, role: string, stableContext: string, attemptPrompt: string, cwd: string, scratchDirectory?: string): Promise<{ text: string; exitCode: number; stderr: string; terminalReason: "completed" | "failure" | "explicit_stop" | "owner_lost" }> {
	if (!context.runtime.launcher?.service) throw new Error("Production workflow execution requires an injected SubagentService");
	const definition = context.runtime.config.agents[role];
	if (!definition) throw new Error(`Missing workflow agent definition: ${role}`);
	const tier = context.action.taskId ? context.tasks.get(context.action.taskId)?.assignment.tier ?? definition.tier! : definition.tier!;
	const available = context.ctx.scopedModels.length > 0 ? context.ctx.scopedModels.map((entry) => entry.model) : context.ctx.modelRegistry.getAvailable();
	const route = resolveHarnessModel(context.runtime.config, available, { tier });
	if (route.status === "waiting_model") throw new Error(`No ${tier} model is available for ${role}`);
	const selectors = definition.tools ?? DEFAULT_SUBAGENT_TOOLS;
	const tools = resolveToolSelectors(selectors);
	const scratchEnvironment = scratchDirectory ? {
		PIBOX_E2E_SCRATCH_DIR: scratchDirectory,
		...(mcpServerAllowlist(selectors).includes("playwright") ? { PLAYWRIGHT_MCP_OUTPUT_DIR: scratchDirectory } : {}),
	} : {};
	if (context.action.taskId && (context.action.kind === "task-launch" || context.action.kind === "task-repair") && !tools.includes("task_clarify")) tools.push("task_clarify");
	const slotKind = context.action.kind === "integration-repair" ? "integration"
		: context.action.kind === "verification-repair" ? "verification"
			: context.action.kind.replace(/-fix$/, "");
	const slotId = context.action.taskId ? `task:${context.action.taskId}` : context.action.stageId ? `stage:${context.action.stageId}:${slotKind}` : slotKind;
	const launched = await context.runtime.launcher.launch({
		storyId: context.story.id,
		slotId,
		attemptToken: context.token,
		action: context.action.kind,
		role,
		tier,
		cwd,
		stableSystemContext: [`You are the PiBox ${role}. Follow the supplied bounded role context exactly.`, stableContext].join("\n\n"),
		attemptUserPrompt: attemptPrompt,
		provider: route.model.provider,
		model: route.model.id,
		effort: route.effort,
		providerCandidates: route.candidates,
		tools,
		fast: isSubagentFastActive(tier, { provider: route.model.provider, model: route.model.id }),
		...(context.action.taskId ? { taskId: context.action.taskId } : {}),
		env: { ...mcpLaunchEnvironment(selectors), ...scratchEnvironment },
		signal: context.signal,
	});
	return { text: launched.text, exitCode: launched.exitCode, stderr: launched.stderr, terminalReason: launched.terminalReason };
}

function parseObject(text: string): Record<string, unknown> | undefined {
	const candidates = [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((value): value is string => Boolean(value));
	for (const candidate of candidates) {
		try { const value = JSON.parse(candidate); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; }
		catch { /* try the next bounded representation */ }
	}
	return undefined;
}

function assertOwnedTerminal(terminal: { terminalReason: string }): void {
	if (terminal.terminalReason === "owner_lost") throw new OwnerLostTerminal();
}

function parsedAgentResult(text: string, fallbackSummary: string): StoryWorkflowActionResult {
	const value = parseObject(text);
	if (!value) return { result: "repairable", failure: failure("invalid_structured_result", `${fallbackSummary}: agent omitted structured JSON`) };
	const result = ["passed", "repairable", "critical", "needs_user", "unsafe"].includes(String(value.result)) ? value.result as StoryWorkflowActionResult["result"] : "repairable";
	const summary = typeof value.summary === "string" ? failure(result, value.summary) : failure(result, fallbackSummary);
	const findings: StructuredFinding[] = Array.isArray(value.findings) ? value.findings.flatMap((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const finding = entry as Record<string, unknown>;
		if (!["critical", "major", "minor"].includes(String(finding.severity)) || typeof finding.summary !== "string") return [];
		return [{
			id: typeof finding.id === "string" ? finding.id.slice(0, 200) : `finding-${index + 1}`,
			severity: finding.severity as StructuredFinding["severity"],
			code: typeof finding.code === "string" ? finding.code.slice(0, 80) : "review_finding",
			summary: finding.summary.slice(0, 2_000),
			...(typeof finding.path === "string" ? { path: finding.path.slice(0, 500) } : {}),
			...(Number.isInteger(finding.line) && Number(finding.line) >= 1 ? { line: Number(finding.line) } : {}),
		}];
	}) : [];
	const effectiveResult = findings.some((finding) => finding.severity === "critical") ? "critical"
		: result === "passed" && findings.some((finding) => finding.severity === "major") ? "repairable" : result;
	const convertedFailure = effectiveResult === "critical" && result !== "critical" ? failure("critical_review_finding", summary.summary)
		: effectiveResult !== result ? failure("review_findings", summary.summary) : summary;
	return effectiveResult === "passed" ? { result: effectiveResult, summary, findings } : { result: effectiveResult, failure: convertedFailure, findings };
}

function gitStatusPaths(status: string): string[] {
	const entries = status.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		const code = entry.slice(0, 2);
		paths.push(entry.slice(3).replaceAll("\\", "/"));
		if (code.includes("R") || code.includes("C")) paths.push(entries[++index]!.replaceAll("\\", "/"));
	}
	return paths;
}

async function canonicalDirtyPaths(root: string): Promise<string[]> {
	return gitStatusPaths(await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

async function validateEvidenceReferences(repositoryRoot: string, storyId: string, references: unknown): Promise<string[]> {
	if (!Array.isArray(references) || references.length > 64) throw new Error("E2E evidenceRefs must be an array of at most 64 paths");
	const storyRoot = resolve(repositoryRoot, "agent-artifacts", storyId);
	const evidenceRoot = resolve(storyRoot, "evidence");
	const resolvedEvidenceRoot = await realpath(evidenceRoot).catch(() => evidenceRoot);
	const validated: string[] = [];
	for (const entry of references) {
		if (typeof entry !== "string" || !entry || entry.length > 500) throw new Error("E2E evidence references must be bounded non-empty paths");
		const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
		if (!normalized.startsWith("evidence/") || normalized.split("/").includes("..")) throw new Error(`E2E evidence must stay under agent-artifacts/${storyId}/evidence: ${entry}`);
		const absolute = resolve(storyRoot, normalized);
		const actual = await realpath(absolute).catch(() => undefined);
		const info = actual ? await stat(actual).catch(() => undefined) : undefined;
		if (!actual || !info?.isFile() || (actual !== resolvedEvidenceRoot && !actual.startsWith(`${resolvedEvidenceRoot}${sep}`))) throw new Error(`E2E evidence must resolve to an existing regular file under agent-artifacts/${storyId}/evidence: ${entry}`);
		await validateEvidenceSource(repositoryRoot, absolute);
		validated.push(`evidence/${relative(resolvedEvidenceRoot, actual).split(sep).join("/")}`);
	}
	return [...new Set(validated)];
}

async function assertOnlyEvidenceDirty(repositoryRoot: string, storyId: string, references: readonly string[]): Promise<void> {
	const allowed = new Set(references.map((reference) => `agent-artifacts/${storyId}/${reference}`));
	const dirty = await canonicalDirtyPaths(repositoryRoot);
	const invalid = dirty.filter((path) => !allowed.has(path));
	if (invalid.length) throw new Error(`E2E mutated paths outside its validated evidence set: ${invalid.join(", ")}`);
}

async function validateContribution(context: StoryWorkflowActionContext, workspace: { path: string; base: string }): Promise<string> {
	await assertClean(workspace.path);
	const head = await runGit(workspace.path, ["rev-parse", "HEAD"]);
	if (head === workspace.base) throw new Error(`Task ${context.action.taskId} completed without a contribution commit`);
	const descendant = await runGit(workspace.path, ["merge-base", "--is-ancestor", workspace.base, head]).then(() => true, () => false);
	if (!descendant) throw new Error(`Contribution ${head} is not descended from pinned base ${workspace.base}`);
	const forbidden = (await runGit(workspace.path, ["diff", "--name-only", "-z", `${workspace.base}..${head}`, "--", "agent-artifacts", ".pibox", ".worktree"])).split("\0").filter(Boolean);
	if (forbidden.length) throw new Error(`Contribution ${head} changes harness-owned paths: ${forbidden.join(", ")}`);
	const canonicalHead = await runGit(context.runtime.identity.root, ["rev-parse", "HEAD"]);
	if (canonicalHead !== workspace.base) throw new Error(`Canonical branch moved outside harness integration while task ${context.action.taskId} was isolated`);
	await assertCleanRepository(context.runtime.identity.root);
	return head;
}

async function deterministicChecks(context: StoryWorkflowActionContext, checks: AuthoredTaskDocument["checks"] | StoryPlanDocument["stages"][number]["checks"], cwd: string): Promise<StoryWorkflowActionResult> {
	const results = [];
	for (const [index, check] of checks.entries()) {
		const id = checkId(check, index);
		const normalized = normalizeChecks([check], `${id} check`)[0]!;
		const executed = await runShell(verificationCommand(check), cwd, context.signal, verificationProfile(context.runtime.config, normalized));
		if (executed.code !== 0) {
			const failed = failure("check_failed", `${id} failed (${executed.code}): ${(executed.stderr || executed.stdout || "no output").slice(-1_500)}`);
			results.push({ id, status: "failed" as const, failure: failed });
			return { result: "repairable", failure: failed, checks: results };
		}
		results.push({ id, status: "passed" as const });
	}
	return { result: "passed", summary: failure("passed", `${checks.length} deterministic check(s) passed`), checks: results };
}

async function assertClean(cwd: string): Promise<void> {
	const status = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status) throw new Error(`Agent left uncommitted changes in ${cwd}: ${status.slice(0, 1_500)}`);
}

async function treeDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	const visit = async (path: string, prefix: string): Promise<void> => {
		const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = join(path, entry.name);
			const info = await lstat(absolute);
			hash.update(`${relativePath}\0${info.mode}\0`);
			if (info.isDirectory()) await visit(absolute, relativePath);
			else if (info.isFile()) hash.update(await readFile(absolute));
			else if (info.isSymbolicLink()) hash.update(`symlink:${await realpath(absolute).catch(() => "broken")}`);
			else hash.update("unsupported");
		}
	};
	await visit(root, "");
	return hash.digest("hex");
}

async function executeCanonicalRepair(context: StoryWorkflowActionContext, role: string, stable: string, prompt: string): Promise<StoryWorkflowActionResult> {
	const root = context.runtime.identity.root;
	await assertCanonicalBranch(context.runtime, context.state);
	await assertCleanRepository(root);
	const base = await runGit(root, ["rev-parse", "HEAD"]);
	const suffix = randomUUID();
	const branch = `harness/${context.story.id}/repair/${suffix}`;
	const workspace = join(root, ".worktree", "pibox", context.story.id, `repair-${suffix}`);
	let added = false;
	let ownerLost = false;
	try {
		await mkdir(join(workspace, ".."), { recursive: true, mode: 0o700 });
		await runGit(root, ["worktree", "add", "-b", branch, workspace, base]);
		added = true;
		const authoredBefore = await treeDigest(join(workspace, "agent-artifacts"));
		const terminal = await launchAgent(context, role, stable, prompt, workspace);
		assertOwnedTerminal(terminal);
		if (terminal.exitCode !== 0) return { result: "repairable", failure: failure("repair_worker_failed", terminal.stderr || terminal.text || "Repair worker failed") };
		await assertClean(workspace);
		if (await treeDigest(join(workspace, "agent-artifacts")) !== authoredBefore) throw new Error("Repair worker mutated harness-owned authored or runtime artifacts");
		const head = await runGit(workspace, ["rev-parse", "HEAD"]);
		const commits = (await runGit(workspace, ["rev-list", "--reverse", `${base}..${head}`])).split("\n").filter(Boolean);
		const expectedContributions = new Set(context.action.kind === "integration-repair"
			? context.state.stages.find((stage) => stage.id === context.action.stageId)?.tasks.flatMap((task) => task.contributionCommit ? [task.contributionCommit] : []) ?? []
			: []);
		const novel = commits.filter((commit) => !expectedContributions.has(commit));
		if (novel.length !== 1 || novel[0] !== head || commits.some((commit) => commit !== head && !expectedContributions.has(commit))) throw new Error("Repair worker introduced rewritten or unrelated commits");
		const parents = (await runGit(workspace, ["show", "-s", "--format=%P", head])).split(/\s+/).filter(Boolean);
		if (context.action.kind === "integration-repair") {
			if (!parents.includes(base) || [...expectedContributions].some((commit) => !commits.includes(commit))) throw new Error("Integration repair must merge only the pinned task contributions onto canonical HEAD");
		} else if (parents.length !== 1 || parents[0] !== base) throw new Error("Repair worker rewrote history or produced a merge commit");
		const changed = (await runGit(workspace, ["diff", "--name-only", "-z", `${base}..${head}`])).split("\0").filter(Boolean);
		if (!changed.length) throw new Error("Repair worker produced an empty commit");
		const forbidden = changed.filter((path) => path === ".gitignore" || path === ".pi/harness.yaml" || path === ".pi/permissions.yaml" || path.startsWith("agent-artifacts/") || path.startsWith(".pibox/") || path.startsWith(".worktree/"));
		if (forbidden.length) throw new Error(`Repair worker changed harness-owned paths: ${forbidden.join(", ")}`);
		await assertCanonicalBranch(context.runtime, context.state);
		await assertCleanRepository(root);
		if (await runGit(root, ["rev-parse", "HEAD"]) !== base) throw new Error("Canonical HEAD moved while the repair contribution was isolated");
		await runGit(root, ["merge", "--ff-only", head]);
		return { result: "passed", summary: failure("repaired", terminal.text || `${context.action.kind} completed`), integratedCommit: await runGit(root, ["rev-parse", "HEAD"]) };
	} catch (error) {
		await runGit(root, ["merge", "--abort"]).catch(() => undefined);
		if (error instanceof OwnerLostTerminal) { ownerLost = true; throw error; }
		return { result: "repairable", failure: failure("invalid_repair", error instanceof Error ? error.message : String(error)) };
	} finally {
		if (!ownerLost) {
			if (added) await runGit(root, ["worktree", "remove", "--force", workspace]).catch(() => undefined);
			await runGit(root, ["branch", "-D", branch]).catch(() => undefined);
		}
	}
}

async function productionExecutor(context: StoryWorkflowActionContext): Promise<StoryWorkflowActionResult> {
	const action = context.action;
	if (!["task-launch", "task-check", "task-repair"].includes(action.kind)) await assertCanonicalBranch(context.runtime, context.state);
	if (action.kind === "task-launch" || action.kind === "task-repair") {
		const task = context.tasks.get(action.taskId!);
		if (!task) throw new Error(`Unknown task ${action.taskId}`);
		const workspace = await taskWorkspace(context);
		const prompt = action.kind === "task-launch"
			? "Implement the complete assigned task. Make the smallest correct change, run only useful local diagnostics, commit exactly one coherent contribution, and leave the worktree clean."
			: `Repair the task contribution for this harness-reported failure:\n${action.reason?.summary ?? "The prior deterministic task check failed."}\nCommit the bounded repair and leave the worktree clean.`;
		const terminal = await launchAgent(context, task.assignment.agent, stableTaskContext(task), prompt, workspace.path);
		assertOwnedTerminal(terminal);
		if (terminal.exitCode !== 0) return { result: "repairable", failure: failure("worker_failed", terminal.stderr || terminal.text || `Task worker exited ${terminal.exitCode}`) };
		try {
			const head = await validateContribution(context, workspace);
			return { result: "passed", summary: failure("implemented", terminal.text || `Task ${task.id} implemented`), contributionCommit: head };
		} catch (error) {
			return { result: "repairable", failure: failure("invalid_contribution", error instanceof Error ? error.message : String(error)) };
		}
	}
	if (action.kind === "task-check") {
		const task = context.tasks.get(action.taskId!);
		if (!task) throw new Error(`Unknown task ${action.taskId}`);
		return deterministicChecks(context, task.checks, (await taskWorkspace(context)).path);
	}
	if (action.kind === "integration") {
		const stage = context.state.stages.find((candidate) => candidate.id === action.stageId)!;
		const definition = stageDefinition(context);
		return withGitLock(context.runtime, `story-integration:${context.story.id}:${action.stageId}`, async () => {
			try {
				await assertCanonicalBranch(context.runtime, context.state);
				await assertClean(context.runtime.identity.root);
				const base = stageBase(context.state, stage.id);
				if (await runGit(context.runtime.identity.root, ["rev-parse", "HEAD"]) !== base) throw new Error(`Canonical branch moved from pinned stage base ${base}`);
				let sequentialParent = base;
				for (const task of stage.tasks) {
					const commit = task.contributionCommit;
					if (!commit) throw new Error(`Task ${task.id} has no validated contribution commit`);
					const rangeBase = definition.mode === "sequential" ? sequentialParent : base;
					const ordered = await runGit(context.runtime.identity.root, ["merge-base", "--is-ancestor", rangeBase, commit]).then(() => true, () => false);
					if (!ordered) throw new Error(`Contribution ${commit} is not descended from ordered base ${rangeBase}`);
					const commits = (await runGit(context.runtime.identity.root, ["rev-list", "--reverse", `${rangeBase}..${commit}`])).split("\n").filter(Boolean);
					for (const contribution of commits) {
						const included = await runGit(context.runtime.identity.root, ["merge-base", "--is-ancestor", contribution, "HEAD"]).then(() => true, () => false);
						if (!included) await runGit(context.runtime.identity.root, ["cherry-pick", contribution]);
					}
					if (definition.mode === "sequential") sequentialParent = commit;
				}
				return { result: "passed", summary: failure("integrated", `Stage ${action.stageId} contributions integrated`), integratedCommit: await runGit(context.runtime.identity.root, ["rev-parse", "HEAD"]) };
			} catch (error) {
				await runGit(context.runtime.identity.root, ["cherry-pick", "--abort"]).catch(() => undefined);
				return { result: "repairable", failure: failure("integration_failed", error instanceof Error ? error.message : String(error)) };
			}
		});
	}
	if (action.kind === "verification") {
		const stage = context.plan.stages.find((candidate) => candidate.id === action.stageId)!;
		return deterministicChecks(context, stage.checks, context.runtime.identity.root);
	}
	if (action.kind === "integration-repair" || action.kind === "verification-repair" || action.kind === "review-fix" || action.kind === "final-review-fix" || action.kind === "e2e-fix") {
		const role = context.runtime.config.agents["repair-implementer"] ? "repair-implementer" : "implementer";
		const stage = action.stageId ? context.plan.stages.find((candidate) => candidate.id === action.stageId) : undefined;
		const findings = action.kind.includes("review")
			? (action.stageId ? context.state.stages.find((candidate) => candidate.id === action.stageId)?.review.currentFindings : context.state.finalReview.currentFindings)
			: undefined;
		const stable = [reviewContext(context), action.kind === "e2e-fix" ? `## Complete E2E contract\n${context.story.e2e}` : undefined].filter(Boolean).join("\n\n");
		const coordinates = await reviewCoordinates(context);
		const prompt = [
			`Perform the bounded ${action.kind} in the isolated repair workspace and commit exactly one repair contribution.`,
			coordinates.prompt,
			action.reason?.summary,
			findings?.length ? JSON.stringify(findings, null, 2) : undefined,
			stage ? `Stage tasks: ${stage.tasks.join(", ")}` : undefined,
		].filter(Boolean).join("\n\n");
		const repaired = await executeCanonicalRepair(context, role, stable, prompt);
		if (repaired.result !== "passed" || action.kind !== "integration-repair") return repaired;
		const stageState = context.state.stages.find((candidate) => candidate.id === action.stageId);
		for (const commit of stageState?.tasks.flatMap((task) => task.contributionCommit ? [task.contributionCommit] : []) ?? []) {
			const included = await runGit(context.runtime.identity.root, ["merge-base", "--is-ancestor", commit, "HEAD"]).then(() => true, () => false);
			if (!included) return { result: "repairable", failure: failure("integration_incomplete", `Integration repair did not include contribution ${commit}`) };
		}
		return repaired;
	}
	if (action.kind === "review" || action.kind === "final-review") {
		const role = context.runtime.config.agents["code-reviewer"] ? "code-reviewer" : "reviewer";
		const coordinates = await reviewCoordinates(context);
		const terminal = await launchAgent(context, role, reviewContext(context), `Review the current branch against the complete supplied contract.\n${coordinates.prompt}\nReturn the required structured JSON only.`, context.runtime.identity.root);
		assertOwnedTerminal(terminal);
		if (terminal.exitCode !== 0) return { result: "repairable", failure: failure("reviewer_failed", terminal.stderr || terminal.text || "Reviewer failed") };
		return parsedAgentResult(terminal.text, `${action.kind} did not produce a verdict`);
	}
	if (action.kind === "e2e") {
		const role = context.runtime.config.agents["e2e-tester"] ? "e2e-tester" : "code-reviewer";
		const stable = [
			"# Complete final E2E contract", context.story.e2e,
			`Exercise the complete contract against the integrated branch. Your working directory is the repository root. Use the disposable directory named by $PIBOX_E2E_SCRATCH_DIR for tool-generated or intermediate output that is not retained evidence. Write every retained evidence file beneath agent-artifacts/${context.story.id}/evidence/; do not create a top-level evidence/ directory. Before returning, remove only transient repository files created by this attempt and verify that repository changes consist exclusively of the cited evidence files. In the returned JSON, cite those files with story-relative evidenceRefs such as evidence/result.json (without the agent-artifacts/${context.story.id}/ prefix). Evidence must contain no sensitive content. Return only JSON with result, summary, optional findings, and evidenceRefs.`,
		].join("\n\n");
		await assertCleanRepository(context.runtime.identity.root);
		const coordinates = await reviewCoordinates(context);
		const scratchDirectory = await createE2eScratchDirectory(context.runtime.identity.root);
		try {
			const terminal = await launchAgent(context, role, stable, `Run the complete final E2E contract.\n${coordinates.prompt}\nReturn the required structured JSON only.`, context.runtime.identity.root, scratchDirectory);
			assertOwnedTerminal(terminal);
			if (terminal.exitCode !== 0) return { result: "repairable", failure: failure("e2e_worker_failed", terminal.stderr || terminal.text || "E2E worker failed") };
			const parsed = parsedAgentResult(terminal.text, "E2E did not produce a verdict");
			const raw = parseObject(terminal.text);
			try {
				if (await runGit(context.runtime.identity.root, ["rev-parse", "HEAD"]) !== coordinates.head) throw new Error("E2E execution mutated canonical Git history");
				const evidenceRefs = await validateEvidenceReferences(context.runtime.identity.root, context.story.id, raw?.evidenceRefs ?? []);
				await assertOnlyEvidenceDirty(context.runtime.identity.root, context.story.id, evidenceRefs);
				return { ...parsed, evidenceRefs };
			} catch (error) {
				return { result: "critical", failure: failure("evidence_invalid", error instanceof Error ? error.message : String(error)), ...(parsed.findings ? { findings: parsed.findings } : {}) };
			}
		} finally {
			await rm(scratchDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
		}
	}
	throw new Error(`Unsupported workflow action: ${action.kind}`);
}

function outcomeMarkdown(loaded: LoadedStory, state: StoryRuntimeState, ledger: readonly LedgerEntry[]): string {
	const inline = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
	const reviews = [...state.stages.map((stage) => stage.review), state.finalReview];
	const acceptedRisks = reviews.flatMap((review) => (review.acceptedRisks ?? []).map((accepted) => {
		const finding = review.currentFindings.find((candidate) => candidate.id === accepted.findingId);
		return `- ${inline(accepted.findingId)}: ${inline(finding?.summary ?? "unresolved review finding")} — accepted ${accepted.acceptedAt}: ${inline(accepted.rationale)}`;
	}));
	const acceptedFindingIds = new Set(reviews.flatMap((review) => (review.acceptedRisks ?? []).map((risk) => risk.findingId)));
	const retainedReviewRisks = ledger.filter((entry) => entry.sourceRole === "reviewer" && ![...acceptedFindingIds].some((id) => entry.id.endsWith(`:${id}`)))
		.map((entry) => `- ${inline(entry.summary)}${entry.evidence?.length ? ` — evidence: ${entry.evidence.map(inline).join(", ")}` : ""}`);
	const checks = state.stages.flatMap((stage) => [
		...stage.tasks.flatMap((task) => task.checks.map((check) => `- ${stage.id}/${task.id}/${check.id}: ${check.status}`)),
		...stage.verification.checks.map((check) => `- ${stage.id}/${check.id}: ${check.status}`),
	]);
	const lines = [
		`# ${loaded.story.title} — outcome`, "",
		"Status: completed", "",
		"## Delivered stages",
		...state.stages.map((stage) => `- ${stage.id}: ${stage.status}; integration ${stage.integration.integratedCommit ?? "not recorded"}; tasks ${stage.tasks.map((task) => task.id).join(", ")}`),
		"", "## Deterministic checks", ...(checks.length ? checks : ["None declared."]),
		"", "## Review and E2E summaries",
		...state.stages.map((stage) => `- ${stage.id} review: ${stage.review.result?.summary ?? stage.review.status}`),
		`- Final review: ${state.finalReview.result?.summary ?? state.finalReview.status}`,
		`- E2E: ${state.e2e.result?.summary ?? state.e2e.status}`,
		"", "## Deviations", "None recorded.",
		"", "## Residual risks", ...(acceptedRisks.length || retainedReviewRisks.length ? [...acceptedRisks, ...retainedReviewRisks] : ["None recorded."]),
		"", "## Metrics",
		`- Workflow: ${state.metrics.workflowMs} ms`,
		...Object.entries(state.metrics.categories).map(([category, milliseconds]) => `- ${category}: ${milliseconds} ms`),
		`- Incomplete categories: ${state.metrics.incompleteCategories.length ? state.metrics.incompleteCategories.join(", ") : "none"}`,
		"", "## Evidence", ...(state.e2e.evidenceRefs.length ? state.e2e.evidenceRefs.map((reference) => `- ${reference}`) : ["None recorded."]),
	];
	return `${lines.join("\n")}\n`;
}

async function finalizeCompletion(runtime: HarnessWorkflowRuntime, loaded: LoadedStory, state: StoryRuntimeState): Promise<string> {
	return withGitLock(runtime, `story-completion:${loaded.story.id}`, async () => {
		await assertCanonicalBranch(runtime, state);
		const root = runtime.identity.root;
		const evidenceRefs = await validateEvidenceReferences(root, loaded.story.id, state.e2e.evidenceRefs);
		await assertOnlyEvidenceDirty(root, loaded.story.id, evidenceRefs);
		const outcomeRelative = `agent-artifacts/${loaded.story.id}/outcome.md`;
		const evidencePaths = evidenceRefs.map((reference) => `agent-artifacts/${loaded.story.id}/${reference}`);
		const ledger = await storeFor(root, loaded.story.id).readLedger();
		await atomicWriteFile(join(root, outcomeRelative), outcomeMarkdown(loaded, state, ledger.entries));
		const allowed = new Set([...evidencePaths, outcomeRelative]);
		const unexpected = (await canonicalDirtyPaths(root)).filter((path) => !allowed.has(path));
		if (unexpected.length) throw new Error(`Completion found unrelated canonical changes: ${unexpected.join(", ")}`);
		try {
			const message = `chore(pibox): complete story ${loaded.story.id}`;
			await runGit(root, ["add", "--", ...evidencePaths, outcomeRelative]);
			const staged = (await runGit(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
			if (staged.length === 0) {
				if (await runGit(root, ["show", "-s", "--format=%s", "HEAD"]) !== message) throw new Error("Completion produced no commit-owned changes");
			} else {
				const expected = new Set([...evidencePaths, outcomeRelative]);
				if (staged.some((path) => !expected.has(path))) throw new Error(`Completion staged unrelated paths: ${staged.join(", ")}`);
				await runGit(root, ["commit", "-m", message]);
			}
			await assertCleanRepository(root);
			return await runGit(root, ["rev-parse", "HEAD"]);
		} catch (error) {
			await runGit(root, ["reset", "--", ...evidencePaths, outcomeRelative]).catch(() => undefined);
			throw error;
		}
	});
}

export function createHarnessWorkflowAdapter(options: HarnessWorkflowAdapterOptions): WorkflowAdapter {
	const now = options.now ?? (() => new Date());
	const execute = options.executeAction ?? productionExecutor;

	const executeActivated = async (ctx: ExtensionContext, runtime: HarnessWorkflowRuntime, loaded: LoadedStory, action: WorkflowAction, token: string, owner: RuntimeOwner): Promise<void> => {
		const key = attemptKey(runtime.identity.root, loaded.story.id, token);
		const active = globals()[ACTIVE_ACTIONS];
		if (active.has(key)) return;
		const controller = new AbortController();
		let ownerLost = false;
		const operation = async () => {
			let result: StoryWorkflowActionResult;
			try {
				const store = storeFor(runtime.identity.root, loaded.story.id);
				const [state, ledger] = await Promise.all([store.readState(), store.readLedger()]);
				if (!state || !activeActions(state).some((active) => active.token === token && sameOwner(active.owner, owner) && sameWorkflowAction(active.action, action))) return;
				result = await execute({ ctx, runtime, ...loaded, state, action, token, owner, signal: controller.signal, ledger: ledger.entries });
			} catch (error) {
				if (error instanceof OwnerLostTerminal) { ownerLost = true; return; }
				result = error instanceof WorkspaceInvariantError
					? { result: "needs_user", failure: failure("workspace_invariant", error.message) }
					: { result: "repairable", failure: failure("action_failed", error instanceof Error ? error.message : String(error)) };
			}
			let accepted = false;
			await storeFor(runtime.identity.root, loaded.story.id).updateState((current) => {
				if (!current) throw new Error(`Runtime state disappeared for ${loaded.story.id}`);
				const settled = settleWorkflowAction(current, { action, token, owner, ...result }, runtime.config.limits.repairRounds);
				accepted = settled.accepted;
				let next = settled.state;
				if (accepted && next.status !== "running" && activeActions(next).length === 0 && next.metrics.open) next = { ...next, metrics: transitionWorkflowClock(next.metrics, undefined, now().toISOString()) };
				if (accepted && result.result === "critical" && result.failure?.code === "evidence_invalid") next = { ...next, outcomeStatus: "failed" };
				return next;
			}, () => accepted ? { type: "action.settled", ...(action.stageId ? { stageId: action.stageId } : {}), ...(action.taskId ? { taskId: action.taskId } : {}), slotId: action.kind, attemptToken: token, resultCode: result.result } : undefined);
			if (accepted) {
				const store = storeFor(runtime.identity.root, loaded.story.id);
				const prefix = reviewLedgerPrefix(action);
				try { if (prefix && result.findings?.length) {
					for (const finding of result.findings) await store.upsertLedger({
						id: `${prefix}${finding.id}`.slice(0, 120), updatedAt: now().toISOString(), sourceRole: "reviewer",
						summary: `${finding.severity} ${finding.code}: ${finding.summary}`.slice(0, 2_000), ...(finding.path ? { evidence: [finding.path] } : {}),
					});
				} else if (prefix && result.result === "passed") {
					const ledger = await store.readLedger();
					await store.pruneLedger(ledger.entries.filter((entry) => entry.id.startsWith(prefix)).map((entry) => entry.id));
				} } catch { /* state remains authoritative if optional ledger curation fails */ }
				emit(runtime.identity.root, loaded.story.id);
			}
		};
		const execution = canonicalRepair(action)
			? withGitLock(runtime, `story-repair:${loaded.story.id}:${action.kind}`, operation)
			: operation();
		const promise = execution.finally(() => {
			active.delete(key);
			if (!ownerLost) void advance(ctx, runtime, loaded).catch(() => undefined);
		});
		active.set(key, { promise, controller, childBacked: childBacked(action), owner });
	};

	const rebind = async (ctx: ExtensionContext, runtime: HarnessWorkflowRuntime, loaded: LoadedStory, state: StoryRuntimeState): Promise<void> => {
		const owner = runtime.launcher.service.owner;
		for (const active of activeActions(state)) if (sameOwner(active.owner, owner)) await executeActivated(ctx, runtime, loaded, active.action, active.token, active.owner);
	};

	const advance = async (ctx: ExtensionContext, runtime: HarnessWorkflowRuntime, loaded: LoadedStory): Promise<void> => {
		const store = storeFor(runtime.identity.root, loaded.story.id);
		const current = await store.readState();
		if (!current) throw new Error(`Workflow ${loaded.story.id} has not been started`);
		stateMatchesPlan(current, loaded);
		await assertCanonicalBranch(runtime, current);
		const owner = runtime.launcher.service.owner;
		let actions: WorkflowAction[] = [];
		let completed = false;
		const serviceActive = runtime.launcher.activeCount();
		const reservedChildren = [...globals()[ACTIVE_ACTIONS].values()].filter((entry) => entry.childBacked && sameOwner(entry.owner, owner)).length;
		let childCapacity = Math.max(0, Math.min(runtime.config.limits.maxConcurrency, runtime.config.limits.maxActiveSubagentsPerSession) - Math.max(serviceActive, reservedChildren));
		const committed = await store.updateState((current) => {
			if (!current) throw new Error(`Workflow ${loaded.story.id} has not been started`);
			stateMatchesPlan(current, loaded);
			const projected = advanceStageStateMachine(loaded.machinePlan, current);
			let next = projected.state;
			actions = projected.actions.map((action) => {
				const reason = actionFailure(next, action);
				return reason ? { ...action, reason } : action;
			}).filter((action) => {
				if (!childBacked(action)) return true;
				if (childCapacity <= 0) return false;
				childCapacity -= 1;
				return true;
			});
			for (const action of actions) {
				const token = createAttemptToken();
				const at = now().toISOString();
				next = activateWorkflowAction(next, action, token, owner, at);
				const category = categoryFor(action);
				if (category && next.metrics.open?.category !== category) next.metrics = transitionWorkflowClock(next.metrics, category, at);
			}
			completed = next.status === "completed";
			if (completed && next.metrics.open) next.metrics = transitionWorkflowClock(next.metrics, undefined, now().toISOString());
			return next;
		}, (state) => ({ type: completed ? "workflow.completed" : "workflow.advanced", resultCode: state.status }));
		const state = committed.state;
		if (completed && committed.stateWritten) {
			try {
				await finalizeCompletion(runtime, loaded, state);
				await store.updateState((current) => ({ ...current!, status: "completed", outcomeStatus: "written" }), { type: "outcome.written", resultCode: "written" });
				await runtime.launcher.releaseStory(loaded.story.id);
			} catch (error) {
				const reason = failure("outcome_failed", error instanceof Error ? error.message : String(error));
				await store.updateState((current) => ({ ...current!, status: "attention", attention: reason, outcomeStatus: "failed" }), { type: "outcome.failed", resultCode: "outcome_failed" });
			}
			emit(runtime.identity.root, loaded.story.id);
			return;
		}
		await rebind(ctx, runtime, loaded, state);
		if (committed.stateWritten) emit(runtime.identity.root, loaded.story.id);
	};

	return {
		id: "workflow",
		canHandle(ref) { return WORK_ITEM.test(ref); },
		async preflightWorkflow(ref, ctx): Promise<WorkflowPreflight> {
			const runtime = await options.runtimeFor(ctx);
			if (!runtime.launcher?.service) return { ok: false, detail: "The standalone SubagentService is required for workflow execution." };
			const loaded = await loadStory(runtime, storyId(ref));
			const currentBranch = await runGit(runtime.identity.root, ["branch", "--show-current"]);
			if (currentBranch !== loaded.canonicalBranch) return { ok: false, detail: `Workflow execution requires its persisted canonical branch ${loaded.canonicalBranch}; current branch is ${currentBranch || "detached HEAD"}.` };
			const existing = await storeFor(runtime.identity.root, loaded.story.id).readState();
			if (existing) stateMatchesPlan(existing, loaded);
			const prerequisites = await preflightChecks(loaded, runtime.identity.root, runtime.config);
			if (prerequisites.missingCommands.length || prerequisites.missingEnvironment.length) {
				const detail = [
					prerequisites.missingCommands.length ? `missing commands: ${prerequisites.missingCommands.join(", ")}` : undefined,
					prerequisites.missingEnvironment.length ? `missing environment: ${prerequisites.missingEnvironment.join(", ")}` : undefined,
				].filter(Boolean).join("; ");
				return { ok: false, ...prerequisites, detail: `Workflow preflight failed: ${detail}. Configure the declared prerequisites and retry.` };
			}
			const missingIgnores = await missingRuntimeIgnorePaths(runtime.identity.root, loaded.story.id);
			if (missingIgnores.length) return { ok: false, detail: runtimeIgnoreDetail(missingIgnores) };
			const sameActivationPause = existing?.status === "paused" && sameOwner(existing.activationOwner, runtime.launcher.service.owner) && activeActions(existing).length > 0;
			if (!sameActivationPause) await assertCleanRepository(runtime.identity.root);
			return { ok: true };
		},
		async snapshot(ref, ctx) {
			const runtime = await options.runtimeFor(ctx);
			const loaded = await loadStory(runtime, storyId(ref));
			const state = await storeFor(runtime.identity.root, loaded.story.id).readState() ?? await initialState(runtime, loaded);
			stateMatchesPlan(state, loaded);
			return workflowSnapshot(ref, loaded.story.title, state, loaded.plan);
		},
		async controlExecution(ref, command, _operationId, ctx): Promise<WorkflowExecutionControl> {
			const runtime = await options.runtimeFor(ctx);
			const loaded = await loadStory(runtime, storyId(ref));
			const store = storeFor(runtime.identity.root, loaded.story.id);
			const owner = runtime.launcher.service.owner;
			if (command === "start" || command === "resume") await assertRuntimePathsIgnored(runtime.identity.root, loaded.story.id);
			if (command === "start") {
				const candidate = await initialState(runtime, loaded);
				let initialized = false;
				await store.updateState((current) => {
					if (current) return current;
					initialized = true;
					return candidate;
				}, () => initialized ? { type: "workflow.initialized", resultCode: "ready" } : undefined);
			}
			if (command === "attach") {
				const state = await store.readState();
				if (!state || !sameOwner(state.activationOwner, owner) || !["running", "paused"].includes(state.status)) throw new Error(`Workflow ${ref} cannot rebind outside its owning activation`);
				return { workflowRef: ref, mode: state.status === "paused" ? "paused" : "running", ownerSessionId: owner.sessionId, ownerProcessInstanceId: owner.processInstanceId, ownerActivationId: owner.activationId };
			}
			if (command === "detach") {
				const state = await store.readState();
				return { workflowRef: ref, mode: state?.status === "paused" ? "paused" : "running", ownerSessionId: owner.sessionId, ownerProcessInstanceId: owner.processInstanceId, ownerActivationId: owner.activationId };
			}
			if (command === "resume") {
				const prior = await store.readState();
				if (!prior) throw new Error(`Workflow ${ref} has not been started`);
				stateMatchesPlan(prior, loaded);
				await assertCanonicalBranch(runtime, prior);
				if (hasWorkflowAttention(prior)) throw new Error(`Workflow ${ref} still has unresolved attention; use workflow_control with action=request_changes or action=approve`);
				if (prior.activationOwner && !sameOwner(prior.activationOwner, owner)) {
					const oldOwner = prior.activationOwner;
					await withGitLock(runtime, `story-resume-owner:${loaded.story.id}`, () => store.updateState((current) => {
						const running = current!.status === "paused" ? { ...current!, status: "running" as const } : current!;
						return interruptOwnedAttempts(running, oldOwner);
					}, { type: "workflow.interrupted", resultCode: "owner_replaced" }));
				}
			}
			const commitControl = () => store.updateState((current) => {
				let state = current ?? (() => { throw new Error(`Workflow ${ref} has not been initialized`); })();
				stateMatchesPlan(state, loaded);
				const at = now().toISOString();
				if (command === "start") {
					if (state.status !== "ready") throw new Error(`Workflow ${ref} cannot start from ${state.status}`);
					state = startWorkflow(state, owner);
				} else if (command === "resume") {
					if (hasWorkflowAttention(state)) throw new Error(`Workflow ${ref} still has unresolved attention; use workflow_control with action=request_changes or action=approve`);
					if (state.status === "stopped") state = { ...state, status: "paused" };
					if (state.stages.some((stage) => stage.tasks.some((task) => task.status === "interrupted") || stage.integration.status === "interrupted" || stage.verification.status === "interrupted" || stage.review.status === "interrupted") || state.finalReview.status === "interrupted" || state.e2e.status === "interrupted") {
						state = resumeInterruptedWorkflow(state, owner);
					} else {
						state = { ...state, status: "running", activationOwner: structuredClone(owner) };
						delete state.attention;
					}
				} else if (command === "pause") {
					const hasActiveWork = activeActions(state).length > 0;
					state = { ...state, status: "paused" };
					if (!hasActiveWork && state.metrics.open) state.metrics = transitionWorkflowClock(state.metrics, undefined, at);
				} else if (command === "stop") {
					const running = state.status === "paused" ? { ...state, status: "running" as const } : state;
					const clockClosed = running.metrics.open ? { ...running, metrics: transitionWorkflowClock(running.metrics, undefined, at) } : running;
					state = clockClosed.activationOwner ? interruptOwnedAttempts(clockClosed, clockClosed.activationOwner) : clockClosed;
					state = { ...state, status: "stopped" };
					delete state.activationOwner;
				} else if (command === "complete") {
					state = { ...state, status: "completed" };
					if (state.metrics.open) state.metrics = transitionWorkflowClock(state.metrics, undefined, at);
				}
				return state;
			}, { type: `workflow.${command}`, resultCode: command });
			const committed = command === "stop"
				? await withGitLock(runtime, `story-stop:${loaded.story.id}`, commitControl)
				: await commitControl();
			if (command === "stop") {
				for (const [key, active] of globals()[ACTIVE_ACTIONS]) if (key.startsWith(`${runtimeKey(runtime.identity.root, loaded.story.id)}\0`)) active.controller.abort(new DOMException("Workflow stop requested", "AbortError"));
				await runtime.launcher.stopStory(loaded.story.id);
			}
			emit(runtime.identity.root, loaded.story.id);
			const mode = committed.state.status === "completed" ? "completed" : committed.state.status === "stopped" ? "stopped" : committed.state.status === "paused" ? "paused" : "running";
			return { workflowRef: ref, mode, ownerSessionId: owner.sessionId, ownerProcessInstanceId: owner.processInstanceId, ownerActivationId: owner.activationId };
		},
		async reconcileWorkflow(ref, ctx) {
			const runtime = await options.runtimeFor(ctx);
			const loaded = await loadStory(runtime, storyId(ref));
			const state = await storeFor(runtime.identity.root, loaded.story.id).readState();
			if (state) await rebind(ctx, runtime, loaded, state);
		},
		async advanceWorkflow(ref, ctx) {
			const runtime = await options.runtimeFor(ctx);
			const loaded = await loadStory(runtime, storyId(ref));
			await advance(ctx, runtime, loaded);
		},
		async resolveAttention(ref, decision: WorkflowAttentionDecision, ctx, resolveOptions) {
			const runtime = await options.runtimeFor(ctx);
			const loaded = await loadStory(runtime, storyId(ref));
			const store = storeFor(runtime.identity.root, loaded.story.id);
			const resolution = decision.action === "request_changes"
				? { action: "request_changes" as const, ...(decision.prompt ? { prompt: decision.prompt } : {}) }
				: { action: "approve" as const, acceptedRisks: decision.acceptedRisks ?? [], acceptedAt: now().toISOString() };
			if (resolveOptions?.dryRun) {
				const current = await store.readState();
				if (!current) throw new Error(`Workflow ${ref} has not been started`);
				const resolved = resolveWorkflowAttention(current, resolution, runtime.config.limits.repairRounds);
				if (!resolved.accepted) throw new Error(resolved.reason?.summary ?? `Workflow ${ref} attention cannot be resolved by ${decision.action}`);
				return resolved.state;
			}
			const committed = await store.updateState((current) => {
				if (!current) throw new Error(`Workflow ${ref} has not been started`);
				const resolved = resolveWorkflowAttention(current, resolution, runtime.config.limits.repairRounds);
				if (!resolved.accepted) throw new Error(resolved.reason?.summary ?? `Workflow ${ref} attention cannot be resolved by ${decision.action}`);
				return resolved.state;
			}, { type: "attention.resolved", resultCode: decision.action });
			if (decision.action === "approve") {
				const reviews = [...committed.state.stages.map((stage) => stage.review), committed.state.finalReview];
				try { for (const accepted of decision.acceptedRisks ?? []) {
					const acceptedReview = reviews.find((review) => review.acceptedRisks?.some((risk) => risk.findingId === accepted.findingId && risk.rationale === accepted.rationale));
					const finding = acceptedReview?.currentFindings.find((candidate) => candidate.id === accepted.findingId);
					const reviewIndex = acceptedReview ? reviews.indexOf(acceptedReview) : reviews.length;
					await store.upsertLedger({
						id: `accepted-risk:${reviewIndex}:${accepted.findingId}`.slice(0, 120), updatedAt: now().toISOString(), sourceRole: "user",
						summary: `Accepted risk ${accepted.findingId}: ${finding?.summary ?? "unresolved review finding"}. Rationale: ${accepted.rationale}`.slice(0, 2_000),
						...(finding?.path ? { evidence: [finding.path] } : {}),
					});
				} } catch { /* accepted risks remain authoritative in state if optional ledger curation fails */ }
			}
			emit(runtime.identity.root, loaded.story.id);
			return committed.state;
		},
		async prepareWorkflow() { /* controlExecution(start) initializes authoritative state after permission confirmation. */ },
		async completionPrompt(ref) { return `Workflow ${ref} is complete. Brief the user from its story-local outcome.md and authoritative state.yaml.`; },
		async controlWorkflow() { /* State-backed controlExecution owns lifecycle mutation and stop behavior. */ },
		subscribeLifecycle(ref, ctx, listener, signal) {
			return options.runtimeFor(ctx).then((runtime) => {
				const key = runtimeKey(runtime.identity.root, storyId(ref));
				const listeners = globals()[LIFECYCLE_LISTENERS];
				const set = listeners.get(key) ?? new Set<() => void>();
				const notify = () => listener();
				set.add(notify); listeners.set(key, set);
				const unsubscribeCapacity = runtime.launcher.subscribeCapacity(notify);
				const unsubscribe = () => { unsubscribeCapacity(); set.delete(notify); if (set.size === 0) listeners.delete(key); };
				if (signal?.aborted) unsubscribe(); else signal?.addEventListener("abort", unsubscribe, { once: true });
				return unsubscribe;
			});
		},
	};
}
