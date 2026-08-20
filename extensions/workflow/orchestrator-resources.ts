import { readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, runGit } from "./repository.js";
import { isTierTaskAssignment, taskAgentName, type HarnessConfig, type MutationAuthority, type TaskManifest, type WorkItemIndex, type WorkItemKind } from "./types.js";
import { resolveStageMode } from "./execution-topology.js";
import { WorkItemStore } from "./work-items.js";
import { CanonicalMutationCoordinator } from "./canonical-mutation.js";

export type CanonicalResourceType = "work-item" | "artifact" | "task" | "stage" | "evaluation";

export interface ParsedResourceRef {
	type: CanonicalResourceType;
	workItemId: string;
	id: string;
}

export interface ResourceMutationContext {
	authority: MutationAuthority;
}

export interface PlanBundle {
	workItem: Record<string, unknown>;
	artifacts: Array<Record<string, unknown>>;
	tasks: Array<Record<string, unknown>>;
	stages: Array<Record<string, unknown>>;
}

export interface PlanEdit {
	action: "create" | "update" | "delete";
	ref: string;
	value?: Record<string, unknown>;
}

const REF = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(artifact|task|stage|evaluation):([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

export function parseResourceRef(ref: string): ParsedResourceRef {
	const match = REF.exec(ref);
	if (!match) throw new HarnessError("INVALID_ARTIFACT", `Invalid resource reference: ${ref}`);
	return { type: (match[2] ?? "work-item") as CanonicalResourceType, workItemId: match[1]!, id: match[3] ?? match[1]! };
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("INVALID_ARTIFACT", `${label} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a non-empty string`);
	return value;
}

function merge<T>(base: T, patch: unknown): T {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		if (value === null) delete result[key];
		else if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = merge(result[key], value);
		else result[key] = value;
	}
	return result as T;
}

function allowed(type: CanonicalResourceType, finalized = false): string[] {
	if (finalized) return ["get", "list", "reopen"];
	if (type === "work-item") return ["get", "patch", "transition", "archive"];
	if (type === "stage") return ["get", "patch"];
	return ["get", "patch", "delete"];
}

export class OrchestratorResourceService {
	readonly repositoryRoot: string;
	readonly store: WorkItemStore;
	readonly config: HarnessConfig | undefined;
	readonly coordinator: CanonicalMutationCoordinator;

	constructor(repositoryRoot: string, store = new WorkItemStore(repositoryRoot), config?: HarnessConfig, coordinator?: CanonicalMutationCoordinator) {
		this.repositoryRoot = repositoryRoot;
		this.store = store;
		this.coordinator = coordinator ?? store.coordinator;
		this.config = config;
	}

	private validateTaskAssignment(manifest: TaskManifest): void {
		if (!this.config) return;
		const assignment = manifest.execution.assignment;
		const agentName = taskAgentName(manifest);
		const agent = this.config.agents[agentName];
		if (!agent) throw new HarnessError("CONFIG_INVALID", `Unknown task agent: ${agentName}. Configured agents: ${Object.keys(this.config.agents).join(", ")}`);
		if (isTierTaskAssignment(assignment)) {
			const routes = this.config.modelTiers[assignment.tier];
			if (!routes?.length) throw new HarnessError("CONFIG_INVALID", `Task tier has no configured routes: ${assignment.tier}`);
		}
	}

	private async assertOwnedCommits(base: string): Promise<void> {
		const subjects = (await runGit(this.repositoryRoot, ["log", "--format=%s", `${base}..HEAD`])).split("\n").filter(Boolean);
		if (subjects.some((subject) => !subject.startsWith("harness("))) throw new HarnessError("GIT_OPERATION_FAILED", "Canonical branch advanced outside the resource transaction; refusing to rewrite it");
	}

	async transaction<T>(label: string, operation: () => Promise<T>): Promise<{ value: T; commit?: string }> {
		return this.coordinator.run(`resource:${label}`, async () => {
			await assertCleanRepository(this.repositoryRoot);
			const base = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			try {
				const value = await operation();
				const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
				if (head === base) return { value };
				await this.assertOwnedCommits(base);
				const paths = (await runGit(this.repositoryRoot, ["diff", "--name-only", `${base}..HEAD`])).split("\n").filter(Boolean);
				if (paths.some((path) => !path.startsWith("agent-artifacts/"))) throw new HarnessError("GIT_OPERATION_FAILED", "Resource transaction touched non-harness paths; refusing to coalesce");
				await runGit(this.repositoryRoot, ["reset", "--soft", base]);
				await this.coordinator.commitHarness(paths.map((path) => join(this.repositoryRoot, path)), label.startsWith("harness(") ? label : `harness(resource-api): ${label.replace(/^harness:\s*/, "")}`);
				return { value, commit: await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]) };
			} catch (error) {
				try {
					const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
					if (head !== base) {
						const subjects = (await runGit(this.repositoryRoot, ["log", "--format=%s", `${base}..HEAD`])).split("\n").filter(Boolean);
						const paths = (await runGit(this.repositoryRoot, ["diff", "--name-only", `${base}..HEAD`])).split("\n").filter(Boolean);
						if (subjects.some((subject) => !subject.startsWith("harness(")) || paths.some((path) => !path.startsWith("agent-artifacts/"))) throw new Error("canonical branch advanced outside transaction-owned harness metadata; preserved");
						await runGit(this.repositoryRoot, ["reset", "--soft", base]);
						for (const path of paths) {
							const existed = await runGit(this.repositoryRoot, ["cat-file", "-e", `${base}:${path}`]).then(() => true, () => false);
							if (existed) await runGit(this.repositoryRoot, ["restore", "--source", base, "--staged", "--worktree", "--", path]);
							else { await runGit(this.repositoryRoot, ["reset", "HEAD", "--", path]); await rm(join(this.repositoryRoot, path), { recursive: true, force: true }); }
						}
					}
					await assertCleanRepository(this.repositoryRoot);
				} catch (rollbackError) {
					throw new HarnessError("GIT_OPERATION_FAILED", `Resource mutation failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. External work was preserved.`, { base });
				}
				throw error;
			}
		});
	}

	async coalesceRevision(workItemId: string, baseline: WorkItemIndex | undefined, _authority: MutationAuthority): Promise<WorkItemIndex> {
		const current = await this.store.read(workItemId);
		const revision = (baseline?.planning.revision ?? 0) + 1;
		if (current.planning.revision === revision) return current;
		current.planning.revision = revision;
		const indexPath = join(this.store.workItemRoot(workItemId), "index.yaml");
		await atomicWriteFile(indexPath, stringify(current));
		await this.coordinator.commitHarness([indexPath], `harness(${workItemId}): coalesce resource change`);
		return current;
	}

	async listSummaries(type: CanonicalResourceType, workItemId?: string): Promise<Array<Record<string, unknown>>> {
		const items = workItemId ? [await this.store.read(workItemId)] : await this.store.list();
		const results: Array<Record<string, unknown>> = [];
		for (const item of items) {
			const finalized = Boolean(item.finalization?.locked || item.phase === "complete");
			if (type === "work-item") {
				results.push({
					ref: `work-item:${item.id}`,
					revision: item.planning.revision,
					id: item.id,
					title: item.title,
					kind: item.kind,
					phase: item.phase,
					state: item.state,
					counts: { artifacts: item.artifacts.length, tasks: item.tasks.length, stages: item.executionStages?.length ?? 0, evaluations: item.evaluations.length },
					allowedActions: allowed(type, finalized),
				});
			}
			if (type === "artifact") for (const artifact of item.artifacts) results.push({ ref: `work-item:${item.id}/artifact:${artifact.id}`, revision: item.planning.revision, id: artifact.id, type: artifact.type, status: artifact.status, ...(artifact.narrativeSchemaVersion ? { narrativeSchemaVersion: artifact.narrativeSchemaVersion } : {}), allowedActions: allowed(type, finalized) });
			if (type === "task") for (const catalog of item.tasks) {
				const task = await this.store.readTask(item.id, catalog.id);
				const assignment = task.execution.assignment;
				results.push({
					ref: `work-item:${item.id}/task:${task.id}`,
					revision: item.planning.revision,
					id: task.id,
					title: task.title,
					status: task.status,
					stageId: task.assembly.stageId ?? task.assembly.integrationUnit,
					blockedBy: task.dependsOn,
					assignment: isTierTaskAssignment(assignment) ? { agent: taskAgentName(task), tier: assignment.tier } : { agent: taskAgentName(task), legacyModel: assignment.model },
					allowedActions: allowed(type, finalized),
				});
			}
			if (type === "stage") for (const stage of item.executionStages ?? []) results.push({ ref: `work-item:${item.id}/stage:${stage.id}`, revision: item.planning.revision, id: stage.id, taskCount: stage.tasks.length, checks: stage.checks ?? [], mode: resolveStageMode(stage), review: stage.review ?? { tier: "medium" }, allowedActions: allowed(type, finalized) });
			if (type === "evaluation") for (const catalog of item.evaluations) {
				const evaluation = await this.store.readEvaluation(item.id, catalog.id);
				results.push({ ref: `work-item:${item.id}/evaluation:${evaluation.id}`, revision: item.planning.revision, id: evaluation.id, type: evaluation.type, status: evaluation.status, required: evaluation.required, scope: evaluation.scope, allowedActions: allowed(type, finalized) });
			}
		}
		return results;
	}

	async summary(ref: string): Promise<Record<string, unknown>> {
		const parsed = parseResourceRef(ref);
		const summaries = await this.listSummaries(parsed.type, parsed.workItemId);
		const summary = summaries.find((candidate) => candidate.ref === ref);
		if (!summary) throw new HarnessError("INVALID_ARTIFACT", `Unknown ${parsed.type} resource: ${ref}`);
		return { ...summary, availableViews: ["summary", "full"] };
	}

	/** Complete representations remain available for bounded workflow_get reads. */
	async list(type: CanonicalResourceType, workItemId?: string): Promise<unknown[]> {
		const items = workItemId ? [await this.store.read(workItemId)] : await this.store.list();
		if (type === "work-item") return items.map((item) => ({ resource: item, ref: `work-item:${item.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) }));
		const results: unknown[] = [];
		for (const item of items) {
			if (type === "artifact") for (const artifact of item.artifacts) results.push({ resource: artifact, ref: `work-item:${item.id}/artifact:${artifact.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) });
			if (type === "task") for (const task of item.tasks) results.push({ resource: await this.store.readTask(item.id, task.id), ref: `work-item:${item.id}/task:${task.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) });
			if (type === "stage") for (const stage of item.executionStages ?? []) results.push({ resource: stage, ref: `work-item:${item.id}/stage:${stage.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) });
			if (type === "evaluation") for (const evaluation of item.evaluations) results.push({ resource: await this.store.readEvaluation(item.id, evaluation.id), ref: `work-item:${item.id}/evaluation:${evaluation.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) });
		}
		return results;
	}

	async get(ref: string): Promise<unknown> {
		const parsedRef = parseResourceRef(ref);
		const startHead = parsedRef.type === "work-item" ? await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]) : undefined;
		const item = await this.store.read(parsedRef.workItemId);
		const envelope = (resource: unknown) => ({ resource, ref, revision: item.planning.revision, allowedActions: allowed(parsedRef.type, Boolean(item.finalization?.locked || item.phase === "complete")) });
		if (parsedRef.type === "work-item") {
			const artifactContracts = await Promise.all(item.artifacts.map((artifact) => this.store.readArtifact(item.id, artifact.id)));
			const taskContracts = await Promise.all(item.tasks.map((task) => this.store.readTaskContract(item.id, task.id)));
			const evaluations = await Promise.all(item.evaluations.map((evaluation) => this.store.readEvaluation(item.id, evaluation.id)));
			const endHead = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			const endRevision = (await this.store.read(item.id)).planning.revision;
			if (startHead !== endHead || endRevision !== item.planning.revision) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `work-item:${item.id} changed while its complete plan was being read; retry the full read`);
			return envelope({
				workItem: {
					id: item.id, title: item.title, kind: item.kind, phase: item.phase, state: item.state, planning: item.planning,
					...(item.delivery ? { delivery: item.delivery } : {}), ...(item.finalization ? { finalization: item.finalization } : {}),
				},
				artifacts: artifactContracts.map(({ metadata, content }) => ({
					id: metadata.id, type: metadata.type, status: metadata.status, ...(metadata.narrativeSchemaVersion ? { narrativeSchemaVersion: metadata.narrativeSchemaVersion } : {}),
					...(metadata.links ? { links: metadata.links } : {}), content,
				})),
				tasks: taskContracts.map(({ manifest, brief, acceptance }) => ({ manifest, brief, acceptance })),
				executionStages: item.executionStages ?? [], integrationUnits: item.integrationUnits, evaluations,
			});
		}
		if (parsedRef.type === "artifact") return envelope(await this.store.readArtifact(item.id, parsedRef.id));
		if (parsedRef.type === "task") return envelope(await this.store.readTaskContract(item.id, parsedRef.id));
		if (parsedRef.type === "stage") {
			const stage = item.executionStages?.find((candidate) => candidate.id === parsedRef.id);
			if (!stage) throw new HarnessError("INVALID_ARTIFACT", `Unknown execution stage: ${parsedRef.id}`);
			return envelope(stage);
		}
		return envelope(await this.store.readEvaluation(item.id, parsedRef.id));
	}

	private async assertPlanEditable(workItemId: string, expectedRevision: number): Promise<WorkItemIndex> {
		const current = await this.store.read(workItemId);
		if (current.planning.revision !== expectedRevision) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `work-item:${workItemId} advanced from requested revision ${expectedRevision} to ${current.planning.revision}`);
		if (current.phase !== "planning" || current.finalization?.locked) throw new HarnessError("CAPABILITY_DENIED", `Plan ${workItemId} cannot be edited after delivery or finalization`);
		for (const task of current.tasks) {
			const manifest = await this.store.readTask(workItemId, task.id);
			if (manifest.runtime || !["draft", "blocked", "ready"].includes(manifest.status)) throw new HarnessError("CAPABILITY_DENIED", `Plan ${workItemId} has task delivery history and cannot be edited`);
		}
		for (const evaluation of current.evaluations) {
			const manifest = await this.store.readEvaluation(workItemId, evaluation.id);
			if (manifest.attempt > 0 || manifest.result) throw new HarnessError("CAPABILITY_DENIED", `Plan ${workItemId} has evaluation history and cannot be edited`);
		}
		return current;
	}

	/** Apply revision-pinned, resource-level plan corrections without rewriting the complete bundle. */
	async editPlan(target: string, expectedRevision: number, edits: PlanEdit[], authority: MutationAuthority): Promise<WorkItemIndex> {
		const parsedTarget = parseResourceRef(target);
		if (parsedTarget.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "Plan edit target must be a work item");
		if (edits.length === 0) throw new HarnessError("INVALID_ARTIFACT", "Plan edit requires at least one surgical change");
		const current = await this.assertPlanEditable(parsedTarget.id, expectedRevision);
		for (const edit of edits) {
			const parsed = parseResourceRef(edit.ref);
			if (parsed.workItemId !== parsedTarget.id) throw new HarnessError("INVALID_ARTIFACT", `Plan edit ${edit.ref} is outside ${target}`);
			if (edit.action === "delete") {
				if (parsed.type === "work-item") throw new HarnessError("CAPABILITY_DENIED", "Surgical plan edits cannot delete the work item");
				if (parsed.type === "stage") throw new HarnessError("CAPABILITY_DENIED", "Delete stage tasks or replace the complete plan instead");
				else await this.delete(edit.ref, { authority });
				continue;
			}
			if (!edit.value) throw new HarnessError("INVALID_ARTIFACT", `Plan ${edit.action} requires value for ${edit.ref}`);
			if (edit.action === "update") {
				await this.patch(edit.ref, edit.value, { authority });
				continue;
			}
			if (parsed.type === "work-item") throw new HarnessError("INVALID_ARTIFACT", "A surgical plan edit cannot create another work item");
			const bodyId = parsed.type === "task" || parsed.type === "evaluation"
				? object(edit.value.manifest, `${parsed.type} manifest`).id
				: edit.value.id;
			if (bodyId !== parsed.id) throw new HarnessError("INVALID_ARTIFACT", `Created ${parsed.type} id ${String(bodyId)} must match edit ref ${parsed.id}`);
			await this.create(parsed.type, target, edit.value, authority);
		}
		return this.coalesceRevision(parsedTarget.id, current, authority);
	}

	async writePlan(input: { mode: "create"; plan: PlanBundle } | { mode: "update"; target: string; expectedRevision: number; plan: PlanBundle }, authority: MutationAuthority): Promise<WorkItemIndex> {
		const plan = input.plan;
		const planId = string(plan.workItem.id, "plan.workItem.id");
		if (input.mode === "update") {
			const target = parseResourceRef(input.target);
			if (target.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "Plan update target must be a work item");
			if (target.id !== planId) throw new HarnessError("INVALID_ARTIFACT", `Update plan id ${planId} must match target ${target.id}`);
			const current = await this.assertPlanEditable(target.id, input.expectedRevision);
			for (const evaluation of current.evaluations) await this.store.removeEvaluation(target.id, evaluation.id, authority);
			const remainingTaskIds = new Set(current.tasks.map((task) => task.id));
			while (remainingTaskIds.size > 0) {
				const manifests = await Promise.all([...remainingTaskIds].map((id) => this.store.readTask(target.id, id)));
				const leaf = manifests.find((candidate) => !manifests.some((other) => other.dependsOn.includes(candidate.id)));
				if (!leaf) throw new HarnessError("INVALID_ARTIFACT", `Existing task graph for ${target.id} contains a dependency cycle`);
				await this.store.removeTask(target.id, leaf.id, authority);
				remainingTaskIds.delete(leaf.id);
			}
			for (const artifact of current.artifacts.filter((entry) => entry.id !== "intent" && !plan.artifacts.some((desired) => desired.id === entry.id))) await this.store.removeArtifact(target.id, artifact.id, authority);
			const { id: _id, ...workItemPatch } = plan.workItem;
			await this.patch(input.target, workItemPatch, { authority });
			const remaining = await this.store.read(target.id);
			for (const artifact of plan.artifacts) {
				const id = string(artifact.id, "artifact id");
				const exists = remaining.artifacts.some((entry) => entry.id === id);
				if (exists) await this.patch(`work-item:${target.id}/artifact:${id}`, artifact, { authority });
				else await this.create("artifact", input.target, artifact, authority);
			}
			for (const task of plan.tasks) await this.create("task", input.target, task, authority);
			for (const stage of plan.stages) await this.create("stage", input.target, stage, authority);
			return this.coalesceRevision(target.id, current, authority);
		}

		await this.create("work-item", undefined, plan.workItem, authority);
		const parent = `work-item:${planId}`;
		for (const artifact of plan.artifacts) await this.create("artifact", parent, artifact, authority);
		for (const task of plan.tasks) await this.create("task", parent, task, authority);
		for (const stage of plan.stages) await this.create("stage", parent, stage, authority);
		return this.coalesceRevision(planId, undefined, authority);
	}

	async create(type: CanonicalResourceType, parent: string | undefined, bodyValue: unknown, authority: MutationAuthority): Promise<unknown> {
		const body = object(bodyValue, "Resource body");
		if (type === "work-item") {
			if (body.kind !== "change" && body.kind !== "story") throw new HarnessError("INVALID_ARTIFACT", "Work-item kind must be change or story");
			return this.store.create({ id: string(body.id, "id"), title: string(body.title, "title"), kind: body.kind as WorkItemKind, ...(body.workingBranch !== undefined ? { workingBranch: body.workingBranch as string } : {}), ...(body.branchKind !== undefined ? { branchKind: body.branchKind as "feature" | "fix" } : {}), ...(body.narrativeSchemaVersion ? { narrativeSchemaVersion: body.narrativeSchemaVersion as 1 | 2 } : {}), ...(body.intent ? { intent: body.intent as string } : {}), ...(body.intentSections ? { intentSections: object(body.intentSections, "intentSections") } : {}) });
		}
		if (!parent) throw new HarnessError("INVALID_ARTIFACT", `${type} creation requires a work-item parent`);
		const parentRef = parseResourceRef(parent);
		if (parentRef.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "Parent must be a work item");
		if (type === "artifact") return this.store.putArtifact({ workItemId: parentRef.id, id: string(body.id, "id"), type: body.type as "spec" | "design" | "decision" | "e2e-matrix", operation: "create", authority, ...(body.content ? { content: body.content as string } : {}), ...(body.sections ? { sections: object(body.sections, "sections") } : {}), ...(body.title ? { title: body.title as string } : {}), ...(body.narrativeSchemaVersion ? { narrativeSchemaVersion: body.narrativeSchemaVersion as 1 | 2 } : {}) });
		if (type === "task") {
			const manifest = object(body.manifest, "manifest") as unknown as TaskManifest;
			this.validateTaskAssignment(manifest);
			return this.store.defineTask({ workItemId: parentRef.id, manifest, authority, ...(body.brief ? { brief: body.brief as string } : {}), ...(body.acceptance ? { acceptance: body.acceptance as string } : {}), ...(body.briefSections ? { briefSections: object(body.briefSections, "briefSections") } : {}), ...(body.acceptanceSections ? { acceptanceSections: object(body.acceptanceSections, "acceptanceSections") } : {}), ...(body.narrativeSchemaVersion ? { narrativeSchemaVersion: body.narrativeSchemaVersion as 1 | 2 } : {}) });
		}
		if (type === "evaluation") throw new HarnessError("CAPABILITY_DENIED", "Evaluation resources are runtime-owned; planners author tasks, stages, checks, and optional stage review policy");
		if (type === "stage") return this.store.putExecutionStage(parentRef.id, body as unknown as NonNullable<WorkItemIndex["executionStages"]>[number], authority);
		throw new HarnessError("INVALID_ARTIFACT", `Unsupported resource type: ${type}`);
	}

	async patch(ref: string, patchValue: unknown, context: ResourceMutationContext): Promise<unknown> {
		const parsedRef = parseResourceRef(ref);
		const patch = object(patchValue, "Patch");
		const item = await this.store.read(parsedRef.workItemId);
		if (Boolean(item.finalization?.locked || item.phase === "complete")) throw new HarnessError("CAPABILITY_DENIED", `Work item ${item.id} is finalized; reopen it before mutation`);
		if (parsedRef.type === "work-item") return this.store.reviseWorkItem({ workItemId: item.id, authority: context.authority, ...(patch.title !== undefined ? { title: patch.title as string } : {}), ...(patch.kind !== undefined ? { kind: patch.kind as WorkItemKind } : {}), ...(patch.intent !== undefined ? { intent: patch.intent as string } : {}), ...(patch.intentSections !== undefined ? { intentSections: object(patch.intentSections, "intentSections") } : {}), ...(patch.narrativeSchemaVersion !== undefined ? { narrativeSchemaVersion: patch.narrativeSchemaVersion as 1 | 2 } : {}) });
		if (parsedRef.type === "artifact") {
			const current = await this.store.readArtifact(item.id, parsedRef.id);
			let result: unknown = item;
			if (Object.keys(patch).some((key) => key !== "links")) {
				let renderedContent = (patch.content as string | undefined) ?? current.content;
				if (patch.title !== undefined && patch.sections === undefined) renderedContent = renderedContent.replace(/^# .+$/m, `# ${patch.title as string}`);
				result = await this.store.putArtifact({ workItemId: item.id, id: parsedRef.id, type: (patch.type ?? current.metadata.type) as "spec" | "design" | "decision" | "e2e-matrix", operation: "update", authority: context.authority, narrativeSchemaVersion: (patch.narrativeSchemaVersion ?? current.metadata.narrativeSchemaVersion ?? 1) as 1 | 2, ...(patch.sections !== undefined ? { sections: object(patch.sections, "sections") } : { renderedContent }), ...(patch.title !== undefined ? { title: patch.title as string } : {}) });
			}
			if (patch.links !== undefined) result = await this.store.linkArtifact(item.id, parsedRef.id, patch.links as string[], context.authority, true);
			return result;
		}
		if (parsedRef.type === "task") {
			const current = await this.store.readTaskContract(item.id, parsedRef.id);
			const directManifestPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => ["title", "dependsOn", "references", "execution", "assembly", "verification"].includes(key)));
			const manifest = merge(current.manifest, patch.manifest ?? directManifestPatch);
			const assemblyPatch = object((patch.manifest as Record<string, unknown> | undefined)?.assembly ?? directManifestPatch.assembly ?? {}, "assembly patch");
			if (assemblyPatch.stageId === undefined && assemblyPatch.integrationUnit !== undefined) manifest.assembly.stageId = assemblyPatch.integrationUnit as string;
			this.validateTaskAssignment(manifest);
			const hasBriefSections = patch.briefSections !== undefined;
			const hasAcceptanceSections = patch.acceptanceSections !== undefined;
			if (hasBriefSections !== hasAcceptanceSections) throw new HarnessError("INVALID_ARTIFACT", "Task patches must provide briefSections and acceptanceSections together");
			const structured = hasBriefSections && hasAcceptanceSections;
			return this.store.reviseTask({ workItemId: item.id, manifest, authority: context.authority, brief: (patch.brief as string | undefined) ?? current.brief, acceptance: (patch.acceptance as string | undefined) ?? current.acceptance, ...(patch.briefSections ? { briefSections: object(patch.briefSections, "briefSections") } : {}), ...(patch.acceptanceSections ? { acceptanceSections: object(patch.acceptanceSections, "acceptanceSections") } : {}), ...(structured ? { narrativeSchemaVersion: 2 as const } : {}) });
		}
		if (parsedRef.type === "stage") {
			const current = item.executionStages?.find((stage) => stage.id === parsedRef.id);
			if (!current) throw new HarnessError("INVALID_ARTIFACT", `Unknown execution stage: ${parsedRef.id}`);
			return this.store.putExecutionStage(item.id, merge(current, patch), context.authority);
		}
		const current = await this.store.readEvaluation(item.id, parsedRef.id);
		return this.store.reviseEvaluation(item.id, merge(current, patch.manifest ?? patch), context.authority);
	}

	async delete(ref: string, context: ResourceMutationContext): Promise<unknown> {
		const parsedRef = parseResourceRef(ref);
		if (parsedRef.type === "work-item") throw new HarnessError("CAPABILITY_DENIED", "Work items are retained for audit; transition them to archived instead");
		if (parsedRef.type === "artifact") return this.store.removeArtifact(parsedRef.workItemId, parsedRef.id, context.authority);
		if (parsedRef.type === "task") return this.store.removeTask(parsedRef.workItemId, parsedRef.id, context.authority);
		if (parsedRef.type === "evaluation") return this.store.removeEvaluation(parsedRef.workItemId, parsedRef.id, context.authority);
		throw new HarnessError("CAPABILITY_DENIED", "Execution stages are updated by patching their task membership");
	}
}
