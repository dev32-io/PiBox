import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, runGit } from "./repository.js";
import { activeModelTierLists } from "../model-tier-list-profiles/profiles.js";
import type { AuthoredExecutionStage, AuthoredTaskDocument, HarnessConfig, MutationAuthority, StoryDocument } from "./types.js";
import { parseAuthoredTaskDocument, parseStoryPlanDocument, WorkItemStore } from "./work-items.js";
import { CanonicalMutationCoordinator } from "./canonical-mutation.js";
import { compiledStoryIssues, parseDesign, parseE2e, parseSpec, renderDesign, renderE2e, renderSpec, validateE2eId, type AuthoredE2eCase, type AuthoredE2eDocument } from "./authored-markdown.js";

export type CanonicalResourceType = "work-item" | "task" | "stage" | "e2e";

export interface ParsedResourceRef {
	type: CanonicalResourceType;
	workItemId: string;
	id: string;
}

export interface StoryWriteInput {
	ref?: string; id?: string; title?: string; kind?: StoryDocument["kind"];
	outcome?: string; scope?: string; behavior?: string; acceptance?: string;
	approach?: string; boundariesAndFlow?: string; failureAndVerification?: string;
	e2eScope?: string; e2eExclusions?: string;
	workingBranch?: string; branchKind?: "feature" | "fix";
}

export interface TaskWriteInput {
	ref?: string; story?: string; id?: string; title?: string; dependsOn?: string[];
	description?: string; scope?: string; delivery?: string; checks?: unknown[];
	agent?: string; tier?: AuthoredTaskDocument["assignment"]["tier"]; rationale?: string; tierJustification?: string;
}

export interface StageWriteInput {
	ref?: string; story?: string; id?: string; mode?: AuthoredExecutionStage["mode"];
	tasks?: string[]; checks?: unknown[]; reviewMode?: "required" | "skip" | "none"; reviewFocus?: string;
}

export interface E2eWriteInput {
	ref?: string; story?: string; id?: string; title?: string; exercise?: string; oracle?: string; proof?: string;
}

const REF = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(task|stage):([a-z0-9]+(?:-[a-z0-9]+)*)|\/e2e:(E2E-\d{3}))?$/;

export function parseResourceRef(ref: string): ParsedResourceRef {
	const match = REF.exec(ref);
	if (!match) throw new HarnessError("INVALID_ARTIFACT", `Invalid target resource reference: ${ref}`);
	return { type: (match[2] ?? (match[4] ? "e2e" : "work-item")) as CanonicalResourceType, workItemId: match[1]!, id: match[3] ?? match[4] ?? match[1]! };
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new HarnessError("INVALID_ARTIFACT", `${label} is required`);
	return value;
}

function requiredSingleLine(value: unknown, label: string): string {
	const result = requiredString(value, label);
	if (/\r|\n/.test(result)) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a single line`);
	return result;
}

function requireChanged(input: Record<string, unknown>, addressing: string[]): void {
	if (!Object.keys(input).some((key) => !addressing.includes(key) && input[key] !== undefined)) throw new HarnessError("INVALID_ARTIFACT", "Write must provide at least one changed field");
}

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

function workItemId(ref: string, label: string): string {
	const parsed = parseResourceRef(ref);
	if (parsed.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", `${label} must be a work-item ref`);
	return parsed.id;
}

function rejectConflictingIdentity(provided: string | undefined, addressed: string, label: string): void {
	if (provided !== undefined && provided !== addressed) throw new HarnessError("INVALID_ARTIFACT", `${label} id ${provided} conflicts with ref id ${addressed}`);
}

function rejectConflictingParent(provided: string | undefined, addressed: string, label: string): void {
	if (provided !== undefined && workItemId(provided, `${label} story`) !== addressed) throw new HarnessError("INVALID_ARTIFACT", `${label} story ${provided} conflicts with ref parent work-item:${addressed}`);
}

function parseStoredGroup<T>(label: string, requiredFields: string, parse: () => T): T {
	try { return parse(); }
	catch (error) {
		if (!(error instanceof HarnessError) || error.code !== "INVALID_ARTIFACT") throw error;
		throw new HarnessError("INVALID_ARTIFACT", `Stored story ${label} is invalid; resend ${requiredFields} together to replace that complete field group. ${error.message}`);
	}
}

export function compiledConfigurationIssues(config: HarnessConfig | undefined, tasks: AuthoredTaskDocument[], stages: AuthoredExecutionStage[]): string[] {
	if (!config) return [];
	const issues: string[] = [];
	const tiers = activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers;
	for (const task of tasks) {
		if (!config.agents[task.assignment.agent]) issues.push(`Task ${task.id}: Unknown task agent: ${task.assignment.agent}`);
		if (!tiers[task.assignment.tier]?.length) issues.push(`Task ${task.id}: Task tier has no configured routes: ${task.assignment.tier}`);
	}
	for (const entry of [
		...tasks.map((task) => ({ label: `Task ${task.id}`, checks: task.checks })),
		...stages.map((stage) => ({ label: `Stage ${stage.id}`, checks: stage.checks })),
	]) for (const [index, check] of entry.checks.entries()) {
		const id = typeof check === "string" ? `check-${index + 1}` : check.id ?? `check-${index + 1}`;
		const selected = typeof check === "string" ? undefined : check.profile;
		const policy: HarnessConfig["verification"] = config.verification;
		if (!policy) {
			if (selected) issues.push(`${entry.label} check ${id} selects profile ${selected}, but .pi/harness.yaml has no verification section`);
			continue;
		}
		const profile = selected ?? policy.defaultProfile;
		if (!profile) issues.push(`${entry.label} check ${id} requires a profile because verification.defaultProfile is not configured`);
		else if (!policy.profiles[profile]) issues.push(`${entry.label} check ${id} selects unknown profile: ${profile}`);
	}
	return issues;
}

async function mutationBase(repositoryRoot: string, originalBase: string, startingBranch: string, startingBranches: Set<string>): Promise<string> {
	const currentBranch = await runGit(repositoryRoot, ["branch", "--show-current"]);
	if (startingBranch !== "develop" || !/^(?:feature|fix)\//.test(currentBranch) || startingBranches.has(currentBranch)) return originalBase;
	const developHead = await runGit(repositoryRoot, ["rev-parse", "develop"]);
	if (developHead === originalBase) return originalBase;
	const advanced = await runGit(repositoryRoot, ["merge-base", "--is-ancestor", originalBase, developHead]).then(() => true, () => false);
	const branchedFromDevelop = await runGit(repositoryRoot, ["merge-base", "--is-ancestor", developHead, "HEAD"]).then(() => true, () => false);
	return advanced && branchedFromDevelop ? developHead : originalBase;
}

export class OrchestratorResourceService {
	readonly coordinator: CanonicalMutationCoordinator;
	constructor(readonly repositoryRoot: string, readonly store = new WorkItemStore(repositoryRoot), readonly config?: HarnessConfig, coordinator?: CanonicalMutationCoordinator) {
		this.coordinator = coordinator ?? store.coordinator;
	}

	private validateAssignment(task: AuthoredTaskDocument): void {
		if (!this.config) return;
		if (!this.config.agents[task.assignment.agent]) throw new HarnessError("CONFIG_INVALID", `Unknown task agent: ${task.assignment.agent}`);
		if (!activeModelTierLists(this.config.modelTierListProfiles, this.config.modelTierProfile).tiers[task.assignment.tier]?.length) throw new HarnessError("CONFIG_INVALID", `Task tier has no configured routes: ${task.assignment.tier}`);
	}

	async transaction<T>(label: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<{ value: T; commit?: string }> {
		return this.coordinator.run(`resource:${label}`, async () => {
			const base = await runGit(this.repositoryRoot, ["rev-parse", "--verify", "HEAD"]).catch((error) => {
				if (error instanceof HarnessError && error.code === "GIT_OPERATION_FAILED") throw new HarnessError("GIT_OPERATION_FAILED", "Workflow authoring requires a repository with at least one commit and a checked-out develop or feature/fix branch; ask the user to initialize the repository before writing resources");
				throw error;
			});
			await assertCleanRepository(this.repositoryRoot);
			const startingBranch = await runGit(this.repositoryRoot, ["branch", "--show-current"]);
			const startingBranches = new Set((await runGit(this.repositoryRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean));
			let squash: { paths: string[]; branch: string; base: string } | undefined;
			try {
				const value = await operation();
				const effectiveBase = await mutationBase(this.repositoryRoot, base, startingBranch, startingBranches);
				const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
				if (head === effectiveBase) return { value };
				const subjects = (await runGit(this.repositoryRoot, ["log", "--format=%s", `${effectiveBase}..HEAD`])).split("\n").filter(Boolean);
				const paths = (await runGit(this.repositoryRoot, ["diff", "--name-only", `${effectiveBase}..HEAD`])).split("\n").filter(Boolean);
				if (subjects.some((subject) => !subject.startsWith("harness(")) || paths.some((path) => !path.startsWith("agent-artifacts/"))) throw new HarnessError("GIT_OPERATION_FAILED", "Resource transaction observed non-harness commits; external work was preserved");
				squash = { paths, branch: await runGit(this.repositoryRoot, ["branch", "--show-current"]), base: effectiveBase };
				await runGit(this.repositoryRoot, ["reset", "--soft", effectiveBase]);
				await this.coordinator.commitHarness(paths.map((path) => join(this.repositoryRoot, path)), label.startsWith("harness(") ? label : `harness(resource-api): ${label.replace(/^harness:\s*/, "")}`);
				return { value, commit: await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]) };
			} catch (error) {
				if (squash) {
					await runGit(this.repositoryRoot, ["restore", `--source=${squash.base}`, "--staged", "--worktree", "--", ...squash.paths]);
					for (const path of squash.paths) if (!await runGit(this.repositoryRoot, ["cat-file", "-e", `${squash.base}:${path}`]).then(() => true, () => false)) await rm(join(this.repositoryRoot, path), { recursive: true, force: true });
					if (squash.branch && squash.branch !== startingBranch) {
						if (startingBranch) await runGit(this.repositoryRoot, ["switch", startingBranch]);
						else await runGit(this.repositoryRoot, ["switch", "--detach", base]);
						if (!startingBranches.has(squash.branch)) await runGit(this.repositoryRoot, ["branch", "-D", squash.branch]);
					}
					throw error;
				}
				const effectiveBase = await mutationBase(this.repositoryRoot, base, startingBranch, startingBranches);
				const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
				if (head !== effectiveBase) {
					const subjects = (await runGit(this.repositoryRoot, ["log", "--format=%s", `${effectiveBase}..HEAD`])).split("\n").filter(Boolean);
					const paths = (await runGit(this.repositoryRoot, ["diff", "--name-only", `${effectiveBase}..HEAD`])).split("\n").filter(Boolean);
					if (subjects.every((subject) => subject.startsWith("harness(")) && paths.every((path) => path.startsWith("agent-artifacts/"))) {
						const rollbackBranch = await runGit(this.repositoryRoot, ["branch", "--show-current"]);
						await runGit(this.repositoryRoot, ["reset", "--soft", effectiveBase]);
						if (paths.length) await runGit(this.repositoryRoot, ["restore", `--source=${effectiveBase}`, "--staged", "--worktree", "--", ...paths]);
						for (const path of paths) if (!await runGit(this.repositoryRoot, ["cat-file", "-e", `${effectiveBase}:${path}`]).then(() => true, () => false)) await rm(join(this.repositoryRoot, path), { recursive: true, force: true });
						if (rollbackBranch && rollbackBranch !== startingBranch) {
							if (startingBranch) await runGit(this.repositoryRoot, ["switch", startingBranch]);
							else await runGit(this.repositoryRoot, ["switch", "--detach", effectiveBase]);
							if (!startingBranches.has(rollbackBranch)) await runGit(this.repositoryRoot, ["branch", "-D", rollbackBranch]);
						}
					}
				}
				throw error;
			}
		}, signal);
	}

	async listSummaries(type?: CanonicalResourceType, workItemId?: string): Promise<Array<Record<string, unknown>>> {
		const items = workItemId ? [await this.store.read(workItemId)] : await this.store.list();
		const results: Array<Record<string, unknown>> = [];
		for (const item of items) {
			if (!type || type === "work-item") results.push({ ref: `work-item:${item.id}`, id: item.id, title: item.title, kind: item.kind, planAuthored: item.stages.length > 0, counts: { tasks: item.tasks.length, stages: item.stages.length } });
			if (!type || type === "task") for (const task of await this.store.listAuthoredTasks(item.id)) results.push({ ref: `work-item:${item.id}/task:${task.id}`, id: task.id, title: task.title, stageId: item.stages.find((stage) => stage.tasks.includes(task.id))?.id, dependsOn: task.dependsOn, assignment: task.assignment });
			if (!type || type === "stage") for (const stage of item.stages) results.push({ ref: `work-item:${item.id}/stage:${stage.id}`, id: stage.id, mode: stage.mode, tasks: stage.tasks, checks: stage.checks, ...(stage.review ? { review: stage.review } : {}) });
			if (!type || type === "e2e") {
				const cases = await this.store.readStory(item.id).then((story) => parseE2e(story.e2e).cases).catch((error) => error instanceof HarnessError && error.code === "INVALID_ARTIFACT" ? [] : Promise.reject(error));
				for (const entry of cases) results.push({ ref: `work-item:${item.id}/e2e:${entry.id}`, id: entry.id, title: entry.title });
			}
		}
		return results;
	}

	async get(ref: string): Promise<{ ref: string; resource: StoryDocument | AuthoredTaskDocument | AuthoredExecutionStage | AuthoredE2eCase }> {
		const parsed = parseResourceRef(ref);
		if (parsed.type === "work-item") return { ref, resource: await this.store.readStory(parsed.id) };
		if (parsed.type === "task") return { ref, resource: await this.store.readAuthoredTask(parsed.workItemId, parsed.id) };
		if (parsed.type === "e2e") {
			const entry = parseE2e((await this.store.readStory(parsed.workItemId)).e2e).cases.find((candidate) => candidate.id === parsed.id);
			if (!entry) throw new HarnessError("INVALID_ARTIFACT", `Unknown E2E case: ${parsed.id}`);
			return { ref, resource: entry };
		}
		const stage = (await this.store.readStoryPlan(parsed.workItemId, { draft: true })).stages.find((candidate) => candidate.id === parsed.id);
		if (!stage) throw new HarnessError("INVALID_ARTIFACT", `Unknown stage: ${parsed.id}`);
		return { ref, resource: stage };
	}

	private async draft(storyId: string): Promise<{ story: StoryDocument; plan: { schemaVersion: 1; stages: AuthoredExecutionStage[] }; tasks: AuthoredTaskDocument[]; replace: boolean }> {
		const story = await this.store.readStory(storyId);
		const plan = await this.store.readStoryPlan(storyId, { draft: true }).catch((error) => error instanceof HarnessError && /has not crossed/.test(error.message) ? { schemaVersion: 1 as const, stages: [] } : Promise.reject(error));
		return { story, plan, tasks: await this.store.listAuthoredTasks(storyId), replace: plan.stages.length > 0 || await import("node:fs/promises").then(({ access }) => access(join(this.store.workItemRoot(storyId), "plan.yaml")).then(() => true, () => false)) };
	}

	async writeStory(input: StoryWriteInput): Promise<unknown> {
		const patch = input as Record<string, unknown>;
		if (input.ref) {
			const parsed = parseResourceRef(input.ref);
			if (parsed.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "story_write ref must identify a work item");
			rejectConflictingIdentity(input.id, parsed.id, "Story");
			if (input.workingBranch !== undefined || input.branchKind !== undefined) throw new HarnessError("INVALID_ARTIFACT", "workingBranch and branchKind are creation-only story fields");
			requireChanged(patch, ["ref", "id"]);
			const current = await this.store.readStory(parsed.id);
			const completeSpec = input.outcome !== undefined && input.scope !== undefined && input.behavior !== undefined && input.acceptance !== undefined;
			const completeDesign = input.approach !== undefined && input.boundariesAndFlow !== undefined && input.failureAndVerification !== undefined;
			const completeMigration = completeSpec && completeDesign && input.e2eScope !== undefined;
			const spec = completeSpec ? undefined : parseStoredGroup("spec", "outcome, scope, behavior, and acceptance", () => parseSpec(current.spec));
			const design = completeDesign ? undefined : parseStoredGroup("design", "approach, boundariesAndFlow, and failureAndVerification", () => parseDesign(current.design));
			const e2e: AuthoredE2eDocument = await Promise.resolve().then(() => parseE2e(current.e2e)).catch((error) => {
				if (completeMigration && error instanceof HarnessError && error.code === "INVALID_ARTIFACT" && !/^##\s+E2E-\d{3}\b/m.test(current.e2e)) return { scope: input.e2eScope!, cases: [] };
				if (completeMigration && error instanceof HarnessError && error.code === "INVALID_ARTIFACT") throw new HarnessError("INVALID_ARTIFACT", `Stored story E2E contains case-like sections that cannot be migrated without data loss; repair the E2E structure before migration. ${error.message}`);
				if (error instanceof HarnessError && error.code === "INVALID_ARTIFACT") throw new HarnessError("INVALID_ARTIFACT", `Stored story E2E is invalid; a complete legacy migration requires all seven story sections and e2eScope. ${error.message}`);
				throw error;
			});
			const next: StoryDocument = {
				...current,
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.kind !== undefined ? { kind: input.kind } : {}),
				spec: renderSpec({ outcome: input.outcome ?? spec!.outcome, scope: input.scope ?? spec!.scope, behavior: input.behavior ?? spec!.behavior, acceptance: input.acceptance ?? spec!.acceptance }),
				design: renderDesign({ approach: input.approach ?? design!.approach, boundariesAndFlow: input.boundariesAndFlow ?? design!.boundariesAndFlow, failureAndVerification: input.failureAndVerification ?? design!.failureAndVerification }),
				e2e: renderE2e({ scope: input.e2eScope ?? e2e.scope, cases: e2e.cases, ...((input.e2eExclusions ?? e2e.exclusions)?.trim() ? { exclusions: input.e2eExclusions ?? e2e.exclusions } : {}) }),
			};
			return this.store.reviseStoryDocument(next);
		}
		const id = requiredString(input.id, "Story id");
		const story: StoryDocument = {
			schemaVersion: 1,
			id,
			title: requiredString(input.title, "Story title"),
			kind: input.kind ?? "story",
			spec: renderSpec({ outcome: requiredString(input.outcome, "Story outcome"), scope: requiredString(input.scope, "Story scope"), behavior: requiredString(input.behavior, "Story behavior"), acceptance: requiredString(input.acceptance, "Story acceptance") }),
			design: renderDesign({ approach: requiredString(input.approach, "Story approach"), boundariesAndFlow: requiredString(input.boundariesAndFlow, "Story boundariesAndFlow"), failureAndVerification: requiredString(input.failureAndVerification, "Story failureAndVerification") }),
			e2e: renderE2e({ scope: requiredString(input.e2eScope, "Story e2eScope"), cases: [], ...(input.e2eExclusions?.trim() ? { exclusions: input.e2eExclusions } : {}) }),
		};
		return this.store.writeStoryDocument({ story, ...(input.workingBranch ? { workingBranch: input.workingBranch } : {}), ...(input.branchKind ? { branchKind: input.branchKind } : {}) });
	}

	async writeE2e(input: E2eWriteInput): Promise<unknown> {
		let storyId: string;
		let id: string;
		let updating = false;
		if (input.ref) {
			const parsed = parseResourceRef(input.ref);
			if (parsed.type !== "e2e") throw new HarnessError("INVALID_ARTIFACT", "e2e_write ref must identify an E2E case");
			rejectConflictingIdentity(input.id, parsed.id, "E2E case");
			rejectConflictingParent(input.story, parsed.workItemId, "E2E case");
			storyId = parsed.workItemId; id = parsed.id; updating = true;
			requireChanged(input as Record<string, unknown>, ["ref", "story", "id"]);
		} else {
			storyId = workItemId(requiredString(input.story, "E2E story ref"), "E2E story");
			id = requiredString(input.id, "E2E case id");
		}
		validateE2eId(id);
		const story = await this.store.readStory(storyId);
		const e2e = await Promise.resolve().then(() => parseE2e(story.e2e)).catch((error) => {
			if (error instanceof HarnessError && error.code === "INVALID_ARTIFACT") throw new HarnessError("INVALID_ARTIFACT", `Stored story E2E is invalid; migrate it with a complete story_write before authoring cases. ${error.message}`);
			throw error;
		});
		const index = e2e.cases.findIndex((entry) => entry.id === id);
		if (updating && index < 0) throw new HarnessError("INVALID_ARTIFACT", `Unknown E2E case: ${id}`);
		if (!updating && index >= 0) throw new HarnessError("WORK_ITEM_EXISTS", `E2E case already exists: ${id}`);
		const current = index >= 0 ? e2e.cases[index]! : undefined;
		const entry: AuthoredE2eCase = {
			id,
			title: requiredSingleLine(input.title ?? current?.title, "E2E title"),
			exercise: input.exercise ?? requiredString(current?.exercise, "E2E exercise"),
			oracle: input.oracle ?? requiredString(current?.oracle, "E2E oracle"),
			proof: input.proof ?? requiredString(current?.proof, "E2E proof"),
		};
		if (index >= 0) e2e.cases[index] = entry; else e2e.cases.push(entry);
		return this.store.reviseStoryDocument({ ...story, e2e: renderE2e(e2e) });
	}

	async writeTask(input: TaskWriteInput): Promise<unknown> {
		let storyId: string;
		let current: AuthoredTaskDocument | undefined;
		if (input.ref) {
			const parsed = parseResourceRef(input.ref);
			if (parsed.type !== "task") throw new HarnessError("INVALID_ARTIFACT", "task_write ref must identify a task");
			rejectConflictingIdentity(input.id, parsed.id, "Task");
			rejectConflictingParent(input.story, parsed.workItemId, "Task");
			storyId = parsed.workItemId;
			current = await this.store.readAuthoredTask(storyId, parsed.id);
			requireChanged(input as Record<string, unknown>, ["ref", "story", "id"]);
		} else storyId = workItemId(requiredString(input.story, "Task story ref"), "Task story");
		const id = current?.id ?? requiredString(input.id, "Task id");
		const assignment = {
			agent: input.agent ?? current?.assignment.agent ?? "implementer",
			tier: input.tier ?? current?.assignment.tier ?? "medium",
			rationale: input.rationale ?? current?.assignment.rationale ?? "Default medium routing for this bounded task.",
			...((input.tierJustification ?? current?.assignment.tierJustification) ? { tierJustification: input.tierJustification ?? current?.assignment.tierJustification } : {}),
		};
		const task = parseAuthoredTaskDocument(stringify({ schemaVersion: 1, id, title: requiredString(input.title ?? current?.title, "Task title"), dependsOn: input.dependsOn ?? current?.dependsOn ?? [], description: requiredString(input.description ?? current?.description, "Task description"), scope: requiredString(input.scope ?? current?.scope, "Task scope"), delivery: requiredString(input.delivery ?? current?.delivery, "Task delivery"), checks: input.checks ?? current?.checks ?? [], assignment }), `tasks/${id}.yaml`);
		this.validateAssignment(task);
		const draft = await this.draft(storyId);
		const index = draft.tasks.findIndex((entry) => entry.id === id);
		if (current) draft.tasks[index] = task;
		else {
			if (index >= 0) throw new HarnessError("WORK_ITEM_EXISTS", `Task already exists: ${id}`);
			draft.tasks.push(task);
		}
		return this.store.writeAuthoredPlan({ ...draft, draft: true });
	}

	async writeStage(input: StageWriteInput): Promise<unknown> {
		let storyId: string;
		let current: AuthoredExecutionStage | undefined;
		if (input.ref) {
			const parsed = parseResourceRef(input.ref);
			if (parsed.type !== "stage") throw new HarnessError("INVALID_ARTIFACT", "stage_write ref must identify a stage");
			rejectConflictingIdentity(input.id, parsed.id, "Stage");
			rejectConflictingParent(input.story, parsed.workItemId, "Stage");
			storyId = parsed.workItemId;
			current = (await this.store.readStoryPlan(storyId, { draft: true })).stages.find((entry) => entry.id === parsed.id);
			if (!current) throw new HarnessError("INVALID_ARTIFACT", `Unknown stage: ${parsed.id}`);
			requireChanged(input as Record<string, unknown>, ["ref", "story", "id"]);
		} else storyId = workItemId(requiredString(input.story, "Stage story ref"), "Stage story");
		const id = current?.id ?? requiredString(input.id, "Stage id");
		const mode = input.mode ?? current?.mode;
		if (!mode) throw new HarnessError("INVALID_ARTIFACT", "Stage mode is required");
		const reviewMode = input.reviewMode === "none" ? undefined : input.reviewMode ?? current?.review?.mode;
		const reviewFocus = input.reviewFocus !== undefined ? input.reviewFocus.trim() || undefined : current?.review?.focus;
		if (input.reviewFocus !== undefined && !reviewMode && input.reviewMode !== "none") throw new HarnessError("INVALID_ARTIFACT", "Stage reviewFocus requires reviewMode required or skip");
		if (input.reviewMode === "none" && input.reviewFocus?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Stage reviewFocus cannot be set while removing review policy");
		const stage = parseStoryPlanDocument(stringify({ schemaVersion: 1, stages: [{ id, mode, tasks: input.tasks ?? current?.tasks ?? [], checks: input.checks ?? current?.checks ?? [], ...(reviewMode ? { review: { mode: reviewMode, ...(reviewFocus ? { focus: reviewFocus } : {}) } } : {}) }] }), "plan.yaml", { draft: true }).stages[0]!;
		const draft = await this.draft(storyId);
		const index = draft.plan.stages.findIndex((entry) => entry.id === id);
		if (current) draft.plan.stages[index] = stage;
		else {
			if (index >= 0) throw new HarnessError("WORK_ITEM_EXISTS", `Stage already exists: ${id}`);
			draft.plan.stages.push(stage);
		}
		return this.store.writeAuthoredPlan({ ...draft, draft: true });
	}

	async compile(storyId: string): Promise<Record<string, unknown>> {
		await this.store.read(storyId);
		const story = await this.store.readStory(storyId);
		const issues = compiledStoryIssues(story.spec, story.design, story.e2e);
		const plan = await this.store.readStoryPlan(storyId, { draft: true }).catch((error) => error instanceof HarnessError && /has not crossed/.test(error.message) ? undefined : Promise.reject(error));
		const tasks = await this.store.listAuthoredTasks(storyId);
		if (!plan && tasks.length) issues.push("Authored tasks require a plan with at least one stage");
		if (plan) {
			issues.push(...compiledConfigurationIssues(this.config, tasks, plan.stages));
			if (plan.stages.length === 0) issues.push("Plan must contain at least one stage");
			const taskIds = new Set(tasks.map((task) => task.id));
			const positions = new Map<string, { stage: number; task: number; mode: "sequential" | "concurrent" }>();
			for (const [stageIndex, stage] of plan.stages.entries()) {
				if (stage.tasks.length === 0) issues.push(`Stage ${stage.id} must contain at least one task`);
				for (const [taskIndex, taskId] of stage.tasks.entries()) {
					if (!taskIds.has(taskId)) issues.push(`Stage ${stage.id} references unknown task ${taskId}`);
					if (positions.has(taskId)) issues.push(`Task ${taskId} is assigned to more than one stage`);
					else positions.set(taskId, { stage: stageIndex, task: taskIndex, mode: stage.mode });
				}
			}
			for (const task of tasks) {
				if (!positions.has(task.id)) issues.push(`Task ${task.id} is not assigned to a stage`);
				for (const dependency of task.dependsOn) {
					const own = positions.get(task.id); const required = positions.get(dependency);
					if (!taskIds.has(dependency) || !required) issues.push(`Task ${task.id} depends on unknown or unscheduled task ${dependency}`);
					else if (own && !(required.stage < own.stage || (required.stage === own.stage && own.mode === "sequential" && required.task < own.task))) issues.push(`Task ${task.id} dependency ${dependency} must run earlier`);
				}
			}
		}
		if (issues.length) throw new HarnessError("INVALID_ARTIFACT", `Workflow compilation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n${issues.map((issue) => `- ${issue}`).join("\n")}`, { issues });
		return { ref: `work-item:${storyId}`, phase: plan ? "plan" : "story", digests: { story: digest(story), ...(plan ? { plan: digest(plan), tasks: Object.fromEntries(tasks.map((task) => [task.id, digest(task)])) } : {}) }, counts: { e2eCases: parseE2e(story.e2e).cases.length, tasks: tasks.length, stages: plan?.stages.length ?? 0 } };
	}

	async delete(ref: string, _context?: { authority: MutationAuthority }): Promise<unknown> {
		const parsed = parseResourceRef(ref);
		if (parsed.type === "work-item") throw new HarnessError("CAPABILITY_DENIED", "Stories and historical resources are retained; delete tasks, stages, or E2E cases instead");
		if (parsed.type === "e2e") {
			const story = await this.store.readStory(parsed.workItemId);
			const e2e = parseE2e(story.e2e);
			if (!e2e.cases.some((entry) => entry.id === parsed.id)) throw new HarnessError("INVALID_ARTIFACT", `Unknown E2E case: ${parsed.id}`);
			e2e.cases = e2e.cases.filter((entry) => entry.id !== parsed.id);
			return this.store.reviseStoryDocument({ ...story, e2e: renderE2e(e2e) });
		}
		const draft = await this.draft(parsed.workItemId);
		if (parsed.type === "task") {
			if (!draft.tasks.some((task) => task.id === parsed.id)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${parsed.id}`);
			draft.tasks = draft.tasks.filter((task) => task.id !== parsed.id);
			draft.plan.stages = draft.plan.stages.map((stage) => ({ ...stage, tasks: stage.tasks.filter((id) => id !== parsed.id) }));
		} else {
			const stage = draft.plan.stages.find((candidate) => candidate.id === parsed.id);
			if (!stage) throw new HarnessError("INVALID_ARTIFACT", `Unknown stage: ${parsed.id}`);
			draft.plan.stages = draft.plan.stages.filter((candidate) => candidate.id !== parsed.id);
		}
		return this.store.writeAuthoredPlan({ ...draft, draft: true });
	}
}
