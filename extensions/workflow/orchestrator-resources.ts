import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, runGit } from "./repository.js";
import { isTierTaskAssignment, type EvaluationManifest, type HarnessConfig, type MutationAuthority, type TaskManifest, type WorkItemIndex, type WorkItemKind } from "./types.js";
import { WorkItemStore } from "./work-items.js";

export type CanonicalResourceType = "work-item" | "artifact" | "task" | "integration-unit" | "evaluation";

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
	integrationUnits: Array<Record<string, unknown>>;
	evaluations: Array<Record<string, unknown>>;
}

const REF = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(artifact|task|integration-unit|evaluation):([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

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
	if (type === "integration-unit") return ["get", "patch"];
	return ["get", "patch", "delete"];
}

export class OrchestratorResourceService {
	readonly repositoryRoot: string;
	readonly store: WorkItemStore;
	readonly config: HarnessConfig | undefined;

	constructor(repositoryRoot: string, store = new WorkItemStore(repositoryRoot), config?: HarnessConfig) {
		this.repositoryRoot = repositoryRoot;
		this.store = store;
		this.config = config;
	}

	private validateTaskAssignment(manifest: TaskManifest): void {
		if (!this.config) return;
		const assignment = manifest.execution.assignment;
		const role = this.config.roles[assignment.role];
		if (!role) throw new HarnessError("CONFIG_INVALID", `Unknown task role: ${assignment.role}. Configured roles: ${Object.keys(this.config.roles).join(", ")}`);
		if (isTierTaskAssignment(assignment)) {
			const routes = this.config.modelTiers[assignment.tier];
			if (!routes?.length) throw new HarnessError("CONFIG_INVALID", `Task tier has no configured routes: ${assignment.tier}`);
			if (!routes.some((route) => route.effort[assignment.deliberation] !== undefined)) throw new HarnessError("CONFIG_INVALID", `Task routing ${assignment.tier}/${assignment.deliberation} has no configured model effort mapping`);
			if (assignment.modelOverride && !Object.values(this.config.modelTiers).flat().some((route) => route.model === assignment.modelOverride!.model || `${route.provider}/${route.model}` === assignment.modelOverride!.model)) {
				throw new HarnessError("CONFIG_INVALID", `Task model override is not configured in any tier: ${assignment.modelOverride.model}`);
			}
		}
	}

	private async assertOwnedCommits(base: string): Promise<void> {
		const subjects = (await runGit(this.repositoryRoot, ["log", "--format=%s", `${base}..HEAD`])).split("\n").filter(Boolean);
		if (subjects.some((subject) => !subject.startsWith("harness("))) throw new HarnessError("GIT_OPERATION_FAILED", "Canonical branch advanced outside the resource transaction; refusing to rewrite it");
	}

	async transaction<T>(label: string, operation: () => Promise<T>): Promise<{ value: T; commit?: string }> {
		await assertCleanRepository(this.repositoryRoot);
		const base = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		try {
			const value = await operation();
			const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			if (head === base) return { value };
			await this.assertOwnedCommits(base);
			await runGit(this.repositoryRoot, ["reset", "--soft", base]);
			const message = label.startsWith("harness(") ? label : `harness(resource-api): ${label.replace(/^harness:\s*/, "")}`;
			await runGit(this.repositoryRoot, ["commit", "-m", message]);
			return { value, commit: await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]) };
		} catch (error) {
			const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]).catch(() => base);
			if (head !== base) {
				await this.assertOwnedCommits(base);
				await runGit(this.repositoryRoot, ["reset", "--hard", base]);
			}
			throw error;
		}
	}

	async coalesceRevision(workItemId: string, baseline: WorkItemIndex | undefined, authority: MutationAuthority): Promise<WorkItemIndex> {
		const current = await this.store.read(workItemId);
		const revision = (baseline?.planning.revision ?? 0) + 1;
		if (current.planning.revision === revision) return current;
		current.planning.revision = revision;
		if (baseline?.planning.status === "approved" && authority.disposition === "retain-approval") {
			current.planning.status = "approved";
			if (baseline.planning.approvedRevision !== undefined) current.planning.approvedRevision = baseline.planning.approvedRevision;
			else delete current.planning.approvedRevision;
			if (baseline.planning.approvedAt) current.planning.approvedAt = baseline.planning.approvedAt;
			else delete current.planning.approvedAt;
			current.planning.approvalAmendments = [
				...(baseline.planning.approvalAmendments ?? []),
				{ revision, at: new Date().toISOString(), decidedBy: "orchestrator", disposition: "retain-approval", rationale: authority.rationale, sources: authority.sources ?? [] },
			];
		}
		const indexPath = join(this.store.workItemRoot(workItemId), "index.yaml");
		await atomicWriteFile(indexPath, stringify(current));
		await runGit(this.repositoryRoot, ["add", "--", relative(this.repositoryRoot, indexPath)]);
		await runGit(this.repositoryRoot, ["commit", "-m", `harness(${workItemId}): coalesce resource change`]);
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
					planningStatus: item.planning.status,
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
					assignment: isTierTaskAssignment(assignment) ? { role: assignment.role, tier: assignment.tier, deliberation: assignment.deliberation } : { role: assignment.role, legacyModel: assignment.model },
					allowedActions: allowed(type, finalized),
				});
			}
			if (type === "integration-unit") for (const unit of item.integrationUnits) results.push({ ref: `work-item:${item.id}/integration-unit:${unit.id}`, revision: item.planning.revision, id: unit.id, taskCount: unit.tasks.length, intermediatePolicy: unit.intermediatePolicy, allowedActions: allowed(type, finalized) });
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
			if (type === "integration-unit") for (const unit of item.integrationUnits) results.push({ resource: unit, ref: `work-item:${item.id}/integration-unit:${unit.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) });
			if (type === "evaluation") for (const evaluation of item.evaluations) results.push({ resource: await this.store.readEvaluation(item.id, evaluation.id), ref: `work-item:${item.id}/evaluation:${evaluation.id}`, revision: item.planning.revision, allowedActions: allowed(type, Boolean(item.finalization?.locked || item.phase === "complete")) });
		}
		return results;
	}

	async get(ref: string): Promise<unknown> {
		const parsedRef = parseResourceRef(ref);
		const item = await this.store.read(parsedRef.workItemId);
		const envelope = (resource: unknown) => ({ resource, ref, revision: item.planning.revision, approval: item.planning, allowedActions: allowed(parsedRef.type, Boolean(item.finalization?.locked || item.phase === "complete")) });
		if (parsedRef.type === "work-item") return envelope({ ...item, intent: (await this.store.readArtifact(item.id, "intent")).content });
		if (parsedRef.type === "artifact") return envelope(await this.store.readArtifact(item.id, parsedRef.id));
		if (parsedRef.type === "task") return envelope(await this.store.readTaskContract(item.id, parsedRef.id));
		if (parsedRef.type === "integration-unit") {
			const unit = item.integrationUnits.find((candidate) => candidate.id === parsedRef.id);
			if (!unit) throw new HarnessError("INVALID_ARTIFACT", `Unknown integration unit: ${parsedRef.id}`);
			return envelope(unit);
		}
		return envelope(await this.store.readEvaluation(item.id, parsedRef.id));
	}

	async writePlan(input: { mode: "create"; plan: PlanBundle } | { mode: "update"; target: string; expectedRevision: number; plan: PlanBundle }, authority: MutationAuthority): Promise<WorkItemIndex> {
		const plan = input.plan;
		const planId = string(plan.workItem.id, "plan.workItem.id");
		if (input.mode === "update") {
			const target = parseResourceRef(input.target);
			if (target.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "Plan update target must be a work item");
			if (target.id !== planId) throw new HarnessError("INVALID_ARTIFACT", `Update plan id ${planId} must match target ${target.id}`);
			const current = await this.store.read(target.id);
			if (current.planning.revision !== input.expectedRevision) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `${input.target} advanced from requested revision ${input.expectedRevision} to ${current.planning.revision}`);
			if (current.phase !== "planning" || current.finalization?.locked) throw new HarnessError("CAPABILITY_DENIED", `Plan ${target.id} cannot be replaced after delivery or finalization`);
			for (const task of current.tasks) {
				const manifest = await this.store.readTask(target.id, task.id);
				if (manifest.runtime || !["draft", "blocked", "ready"].includes(manifest.status)) throw new HarnessError("CAPABILITY_DENIED", `Plan ${target.id} has task delivery history and cannot be replaced`);
			}
			for (const evaluation of current.evaluations) {
				const manifest = await this.store.readEvaluation(target.id, evaluation.id);
				if (manifest.attempt > 0 || manifest.result) throw new HarnessError("CAPABILITY_DENIED", `Plan ${target.id} has evaluation history and cannot be replaced`);
			}
			for (const evaluation of current.evaluations) await this.store.removeEvaluation(target.id, evaluation.id, authority);
			for (const unit of current.integrationUnits) await this.store.removeIntegrationUnit(target.id, unit.id, authority);
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
			for (const unit of plan.integrationUnits) await this.create("integration-unit", input.target, unit, authority);
			for (const evaluation of plan.evaluations) await this.create("evaluation", input.target, evaluation, authority);
			return this.coalesceRevision(target.id, current, authority);
		}

		await this.create("work-item", undefined, plan.workItem, authority);
		const parent = `work-item:${planId}`;
		for (const artifact of plan.artifacts) await this.create("artifact", parent, artifact, authority);
		for (const task of plan.tasks) await this.create("task", parent, task, authority);
		for (const unit of plan.integrationUnits) await this.create("integration-unit", parent, unit, authority);
		for (const evaluation of plan.evaluations) await this.create("evaluation", parent, evaluation, authority);
		return this.coalesceRevision(planId, undefined, authority);
	}

	async create(type: CanonicalResourceType, parent: string | undefined, bodyValue: unknown, authority: MutationAuthority): Promise<unknown> {
		const body = object(bodyValue, "Resource body");
		if (type === "work-item") {
			if (body.kind !== "change" && body.kind !== "story") throw new HarnessError("INVALID_ARTIFACT", "Work-item kind must be change or story");
			return this.store.create({ id: string(body.id, "id"), title: string(body.title, "title"), kind: body.kind as WorkItemKind, delivery: object(body.delivery, "delivery") as unknown as NonNullable<WorkItemIndex["delivery"]>, ...(body.narrativeSchemaVersion ? { narrativeSchemaVersion: body.narrativeSchemaVersion as 1 | 2 } : {}), ...(body.intent ? { intent: body.intent as string } : {}), ...(body.intentSections ? { intentSections: object(body.intentSections, "intentSections") } : {}) });
		}
		if (!parent) throw new HarnessError("INVALID_ARTIFACT", `${type} creation requires a work-item parent`);
		const parentRef = parseResourceRef(parent);
		if (parentRef.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "Parent must be a work item");
		if (type === "artifact") return this.store.putArtifact({ workItemId: parentRef.id, id: string(body.id, "id"), type: body.type as "spec" | "design" | "decision", operation: "create", authority, ...(body.content ? { content: body.content as string } : {}), ...(body.sections ? { sections: object(body.sections, "sections") } : {}), ...(body.title ? { title: body.title as string } : {}), ...(body.narrativeSchemaVersion ? { narrativeSchemaVersion: body.narrativeSchemaVersion as 1 | 2 } : {}) });
		if (type === "task") {
			const manifest = object(body.manifest, "manifest") as unknown as TaskManifest;
			this.validateTaskAssignment(manifest);
			return this.store.defineTask({ workItemId: parentRef.id, manifest, authority, ...(body.brief ? { brief: body.brief as string } : {}), ...(body.acceptance ? { acceptance: body.acceptance as string } : {}), ...(body.briefSections ? { briefSections: object(body.briefSections, "briefSections") } : {}), ...(body.acceptanceSections ? { acceptanceSections: object(body.acceptanceSections, "acceptanceSections") } : {}), ...(body.narrativeSchemaVersion ? { narrativeSchemaVersion: body.narrativeSchemaVersion as 1 | 2 } : {}) });
		}
		if (type === "evaluation") return this.store.defineEvaluation(parentRef.id, object(body.manifest, "manifest") as unknown as EvaluationManifest, "# Evaluation\n\nPending.\n", authority);
		if (type === "integration-unit") return this.store.putIntegrationUnit(parentRef.id, body as unknown as WorkItemIndex["integrationUnits"][number], authority);
		throw new HarnessError("INVALID_ARTIFACT", `Unsupported resource type: ${type}`);
	}

	async patch(ref: string, patchValue: unknown, context: ResourceMutationContext): Promise<unknown> {
		const parsedRef = parseResourceRef(ref);
		const patch = object(patchValue, "Patch");
		const item = await this.store.read(parsedRef.workItemId);
		if (Boolean(item.finalization?.locked || item.phase === "complete")) throw new HarnessError("CAPABILITY_DENIED", `Work item ${item.id} is finalized; reopen it before mutation`);
		if (parsedRef.type === "work-item") return this.store.reviseWorkItem({ workItemId: item.id, authority: context.authority, ...(patch.title !== undefined ? { title: patch.title as string } : {}), ...(patch.kind !== undefined ? { kind: patch.kind as WorkItemKind } : {}), ...(patch.delivery !== undefined ? { delivery: object(patch.delivery, "delivery") as unknown as NonNullable<WorkItemIndex["delivery"]> } : {}), ...(patch.intent !== undefined ? { intent: patch.intent as string } : {}), ...(patch.intentSections !== undefined ? { intentSections: object(patch.intentSections, "intentSections") } : {}), ...(patch.narrativeSchemaVersion !== undefined ? { narrativeSchemaVersion: patch.narrativeSchemaVersion as 1 | 2 } : {}) });
		if (parsedRef.type === "artifact") {
			const current = await this.store.readArtifact(item.id, parsedRef.id);
			let result: unknown = item;
			if (Object.keys(patch).some((key) => key !== "links")) {
				let renderedContent = (patch.content as string | undefined) ?? current.content;
				if (patch.title !== undefined && patch.sections === undefined) renderedContent = renderedContent.replace(/^# .+$/m, `# ${patch.title as string}`);
				result = await this.store.putArtifact({ workItemId: item.id, id: parsedRef.id, type: (patch.type ?? current.metadata.type) as "spec" | "design" | "decision", operation: "update", authority: context.authority, narrativeSchemaVersion: (patch.narrativeSchemaVersion ?? current.metadata.narrativeSchemaVersion ?? 1) as 1 | 2, ...(patch.sections !== undefined ? { sections: object(patch.sections, "sections") } : { renderedContent }), ...(patch.title !== undefined ? { title: patch.title as string } : {}) });
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
			return this.store.reviseTask({ workItemId: item.id, manifest, authority: context.authority, brief: (patch.brief as string | undefined) ?? current.brief, acceptance: (patch.acceptance as string | undefined) ?? current.acceptance, ...(patch.briefSections ? { briefSections: object(patch.briefSections, "briefSections") } : {}), ...(patch.acceptanceSections ? { acceptanceSections: object(patch.acceptanceSections, "acceptanceSections") } : {}), narrativeSchemaVersion: patch.briefSections || patch.acceptanceSections ? 2 : 1 });
		}
		if (parsedRef.type === "integration-unit") {
			const current = item.integrationUnits.find((unit) => unit.id === parsedRef.id);
			if (!current) throw new HarnessError("INVALID_ARTIFACT", `Unknown integration unit: ${parsedRef.id}`);
			return this.store.putIntegrationUnit(item.id, merge(current, patch), context.authority);
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
		throw new HarnessError("CAPABILITY_DENIED", "Delete tasks from an integration unit by patching its task membership");
	}
}
