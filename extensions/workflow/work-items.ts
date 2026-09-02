import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, discoverCommonDirSync, runGit } from "./repository.js";
import { CanonicalMutationCoordinator } from "./canonical-mutation.js";
import { normalizeVerificationChecks } from "./verification-checks.js";
import type {
	AuthoredTaskDocument,
	LegacyWorkItemSummary,
	StoryDocument,
	StoryPlanDocument,
	TargetWorkItem,
	WorkingBranchKind,
	WorkItemDelivery,
} from "./types.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKING_BRANCH_PATTERN = /^(feature|fix)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROTECTED_BRANCHES = new Set(["develop", "main", "master"]);
const LOCAL_PERMISSION_RATIONALE = /(?=.*\buser\b)(?=.*\b(?:request(?:ed)?|permission|approv(?:ed|al)?|authoriz(?:ed|ation)?)\b)/i;
const SENSITIVE_EVIDENCE_NAME = /(^|[._-])(env|credentials?|secrets?|private|token|password|passwd|api[-_]?key|transcript|session)([._-]|$)|\.(pem|key|p12|pfx)$/i;
const SENSITIVE_EVIDENCE_CONTENT = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]+)/i;

function validateId(id: string, label: string): void {
	if (!ID_PATTERN.test(id)) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a kebab-case identifier`);
}

function ensureInside(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") throw new HarnessError("INVALID_ARTIFACT", `Path escapes its managed root: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
	try { await stat(path); return true; }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function mapping(content: string, source: string): Record<string, unknown> {
	const value = parse(content) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("INVALID_ARTIFACT", `${source} must contain a mapping`);
	return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: string[], source: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new HarnessError("INVALID_ARTIFACT", `${source} has unknown field(s): ${unknown.join(", ")}`);
}

function authoredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a non-empty Markdown string`);
	return value;
}

export function parseStoryDocument(content: string, source = "story.yaml"): StoryDocument {
	const value = mapping(content, source);
	exactFields(value, ["schemaVersion", "id", "title", "kind", "spec", "design", "e2e"], source);
	if (value.schemaVersion !== 1 || typeof value.id !== "string" || !ID_PATTERN.test(value.id)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid identity`);
	if (value.kind !== "change" && value.kind !== "story") throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid kind`);
	return { schemaVersion: 1, id: value.id, title: authoredString(value.title, `${source} title`).trim(), kind: value.kind, spec: authoredString(value.spec, `${source} spec`), design: authoredString(value.design, `${source} design`), e2e: authoredString(value.e2e, `${source} e2e`) };
}

export function parseAuthoredTaskDocument(content: string, source = "task.yaml"): AuthoredTaskDocument {
	const value = mapping(content, source);
	exactFields(value, ["schemaVersion", "id", "title", "dependsOn", "description", "scope", "delivery", "checks", "assignment"], source);
	if (value.schemaVersion !== 1 || typeof value.id !== "string" || !ID_PATTERN.test(value.id)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid identity`);
	if (!Array.isArray(value.dependsOn) || value.dependsOn.some((id) => typeof id !== "string" || !ID_PATTERN.test(id)) || new Set(value.dependsOn).size !== value.dependsOn.length) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid dependencies`);
	if (!value.assignment || typeof value.assignment !== "object" || Array.isArray(value.assignment)) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid assignment`);
	const assignment = value.assignment as Record<string, unknown>;
	exactFields(assignment, ["agent", "tier", "rationale", "tierJustification"], `${source} assignment`);
	if (typeof assignment.agent !== "string" || !assignment.agent.trim() || !["low", "medium", "high", "max", "local"].includes(String(assignment.tier)) || typeof assignment.rationale !== "string" || !assignment.rationale.trim()) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid assignment`);
	if (assignment.tierJustification !== undefined && (typeof assignment.tierJustification !== "string" || !assignment.tierJustification.trim())) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid tier justification`);
	if ((assignment.tier === "high" || assignment.tier === "max") && (typeof assignment.tierJustification !== "string" || assignment.tierJustification.trim().length < 20)) throw new HarnessError("INVALID_ARTIFACT", `${source} ${assignment.tier} routing requires a substantive tierJustification`);
	if (assignment.tier === "local" && !LOCAL_PERMISSION_RATIONALE.test(assignment.rationale)) throw new HarnessError("INVALID_ARTIFACT", `${source} local routing requires a rationale recording explicit user permission`);
	return {
		schemaVersion: 1,
		id: value.id,
		title: authoredString(value.title, `${source} title`).trim(),
		dependsOn: value.dependsOn as string[],
		description: authoredString(value.description, `${source} description`),
		scope: authoredString(value.scope, `${source} scope`),
		delivery: authoredString(value.delivery, `${source} delivery`),
		checks: normalizeVerificationChecks(value.checks, `${source} checks`),
		assignment: { agent: assignment.agent.trim(), tier: assignment.tier as AuthoredTaskDocument["assignment"]["tier"], rationale: assignment.rationale.trim(), ...(typeof assignment.tierJustification === "string" ? { tierJustification: assignment.tierJustification.trim() } : {}) },
	};
}

export function parseStoryPlanDocument(content: string, source = "plan.yaml", options: { draft?: boolean } = {}): StoryPlanDocument {
	const value = mapping(content, source);
	exactFields(value, ["schemaVersion", "stages"], source);
	if (value.schemaVersion !== 1 || !Array.isArray(value.stages)) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid schema or stages`);
	const stageIds = new Set<string>();
	const taskIds = new Set<string>();
	const stages = value.stages.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HarnessError("INVALID_ARTIFACT", `${source} stage ${index + 1} must be a mapping`);
		const stage = entry as Record<string, unknown>;
		exactFields(stage, ["id", "tasks", "mode", "checks", "review"], `${source} stage ${index + 1}`);
		if (typeof stage.id !== "string" || !ID_PATTERN.test(stage.id) || stageIds.has(stage.id)) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid or duplicate stage id`);
		if (!Array.isArray(stage.tasks) || (!options.draft && stage.tasks.length === 0) || stage.tasks.some((id) => typeof id !== "string" || !ID_PATTERN.test(id)) || new Set(stage.tasks).size !== stage.tasks.length) throw new HarnessError("INVALID_ARTIFACT", `${source} stage ${stage.id} has invalid or duplicate task refs`);
		if (!options.draft && (stage.tasks as string[]).some((id) => taskIds.has(id))) throw new HarnessError("INVALID_ARTIFACT", `${source} assigns a task to more than one stage`);
		if (stage.mode !== "sequential" && stage.mode !== "concurrent") throw new HarnessError("INVALID_ARTIFACT", `${source} stage ${stage.id} must declare sequential or concurrent mode`);
		let review: StoryPlanDocument["stages"][number]["review"];
		if (stage.review !== undefined) {
			if (!stage.review || typeof stage.review !== "object" || Array.isArray(stage.review)) throw new HarnessError("INVALID_ARTIFACT", `${source} stage ${stage.id} has an invalid review`);
			const policy = stage.review as Record<string, unknown>;
			exactFields(policy, ["mode", "focus"], `${source} stage ${stage.id} review`);
			if (policy.mode !== "required" && policy.mode !== "skip") throw new HarnessError("INVALID_ARTIFACT", `${source} stage ${stage.id} has an invalid review mode`);
			if (policy.focus !== undefined && (typeof policy.focus !== "string" || !policy.focus.trim())) throw new HarnessError("INVALID_ARTIFACT", `${source} stage ${stage.id} has an invalid review focus`);
			review = { mode: policy.mode, ...(typeof policy.focus === "string" ? { focus: policy.focus } : {}) };
		}
		stageIds.add(stage.id);
		(stage.tasks as string[]).forEach((id) => taskIds.add(id));
		return { id: stage.id, tasks: stage.tasks as string[], mode: stage.mode as "sequential" | "concurrent", checks: normalizeVerificationChecks(stage.checks, `${source} stage ${stage.id} checks`), ...(review ? { review } : {}) };
	});
	return { schemaVersion: 1, stages };
}

export async function validateEvidenceSource(repositoryRoot: string, source: string): Promise<string> {
	let lexical = resolve(repositoryRoot, source);
	let absolute = await realpath(lexical).catch(() => undefined);
	if (!absolute) {
		const withoutRanges = source.replace(/:(?:L?\d+(?:-L?\d+)?)(?:,(?:L?\d+(?:-L?\d+)?))*$/, "");
		if (withoutRanges !== source) { lexical = resolve(repositoryRoot, withoutRanges); absolute = await realpath(lexical).catch(() => undefined); }
	}
	if (!absolute) throw new HarnessError("INVALID_ARTIFACT", `Evidence file does not exist: ${source}`);
	const allowedRoots = await Promise.all([repositoryRoot, tmpdir(), "/tmp"].map((root) => realpath(root).catch(() => resolve(root))));
	if (!allowedRoots.some((root) => absolute !== root && absolute.startsWith(`${root}${sep}`))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source resolves outside the repository or operating-system temporary directory: ${source}`);
	if (SENSITIVE_EVIDENCE_NAME.test(basename(absolute)) || SENSITIVE_EVIDENCE_NAME.test(basename(lexical))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source looks sensitive: ${source}. Provide a sanitized minimal artifact instead.`);
	if (!(await stat(absolute)).isFile()) throw new HarnessError("INVALID_ARTIFACT", `Evidence path is not a regular file: ${source}`);
	const content = await readFile(absolute);
	if (SENSITIVE_EVIDENCE_CONTENT.test(content.subarray(0, 128 * 1024).toString("utf8"))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source contains an obvious credential or private material: ${source}`);
	return absolute;
}

export class WorkItemStore {
	readonly repositoryRoot: string;
	readonly artifactRoot: string;
	readonly coordinator: CanonicalMutationCoordinator;

	constructor(repositoryRoot: string, coordinator?: CanonicalMutationCoordinator) {
		this.repositoryRoot = resolve(repositoryRoot);
		this.artifactRoot = join(this.repositoryRoot, "agent-artifacts");
		const commonDir = discoverCommonDirSync(this.repositoryRoot);
		this.coordinator = coordinator ?? new CanonicalMutationCoordinator(this.repositoryRoot, commonDir ?? this.repositoryRoot);
	}

	workItemRoot(id: string): string {
		validateId(id, "Work-item id");
		const path = join(this.artifactRoot, id);
		ensureInside(this.artifactRoot, path);
		return path;
	}

	private async assertAuthoredResourcesMutable(id: string): Promise<void> {
		if (await pathExists(join(this.workItemRoot(id), "state.yaml"))) throw new HarnessError("CAPABILITY_DENIED", `Authored story, plan, and task contracts for ${id} are immutable once authoritative runtime state exists; a future explicit replan must replace state`);
	}

	async readStory(id: string): Promise<StoryDocument> {
		const path = join(this.workItemRoot(id), "story.yaml");
		if (!(await pathExists(path))) await this.refuseLegacy(id);
		return parseStoryDocument(await readFile(path, "utf8"), path);
	}

	async readStoryPlan(id: string, options: { draft?: boolean } = {}): Promise<StoryPlanDocument> {
		const path = join(this.workItemRoot(id), "plan.yaml");
		if (!(await pathExists(path))) throw new HarnessError("INVALID_ARTIFACT", `Story ${id} has not crossed the separate plan authoring boundary`);
		return parseStoryPlanDocument(await readFile(path, "utf8"), path, options);
	}

	async readAuthoredTask(storyId: string, taskId: string): Promise<AuthoredTaskDocument> {
		validateId(taskId, "Task id");
		const path = join(this.workItemRoot(storyId), "tasks", `${taskId}.yaml`);
		if (!(await pathExists(path))) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		return parseAuthoredTaskDocument(await readFile(path, "utf8"), path);
	}

	async listAuthoredTasks(storyId: string): Promise<AuthoredTaskDocument[]> {
		const entries = await readdir(join(this.workItemRoot(storyId), "tasks"), { withFileTypes: true }).catch(() => []);
		if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".yaml"))) throw new HarnessError("INVALID_ARTIFACT", `Target story ${storyId} tasks directory contains unsupported entries`);
		return Promise.all(entries.map((entry) => entry.name.slice(0, -5)).sort().map((id) => this.readAuthoredTask(storyId, id)));
	}

	async legacySummary(id: string): Promise<LegacyWorkItemSummary | undefined> {
		const path = join(this.workItemRoot(id), "index.yaml");
		if (!(await pathExists(path))) return undefined;
		const value = mapping(await readFile(path, "utf8"), path);
		if (typeof value.id !== "string" || typeof value.title !== "string") return undefined;
		const phase = String(value.phase ?? "unknown");
		const state = String(value.state ?? "unknown");
		return { id: value.id, title: value.title, phase, state, active: phase !== "complete" && state !== "complete" && state !== "archived" };
	}

	async refuseLegacy(id: string): Promise<never> {
		const legacy = await this.legacySummary(id);
		if (legacy) throw new HarnessError("CAPABILITY_DENIED", legacy.active
			? `Legacy workflow ${id} is active and cannot be migrated or executed by the target runtime. Finish or archive it with the historical PiBox version, then author a new target story.`
			: `Legacy workflow ${id} is immutable historical data and is not an authorable or executable target story.`, { legacy });
		throw new HarnessError("WORK_ITEM_NOT_FOUND", `Target story does not exist: ${id}`);
	}

	private projection(story: StoryDocument, plan?: StoryPlanDocument, delivery?: WorkItemDelivery): TargetWorkItem {
		return { id: story.id, title: story.title, kind: story.kind, phase: "planning", state: "active", planning: { revision: 1 }, tasks: [...new Set((plan?.stages ?? []).flatMap((stage) => stage.tasks))].map((id) => ({ id, path: `tasks/${id}.yaml` })), stages: plan?.stages ?? [], ...(delivery ? { delivery } : {}) };
	}

	private async currentBranch(): Promise<string> { return runGit(this.repositoryRoot, ["branch", "--show-current"]); }

	private async targetDelivery(id: string): Promise<WorkItemDelivery | undefined> {
		const storyPath = relative(this.repositoryRoot, join(this.workItemRoot(id), "story.yaml")).replaceAll("\\", "/");
		const branches = (await runGit(this.repositoryRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature", "refs/heads/fix"])).split("\n").filter(Boolean);
		const candidates: string[] = [];
		for (const branch of branches) {
			const content = await runGit(this.repositoryRoot, ["show", `${branch}:${storyPath}`]).catch(() => undefined);
			if (!content) continue;
			try { if (parseStoryDocument(content, `${branch}:${storyPath}`).id === id) candidates.push(branch); } catch { /* unrelated malformed history */ }
		}
		const conventional = candidates.filter((branch) => branch === `feature/${id}` || branch === `fix/${id}`);
		const selected = conventional.length === 1 ? conventional[0] : candidates.length === 1 ? candidates[0] : undefined;
		if (!selected) {
			if (candidates.length) throw new HarnessError("INVALID_ARTIFACT", `Target story ${id} is present on multiple feature/fix branches`, { branches: candidates });
			return undefined;
		}
		const introduction = (await runGit(this.repositoryRoot, ["log", "--diff-filter=A", "--format=%H", selected, "--", storyPath])).split("\n").filter(Boolean).at(-1);
		if (!introduction) throw new HarnessError("INVALID_ARTIFACT", `Cannot derive the creation anchor for target story ${id}`);
		return { workingBranch: selected, createdFromCommit: await runGit(this.repositoryRoot, ["rev-parse", `${introduction}^`]).catch(() => introduction) };
	}

	async findDelivery(id: string): Promise<WorkItemDelivery | undefined> { return this.targetDelivery(id); }

	private async prepareWorkingBranch(id: string, requested?: string, kind?: WorkingBranchKind): Promise<{ delivery: WorkItemDelivery; created: boolean }> {
		await assertCleanRepository(this.repositoryRoot);
		const current = await this.currentBranch();
		const requestedKind = requested?.match(/^(feature|fix)\//)?.[1] as WorkingBranchKind | undefined;
		const currentKind = current.match(/^(feature|fix)\//)?.[1] as WorkingBranchKind | undefined;
		const branchKind = kind ?? requestedKind ?? currentKind ?? "feature";
		if (current !== "develop") {
			if (!currentKind || PROTECTED_BRANCHES.has(current)) throw new HarnessError("CAPABILITY_DENIED", `New story ${id} requires clean develop or a checked-out feature/fix branch; current branch is ${current || "detached HEAD"}`);
			const workingBranch = requested ?? current;
			if (workingBranch !== current || branchKind !== currentKind) throw new HarnessError("CAPABILITY_DENIED", `New story ${id} can only continue the checked-out branch ${current}`);
			return { delivery: { workingBranch, createdFromCommit: await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]) }, created: false };
		}
		const workingBranch = requested ?? `${branchKind}/${id}`;
		if (!WORKING_BRANCH_PATTERN.test(workingBranch) || !workingBranch.startsWith(`${branchKind}/`)) throw new HarnessError("INVALID_ARTIFACT", `workingBranch must match ${branchKind}/<kebab-case-name>`);
		if (await runGit(this.repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workingBranch}`]).then(() => true, () => false)) throw new HarnessError("GIT_OPERATION_FAILED", `Working branch already exists: ${workingBranch}`);
		if (await runGit(this.repositoryRoot, ["remote", "get-url", "origin"]).then(() => true, () => false)) await runGit(this.repositoryRoot, ["pull", "--ff-only", "origin", "develop"]);
		const createdFromCommit = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		await runGit(this.repositoryRoot, ["switch", "-c", workingBranch]);
		return { delivery: { workingBranch, createdFromCommit }, created: true };
	}

	private async commit(paths: string[], message: string): Promise<void> { await this.coordinator.commitHarness(paths, message); }

	private async restoreOwnedPaths(paths: string[]): Promise<void> {
		const owned = paths.map((path) => relative(this.repositoryRoot, path));
		await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", ...owned]);
		for (const [index, path] of paths.entries()) {
			const repositoryPath = owned[index]!;
			const tracked = await runGit(this.repositoryRoot, ["cat-file", "-e", `HEAD:${repositoryPath}`]).then(() => true, () => false);
			if (tracked) await runGit(this.repositoryRoot, ["restore", "--source=HEAD", "--worktree", "--", repositoryPath]);
			else await rm(path, { recursive: true, force: true });
		}
	}

	async writeStoryDocument(input: { story: StoryDocument; workingBranch?: string; branchKind?: WorkingBranchKind }): Promise<TargetWorkItem> {
		return this.coordinator.run(`story-write:${input.story.id}`, async () => {
			const story = parseStoryDocument(stringify(input.story));
			await assertCleanRepository(this.repositoryRoot);
			const root = this.workItemRoot(story.id);
			if (await pathExists(root)) throw new HarnessError("WORK_ITEM_EXISTS", `Work item already exists: ${story.id}`);
			const originalBranch = await this.currentBranch();
			const prepared = await this.prepareWorkingBranch(story.id, input.workingBranch, input.branchKind);
			await mkdir(root, { recursive: true });
			try {
				await atomicWriteFile(join(root, "story.yaml"), stringify(story));
				await this.commit([root], `harness(${story.id}): write story`);
				return this.projection(story, undefined, prepared.delivery);
			} catch (error) {
				await this.restoreOwnedPaths([root]);
				if (prepared.created && await this.currentBranch() === prepared.delivery.workingBranch) { await runGit(this.repositoryRoot, ["switch", originalBranch]); await runGit(this.repositoryRoot, ["branch", "-D", prepared.delivery.workingBranch]); }
				throw error;
			}
		});
	}

	async reviseStoryDocument(storyValue: StoryDocument): Promise<TargetWorkItem> {
		return this.coordinator.run(`story-revise:${storyValue.id}`, async () => {
			const story = parseStoryDocument(stringify(storyValue));
			await this.assertAuthoredResourcesMutable(story.id);
			await assertCleanRepository(this.repositoryRoot);
			const delivery = await this.targetDelivery(story.id);
			if (!delivery || await this.currentBranch() !== delivery.workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Target story ${story.id} must be revised on its bound feature/fix branch`);
			const root = this.workItemRoot(story.id);
			if (!(await pathExists(join(root, "story.yaml")))) await this.refuseLegacy(story.id);
			const storyPath = join(root, "story.yaml");
			try {
				await atomicWriteFile(storyPath, stringify(story));
				await this.commit([storyPath], `harness(${story.id}): revise story`);
				return this.projection(story, undefined, delivery);
			} catch (error) {
				await this.restoreOwnedPaths([storyPath]);
				throw error;
			}
		});
	}

	async writeAuthoredPlan(input: { story: StoryDocument; plan: StoryPlanDocument; tasks: AuthoredTaskDocument[]; replace?: boolean; draft?: boolean }): Promise<TargetWorkItem> {
		return this.coordinator.run(`authored-plan:${input.story.id}`, async () => {
			const story = parseStoryDocument(stringify(input.story));
			await this.assertAuthoredResourcesMutable(story.id);
			const plan = parseStoryPlanDocument(stringify(input.plan), "plan.yaml", input.draft ? { draft: true } : {});
			const tasks = input.tasks.map((task) => parseAuthoredTaskDocument(stringify(task), `tasks/${task.id}.yaml`));
			const known = new Set(tasks.map((task) => task.id));
			if (known.size !== tasks.length) throw new HarnessError("INVALID_ARTIFACT", "Plan has duplicate task ids");
			const planned = plan.stages.flatMap((stage) => stage.tasks);
			if (!input.draft && (planned.length !== known.size || planned.some((id) => !known.has(id)))) throw new HarnessError("INVALID_ARTIFACT", "Plan stages must reference every authored task exactly once");
			if (!input.draft) for (const task of tasks) for (const dependency of task.dependsOn) if (!known.has(dependency)) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} depends on unknown task ${dependency}`);
			await assertCleanRepository(this.repositoryRoot);
			const root = this.workItemRoot(story.id);
			const reviewed = await this.readStory(story.id);
			if (stringify(reviewed) !== stringify(story)) throw new HarnessError("CAPABILITY_DENIED", "Plan authoring cannot rewrite the separately reviewed story boundary");
			const planPath = join(root, "plan.yaml");
			const tasksRoot = join(root, "tasks");
			const exists = await pathExists(planPath);
			if (exists !== Boolean(input.replace)) throw new HarnessError(exists ? "WORK_ITEM_EXISTS" : "WORK_ITEM_NOT_FOUND", exists ? `Plan already exists for story ${story.id}` : `Plan does not exist for story ${story.id}`);
			const delivery = await this.targetDelivery(story.id);
			if (!delivery || await this.currentBranch() !== delivery.workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Target plan ${story.id} must be written on its bound feature/fix branch`);
			const temporary = join(this.artifactRoot, `.${story.id}.authored-${randomUUID()}`);
			const backup = join(this.artifactRoot, `.${story.id}.backup-${randomUUID()}`);
			await mkdir(join(temporary, "tasks"), { recursive: true });
			await writeFile(join(temporary, "plan.yaml"), stringify(plan));
			for (const task of tasks) await writeFile(join(temporary, "tasks", `${task.id}.yaml`), stringify(task));
			try {
				if (exists) { await mkdir(backup, { recursive: true }); await rename(planPath, join(backup, "plan.yaml")); await rename(tasksRoot, join(backup, "tasks")); }
				await rename(join(temporary, "plan.yaml"), planPath); await rename(join(temporary, "tasks"), tasksRoot);
				await this.commit([planPath, tasksRoot], `harness(${story.id}): ${exists ? "replace" : "write"} authored plan`);
				return this.projection(story, plan, delivery);
			} catch (error) {
				await this.restoreOwnedPaths([planPath, tasksRoot]);
				throw error;
			} finally { await rm(temporary, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true }); }
		});
	}

	async list(): Promise<TargetWorkItem[]> {
		if (!(await pathExists(this.artifactRoot))) return [];
		const items: TargetWorkItem[] = [];
		for (const entry of (await readdir(this.artifactRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
			const storyPath = join(this.artifactRoot, entry.name, "story.yaml");
			if (!(await pathExists(storyPath))) continue;
			const story = parseStoryDocument(await readFile(storyPath, "utf8"), storyPath);
			const planPath = join(this.artifactRoot, entry.name, "plan.yaml");
			items.push(this.projection(story, await pathExists(planPath) ? parseStoryPlanDocument(await readFile(planPath, "utf8"), planPath, { draft: true }) : undefined, await this.targetDelivery(story.id)));
		}
		return items;
	}

	async listForCurrentBranch(): Promise<TargetWorkItem[]> {
		const current = await this.currentBranch();
		return (await this.list()).filter((item) => item.delivery?.workingBranch === current);
	}

	async read(id: string): Promise<TargetWorkItem> {
		const story = await this.readStory(id);
		const planPath = join(this.workItemRoot(id), "plan.yaml");
		const delivery = await this.targetDelivery(id);
		if (delivery && await this.currentBranch() !== delivery.workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Work item ${id} is bound to ${delivery.workingBranch}; current branch is ${await this.currentBranch() || "detached HEAD"}`);
		return this.projection(story, await pathExists(planPath) ? await this.readStoryPlan(id, { draft: true }) : undefined, delivery);
	}

	private async validateTargetPlan(id: string): Promise<{ story: StoryDocument; plan: StoryPlanDocument; tasks: AuthoredTaskDocument[]; delivery: WorkItemDelivery }> {
		const story = await this.readStory(id);
		const plan = await this.readStoryPlan(id);
		const delivery = await this.targetDelivery(id);
		if (!delivery || await this.currentBranch() !== delivery.workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Target story ${id} is not on its bound feature/fix branch`);
		const entries = await readdir(join(this.workItemRoot(id), "tasks"), { withFileTypes: true }).catch(() => []);
		if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".yaml"))) throw new HarnessError("INVALID_ARTIFACT", `Target story ${id} tasks directory contains unsupported entries`);
		const authoredIds = entries.map((entry) => entry.name.slice(0, -5)).sort();
		const tasks = await Promise.all(authoredIds.map((taskId) => this.readAuthoredTask(id, taskId)));
		const plannedIds = plan.stages.flatMap((stage) => stage.tasks);
		if (plannedIds.length !== authoredIds.length || plannedIds.some((taskId) => !authoredIds.includes(taskId))) throw new HarnessError("INVALID_ARTIFACT", `Target plan ${id} must reference every authored task exactly once`);
		const positions = new Map<string, { stage: number; task: number; mode: "sequential" | "concurrent" }>();
		plan.stages.forEach((stage, stageIndex) => stage.tasks.forEach((taskId, taskIndex) => positions.set(taskId, { stage: stageIndex, task: taskIndex, mode: stage.mode })));
		for (const task of tasks) for (const dependency of task.dependsOn) {
			const own = positions.get(task.id)!; const required = positions.get(dependency);
			if (!required) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} depends on unknown task ${dependency}`);
			if (!(required.stage < own.stage || (required.stage === own.stage && own.mode === "sequential" && required.task < own.task))) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} dependency ${dependency} must run earlier; concurrent peers and forward task refs cannot block it`);
		}
		return { story, plan, tasks, delivery };
	}

	async submitPlanning(id: string): Promise<TargetWorkItem> {
		return this.coordinator.run(`story-submit:${id}`, async () => {
			await assertCleanRepository(this.repositoryRoot);
			const target = await this.validateTargetPlan(id);
			return this.projection(target.story, target.plan, target.delivery);
		});
	}

	async beginExecution(id: string): Promise<TargetWorkItem> {
		return this.coordinator.run(`story-begin:${id}`, async () => {
			await assertCleanRepository(this.repositoryRoot);
			const target = await this.validateTargetPlan(id);
			return { ...this.projection(target.story, target.plan, { ...target.delivery, executionStartCommit: await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]) }), phase: "execution" };
		});
	}
}
