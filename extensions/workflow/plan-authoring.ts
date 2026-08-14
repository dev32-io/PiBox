import { HarnessError } from "./errors.js";
import type { CanonicalResourceType, PlanBundle, PlanEdit } from "./orchestrator-resources.js";

export type PlanAuthoringRecord = Record<string, unknown>;

function record(value: unknown): PlanAuthoringRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as PlanAuthoringRecord : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value as string[] : [];
}

function titleFromId(value: unknown): string {
	return String(value).split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function qualifiedSpecificationIds(value: unknown): string[] {
	const ids = new Set<string>();
	const visit = (entry: unknown): void => {
		if (typeof entry === "string") {
			for (const match of entry.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)*)#AC-\d{3}\b/g)) ids.add(match[1]!);
		} else if (Array.isArray(entry)) entry.forEach(visit);
		else if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
	};
	visit(value);
	return [...ids];
}

function normalizeDelivery(value: unknown): PlanAuthoringRecord {
	const delivery = record(value);
	return {
		branchType: delivery.branchType,
		branchMode: delivery.branchMode ?? "create",
		baseBranch: "develop",
		...(delivery.featureBranch !== undefined ? { featureBranch: delivery.featureBranch } : {}),
	};
}

export function normalizePlanArtifact(value: unknown): PlanAuthoringRecord {
	const artifact = record(value);
	return {
		id: artifact.id,
		type: artifact.type,
		narrativeSchemaVersion: 2,
		title: artifact.title ?? titleFromId(artifact.id),
		sections: artifact.sections,
	};
}

export function normalizePlanTask(value: unknown): PlanAuthoringRecord {
	const task = record(value);
	const brief = record(task.briefSections);
	const acceptance = record(task.acceptanceSections);
	const references = record(task.references);
	const assignment = record(task.assignment);
	const verification = record(task.verification);
	const tier = assignment.tier ?? "medium";
	const deliberation = assignment.deliberation ?? "standard";
	const stageId = task.stageId ?? task.id;
	const boundaryIncluded = strings(brief.boundaryIncluded);
	const contributionGoal = brief.contributionGoal;
	return {
		manifest: {
			schemaVersion: 1,
			id: task.id,
			title: task.title ?? titleFromId(task.id),
			status: "draft",
			dependsOn: strings(task.dependsOn),
			references: {
				specs: references.specs === undefined ? qualifiedSpecificationIds(acceptance.criterionContributions) : strings(references.specs),
				designs: strings(references.designs),
				decisions: strings(references.decisions),
			},
			execution: {
				resourceClaims: strings(task.resourceClaims),
				assignment: {
					agent: assignment.agent ?? assignment.role ?? "implementer",
					tier,
					deliberation,
					...(assignment.modelOverride !== undefined ? { modelOverride: assignment.modelOverride } : {}),
					rationale: assignment.rationale ?? `Default ${tier}/${deliberation} routing for a bounded contribution.`,
				},
			},
			assembly: {
				stageId,
				intermediateState: task.intermediateState ?? "complete",
			},
			verification: {
				timing: verification.timing ?? "task",
				methods: strings(verification.methods),
				taskChecks: strings(verification.taskChecks),
				rationale: verification.rationale ?? "Verify the contribution at its declared task boundary.",
			},
		},
		narrativeSchemaVersion: 2,
		briefSections: {
			...brief,
			contributionGoal,
			boundaryIncluded,
			requiredWork: brief.requiredWork ?? boundaryIncluded,
			integrationExpectation: brief.integrationExpectation ?? `Deliver this contribution for integration in stage ${String(stageId)}.`,
		},
		acceptanceSections: {
			...acceptance,
			deliverables: acceptance.deliverables ?? [contributionGoal],
		},
	};
}

export function normalizePlanIntegrationUnit(value: unknown): PlanAuthoringRecord {
	const unit = record(value);
	return { id: unit.id, tasks: strings(unit.tasks), intermediatePolicy: unit.intermediatePolicy ?? "coherent" };
}

export function normalizePlanEvaluation(value: unknown, workItemId: string): PlanAuthoringRecord {
	const evaluation = record(value);
	return {
		manifest: {
			schemaVersion: 1,
			id: evaluation.id,
			type: evaluation.type,
			scope: evaluation.scope ?? { workItem: workItemId },
			status: "planned",
			required: evaluation.required ?? true,
			attempt: 0,
			methods: strings(evaluation.methods),
			...(evaluation.criteria !== undefined ? { criteria: evaluation.criteria } : {}),
		},
	};
}

/** Expand the compact planner-facing shape into the complete canonical resource contracts. */
export function normalizePlanBundle(value: unknown): PlanBundle {
	const plan = record(value);
	const workItem = record(plan.workItem);
	const id = String(workItem.id);
	return {
		workItem: {
			id: workItem.id,
			title: workItem.title,
			kind: workItem.kind ?? "story",
			delivery: normalizeDelivery(workItem.delivery),
			narrativeSchemaVersion: 2,
			intentSections: workItem.intentSections,
		},
		artifacts: Array.isArray(plan.artifacts) ? plan.artifacts.map(normalizePlanArtifact) : [],
		tasks: Array.isArray(plan.tasks) ? plan.tasks.map(normalizePlanTask) : [],
		integrationUnits: Array.isArray(plan.integrationUnits) ? plan.integrationUnits.map(normalizePlanIntegrationUnit) : [],
		evaluations: Array.isArray(plan.evaluations) ? plan.evaluations.map((entry) => normalizePlanEvaluation(entry, id)) : [],
	};
}

function definedEntries(value: PlanAuthoringRecord): PlanAuthoringRecord {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

const EDIT_FIELDS: Record<Exclude<CanonicalResourceType, "work-item">, { create: string[]; update: string[] }> = {
	artifact: { create: ["id", "type", "title", "sections"], update: ["type", "title", "sections"] },
	task: {
		create: ["id", "title", "dependsOn", "references", "stageId", "intermediateState", "resourceClaims", "assignment", "verification", "briefSections", "acceptanceSections"],
		update: ["title", "dependsOn", "references", "stageId", "intermediateState", "resourceClaims", "assignment", "verification", "briefSections", "acceptanceSections"],
	},
	"integration-unit": { create: ["id", "tasks", "intermediatePolicy"], update: ["tasks", "intermediatePolicy"] },
	evaluation: { create: ["id", "type", "scope", "required", "methods", "criteria"], update: ["type", "scope", "required", "methods", "criteria"] },
};

function assertEditFields(type: CanonicalResourceType, action: "create" | "update", input: PlanAuthoringRecord): void {
	const allowed = new Set(type === "work-item" ? ["title", "kind", "delivery", "intentSections"] : EDIT_FIELDS[type][action]);
	const unknown = Object.keys(input).filter((key) => !allowed.has(key));
	if (unknown.length) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for ${type} has unknown field(s): ${unknown.join(", ")}`);
	if (type === "task" && input.references !== undefined) {
		const unknownReferences = Object.keys(record(input.references)).filter((key) => !["specs", "designs", "decisions"].includes(key));
		if (unknownReferences.length) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for task has unknown reference field(s): ${unknownReferences.join(", ")}`);
	}
	if (type === "task" && input.assignment !== undefined) {
		const unknownAssignment = Object.keys(record(input.assignment)).filter((key) => !["agent", "role", "tier", "deliberation", "modelOverride", "rationale"].includes(key));
		if (unknownAssignment.length) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for task has unknown assignment field(s): ${unknownAssignment.join(", ")}`);
	}
	if (type === "task" && input.verification !== undefined) {
		const unknownVerification = Object.keys(record(input.verification)).filter((key) => !["timing", "methods", "taskChecks", "rationale"].includes(key));
		if (unknownVerification.length) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for task has unknown verification field(s): ${unknownVerification.join(", ")}`);
	}
}

function hasChange(value: unknown): boolean {
	if (value === undefined) return false;
	if (Array.isArray(value)) return true;
	if (value && typeof value === "object") return Object.values(value).some(hasChange);
	return true;
}

function assertTaskUpdateContract(input: PlanAuthoringRecord, ref: string): void {
	const brief = input.briefSections !== undefined;
	const acceptance = input.acceptanceSections !== undefined;
	if (brief !== acceptance) throw new HarnessError("INVALID_ARTIFACT", `Plan task update for ${ref} must provide briefSections and acceptanceSections together so the structured contract remains coherent`);
}

/** Convert one compact surgical edit into the existing canonical resource mutation shape. */
export function normalizePlanEdit(type: CanonicalResourceType, action: PlanEdit["action"], ref: string, value: unknown, workItemId: string): PlanEdit {
	if (action === "delete") {
		if (value !== undefined) throw new HarnessError("INVALID_ARTIFACT", `Plan delete for ${ref} does not accept value`);
		return { action, ref };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for ${ref} requires an object value`);
	const input = record(value);
	assertEditFields(type, action, input);
	if (action === "create") {
		if (type === "artifact") return { action, ref, value: normalizePlanArtifact(input) };
		if (type === "task") return { action, ref, value: normalizePlanTask(input) };
		if (type === "integration-unit") return { action, ref, value: normalizePlanIntegrationUnit(input) };
		if (type === "evaluation") return { action, ref, value: normalizePlanEvaluation(input, workItemId) };
		return { action, ref, value: input };
	}
	if (type === "work-item") {
		const patch = definedEntries({
			title: input.title,
			kind: input.kind,
			...(input.delivery !== undefined ? { delivery: normalizeDelivery(input.delivery) } : {}),
			...(input.intentSections !== undefined ? { narrativeSchemaVersion: 2, intentSections: input.intentSections } : {}),
		});
		if (!hasChange(patch)) throw new HarnessError("INVALID_ARTIFACT", `Plan update for ${ref} has no changed fields`);
		return { action, ref, value: patch };
	}
	if (type === "artifact") {
		const patch = definedEntries({ type: input.type, title: input.title, ...(input.sections !== undefined ? { narrativeSchemaVersion: 2, sections: input.sections } : {}) });
		if (!hasChange(patch)) throw new HarnessError("INVALID_ARTIFACT", `Plan update for ${ref} has no changed fields`);
		return { action, ref, value: patch };
	}
	if (type === "task") {
		assertTaskUpdateContract(input, ref);
		const references = input.references === undefined ? undefined : definedEntries(record(input.references));
		const assignment = input.assignment === undefined ? undefined : definedEntries(record(input.assignment));
		const verification = input.verification === undefined ? undefined : definedEntries(record(input.verification));
		const manifest = definedEntries({
			title: input.title,
			dependsOn: input.dependsOn,
			...(references !== undefined ? { references } : {}),
			...(input.resourceClaims !== undefined || assignment !== undefined ? { execution: definedEntries({ resourceClaims: input.resourceClaims, ...(assignment !== undefined ? { assignment } : {}) }) } : {}),
			...(input.stageId !== undefined || input.intermediateState !== undefined ? { assembly: definedEntries({ stageId: input.stageId, intermediateState: input.intermediateState }) } : {}),
			...(verification !== undefined ? { verification } : {}),
		});
		const patch = definedEntries({
			...(Object.keys(manifest).length ? { manifest } : {}),
			...(input.briefSections !== undefined ? { briefSections: input.briefSections } : {}),
			...(input.acceptanceSections !== undefined ? { acceptanceSections: input.acceptanceSections } : {}),
			...(input.briefSections !== undefined || input.acceptanceSections !== undefined ? { narrativeSchemaVersion: 2 } : {}),
		});
		if (!hasChange(patch)) throw new HarnessError("INVALID_ARTIFACT", `Plan update for ${ref} has no changed fields`);
		return { action, ref, value: patch };
	}
	if (type === "evaluation") {
		const patch = { manifest: definedEntries(input) };
		if (!hasChange(patch)) throw new HarnessError("INVALID_ARTIFACT", `Plan update for ${ref} has no changed fields`);
		return { action, ref, value: patch };
	}
	if (!hasChange(input)) throw new HarnessError("INVALID_ARTIFACT", `Plan update for ${ref} has no changed fields`);
	return { action, ref, value: input };
}
