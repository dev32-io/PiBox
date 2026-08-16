import { HarnessError } from "./errors.js";
import type { CanonicalResourceType, PlanBundle, PlanEdit } from "./orchestrator-resources.js";

export type PlanAuthoringRecord = Record<string, unknown>;

function record(value: unknown): PlanAuthoringRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as PlanAuthoringRecord : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value as string[] : [];
}

function assertTierJustification(tier: unknown, justification: unknown): void {
	if ((tier === "high" || tier === "max") && (typeof justification !== "string" || justification.trim().length < 20)) {
		throw new HarnessError("INVALID_ARTIFACT", `${String(tier)} routing requires a substantive tierJustification explaining why medium is insufficient, the irreducible ambiguity, and why further decomposition is unsafe or incoherent`);
	}
}

function titleFromId(value: unknown): string {
	return String(value).split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function qualifiedSpecificationIds(value: unknown): string[] {
	const ids = new Set<string>();
	const visit = (entry: unknown): void => {
		if (typeof entry === "string") for (const match of entry.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)*)#AC-\d{3}\b/g)) ids.add(match[1]!);
		else if (Array.isArray(entry)) entry.forEach(visit);
		else if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
	};
	visit(value);
	return [...ids];
}

function artifactKind(value: unknown): "spec" | "design" | "decision" | "e2e-matrix" | undefined {
	if (value === "spec" || value === "specification") return "spec";
	if (value === "design" || value === "technical-design") return "design";
	if (value === "decision" || value === "adr") return "decision";
	if (value === "e2e-matrix") return "e2e-matrix";
	return undefined;
}

function criteria(value: unknown, fallback: string[]): Array<{ id: string; statement: string }> {
	const entries = Array.isArray(value) ? value : fallback;
	return entries.map((entry, index) => {
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			const item = entry as Record<string, unknown>;
			return { id: typeof item.id === "string" ? item.id : `AC-${String(index + 1).padStart(3, "0")}`, statement: String(item.statement ?? item.behavior ?? item.acceptance ?? "") };
		}
		return { id: `AC-${String(index + 1).padStart(3, "0")}`, statement: String(entry) };
	});
}

function sectionArrayContent(value: unknown): { general: string[]; actors: string[]; constraints: string[]; edgeCases: string[]; outOfScope: string[] } {
	const result = { general: [] as string[], actors: [] as string[], constraints: [] as string[], edgeCases: [] as string[], outOfScope: [] as string[] };
	if (!Array.isArray(value)) return result;
	for (const raw of value) {
		const section = record(raw);
		const title = String(section.title ?? "").toLowerCase();
		const content = strings(section.content);
		if (title.includes("actor")) result.actors.push(...content.filter((entry) => /^actor:/i.test(entry)).map((entry) => entry.replace(/^actor:\s*/i, "")));
		if (title.includes("constraint")) result.constraints.push(...content);
		else if (title.includes("edge")) result.edgeCases.push(...content);
		else if (title.includes("out of scope") || title.includes("excluded")) result.outOfScope.push(...content);
		else result.general.push(...content.filter((entry) => !/^actor:/i.test(entry)));
	}
	return result;
}

/** Accept a small author-facing artifact vocabulary and translate it to canonical sections. */
export function normalizeResourceArtifact(value: unknown): PlanAuthoringRecord {
	const artifact = record(value);
	const kind = artifactKind(artifact.kind ?? artifact.type ?? artifact.artifactType);
	if (!kind) throw new HarnessError("INVALID_ARTIFACT", "Artifact kind must be spec, design, decision, or e2e-matrix (specification is accepted as an alias)");
	const authored = artifact.content ?? artifact.sections;
	const source = record(authored);
	const grouped = sectionArrayContent(authored);
	const title = artifact.title ?? titleFromId(artifact.id);
	let sections: PlanAuthoringRecord;
	if (kind === "e2e-matrix") {
		sections = source;
	} else if (kind === "spec") {
		const behaviors = strings(source.behaviors ?? source.requiredBehaviors ?? source.requirements);
		const requiredBehaviors = behaviors.length ? behaviors : grouped.general;
		sections = {
			context: source.context ?? source.summary ?? `Product behavior defined by ${String(title)}.`,
			...(strings(source.domainLanguage ?? source.domainTerms).length ? { domainLanguage: strings(source.domainLanguage ?? source.domainTerms) } : {}),
			...(strings(source.actors).length || grouped.actors.length ? { actors: [...strings(source.actors), ...grouped.actors] } : {}),
			requiredBehaviors,
			acceptanceCriteria: criteria(source.acceptance ?? source.acceptanceCriteria, requiredBehaviors),
			...(strings(source.scenarios).length ? { scenarios: strings(source.scenarios) } : {}),
			...(strings(source.constraints).length || grouped.constraints.length ? { constraints: [...strings(source.constraints), ...grouped.constraints] } : {}),
			...(strings(source.edgeCases).length || grouped.edgeCases.length ? { edgeCases: [...strings(source.edgeCases), ...grouped.edgeCases] } : {}),
			...(strings(source.assumptions).length ? { assumptions: strings(source.assumptions) } : {}),
			...(strings(source.outOfScope).length || grouped.outOfScope.length ? { outOfScope: [...strings(source.outOfScope), ...grouped.outOfScope] } : {}),
		};
	} else if (kind === "design") {
		sections = {
			designGoal: source.goal ?? source.designGoal,
			chosenApproach: source.approach ?? source.chosenApproach,
			verificationBoundaries: source.verification ?? source.verificationBoundaries,
			...(source.components !== undefined || source.componentsAndInterfaces !== undefined ? { componentsAndInterfaces: source.components ?? source.componentsAndInterfaces } : {}),
			...(source.flow !== undefined || source.dataAndControlFlow !== undefined ? { dataAndControlFlow: source.flow ?? source.dataAndControlFlow } : {}),
			...(source.failureAndRecovery !== undefined ? { failureAndRecovery: source.failureAndRecovery } : {}),
			...(source.securityAndPrivacy !== undefined ? { securityAndPrivacy: source.securityAndPrivacy } : {}),
			...(source.compatibilityAndMigration !== undefined ? { compatibilityAndMigration: source.compatibilityAndMigration } : {}),
			...(source.alternatives !== undefined || source.alternativesConsidered !== undefined ? { alternativesConsidered: source.alternatives ?? source.alternativesConsidered } : {}),
		};
	} else {
		sections = {
			decision: source.decision,
			context: source.context,
			rationale: source.rationale,
			consequences: source.consequences,
			...(source.alternatives !== undefined || source.alternativesConsidered !== undefined ? { alternativesConsidered: source.alternatives ?? source.alternativesConsidered } : {}),
			...(source.revisitWhen !== undefined ? { revisitWhen: source.revisitWhen } : {}),
		};
	}
	return { id: artifact.id, type: kind, title, sections };
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
	if (task.briefSections !== undefined) {
		const brief = record(task.briefSections);
		const acceptance = record(task.acceptanceSections);
		const references = record(task.references);
		const assignment = record(task.assignment);
		const verification = record(task.verification);
		const tier = assignment.tier ?? "medium";
		assertTierJustification(tier, assignment.tierJustification);
		const stageId = task.stageId ?? task.id;
		const included = strings(brief.boundaryIncluded);
		const goal = brief.contributionGoal;
		return {
			manifest: {
				schemaVersion: 1, id: task.id, title: task.title ?? titleFromId(task.id), status: "draft", dependsOn: strings(task.dependsOn),
				references: { specs: references.specs === undefined ? qualifiedSpecificationIds(acceptance.criterionContributions) : strings(references.specs), designs: strings(references.designs), decisions: strings(references.decisions) },
				execution: { resourceClaims: strings(task.resourceClaims), assignment: { agent: assignment.agent ?? assignment.role ?? "implementer", tier, rationale: assignment.rationale ?? `Default ${tier} routing for a bounded contribution.`, ...(assignment.tierJustification !== undefined ? { tierJustification: assignment.tierJustification } : {}) } },
				assembly: { stageId, intermediateState: task.intermediateState ?? "complete" },
				verification: { timing: verification.timing ?? "task", methods: strings(verification.methods), taskChecks: strings(verification.taskChecks), rationale: verification.rationale ?? "Verify the contribution at its declared task boundary." },
			},
			narrativeSchemaVersion: 2,
			briefSections: { ...brief, contributionGoal: goal, boundaryIncluded: included, requiredWork: brief.requiredWork ?? included, integrationExpectation: brief.integrationExpectation ?? `Deliver this contribution for integration in stage ${String(stageId)}.` },
			acceptanceSections: { ...acceptance, deliverables: acceptance.deliverables ?? [goal] },
		};
	}
	const assignment = record(task.assignment);
	const verification = record(task.verification);
	const tier = assignment.tier ?? "medium";
	assertTierJustification(tier, assignment.tierJustification);
	const stageId = task.stageId ?? task.id;
	const included = strings(task.included);
	const goal = task.goal;
	const acceptance = strings(task.acceptance);
	const checks = strings(task.checks);
	return {
		manifest: {
			schemaVersion: 1,
			id: task.id,
			title: task.title ?? titleFromId(task.id),
			status: "draft",
			dependsOn: strings(task.dependsOn),
			execution: {
				resourceClaims: strings(task.resourceClaims),
				assignment: {
					agent: assignment.agent ?? assignment.role ?? "implementer",
					tier,
					rationale: assignment.rationale ?? `Default ${tier} routing for a bounded contribution.`,
					...(assignment.tierJustification !== undefined ? { tierJustification: assignment.tierJustification } : {}),
				},
			},
			assembly: {
				stageId,
				intermediateState: task.intermediateState ?? "complete",
			},
			verification: {
				timing: verification.timing ?? "task",
				methods: strings(verification.methods),
				taskChecks: checks,
				rationale: verification.rationale ?? "Verify the contribution at its declared task boundary.",
			},
		},
		narrativeSchemaVersion: 2,
		briefSections: {
			contributionGoal: goal,
			...(task.context !== undefined ? { context: task.context } : {}),
			boundaryIncluded: included,
			requiredWork: task.requiredWork ?? task.work ?? included,
			integrationExpectation: task.integrationExpectation ?? `Deliver this contribution for integration in stage ${String(stageId)}.`,
			...(task.excluded !== undefined ? { boundaryExcluded: task.excluded } : {}),
			...(task.interfaces !== undefined ? { interfacesAndDependencies: task.interfaces } : strings(task.dependsOn).length ? { interfacesAndDependencies: strings(task.dependsOn).map((id) => `Consumes the completed contribution from task ${id}.`) } : {}),
			...(task.constraints !== undefined ? { constraints: task.constraints } : {}),
			...(task.risks !== undefined ? { risksAndUncertainties: task.risks } : {}),
		},
		acceptanceSections: {
			deliverables: [goal],
			acceptance,
			boundaryProof: task.proof ?? acceptance,
			...(task.intermediateState === "partial" ? { expectedIntermediateState: task.integrationExpectation ?? `Partial contribution ready for stage ${String(stageId)}.` } : {}),
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
			...(evaluation.stageId !== undefined ? { stageId: evaluation.stageId } : {}),
			...(evaluation.dependsOn !== undefined ? { dependsOn: strings(evaluation.dependsOn) } : {}),
			scope: evaluation.scope ?? { workItem: workItemId },
			status: "planned",
			required: evaluation.required ?? true,
			attempt: 0,
			methods: strings(evaluation.methods),
			...(evaluation.criteria !== undefined ? { criteria: evaluation.criteria } : {}),
		},
	};
}

/** Accept a ticket-like evaluation description without exposing its lifecycle manifest. */
export function normalizeResourceEvaluation(value: unknown, workItemId: string): PlanAuthoringRecord {
	const evaluation = record(value);
	const type = evaluation.kind ?? evaluation.type;
	if (type === "e2e") throw new HarnessError("INVALID_ARTIFACT", "Final whole-branch journey verification is runtime-owned and must not be created by delivery planning. Use a focused deterministic, regression, migration, or review evaluation instead.");
	const explicitMethods = strings(evaluation.methods);
	const context = strings(evaluation.context).map((entry) => `Context: ${entry}`);
	const behavioralCriteria = strings(evaluation.criteria).filter((entry) => !/^[a-z0-9]+(?:-[a-z0-9]+)*#AC-\d{3}$/.test(entry)).map((entry) => `Verify: ${entry}`);
	const checks = strings(evaluation.checks).map((entry) => `Run: ${entry}`);
	const qualifiedCriteria = strings(evaluation.criteria).filter((entry) => /^[a-z0-9]+(?:-[a-z0-9]+)*#AC-\d{3}$/.test(entry));
	return {
		id: evaluation.id,
		type,
		scope: evaluation.scope ?? { workItem: workItemId },
		required: evaluation.required ?? true,
		methods: explicitMethods.length ? explicitMethods : [...context, ...behavioralCriteria, ...checks],
		...(qualifiedCriteria.length ? { criteria: qualifiedCriteria } : {}),
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
			...(workItem.workingBranch !== undefined ? { workingBranch: workItem.workingBranch } : {}),
			...(workItem.branchKind !== undefined ? { branchKind: workItem.branchKind } : {}),
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
		create: ["id", "title", "goal", "context", "included", "work", "requiredWork", "excluded", "interfaces", "constraints", "acceptance", "proof", "checks", "risks", "dependsOn", "stageId", "intermediateState", "integrationExpectation", "resourceClaims", "assignment", "verification", "references", "briefSections", "acceptanceSections"],
		update: ["title", "goal", "context", "included", "work", "requiredWork", "excluded", "interfaces", "constraints", "acceptance", "proof", "checks", "risks", "dependsOn", "stageId", "intermediateState", "integrationExpectation", "resourceClaims", "assignment", "verification", "references", "briefSections", "acceptanceSections"],
	},
	"integration-unit": { create: ["id", "tasks", "intermediatePolicy"], update: ["tasks", "intermediatePolicy"] },
	evaluation: { create: ["id", "type", "scope", "stageId", "dependsOn", "required", "methods", "criteria"], update: ["type", "scope", "stageId", "dependsOn", "required", "methods", "criteria"] },
};

function assertEditFields(type: CanonicalResourceType, action: "create" | "update", input: PlanAuthoringRecord): void {
	const allowed = new Set(type === "work-item" ? ["title", "kind", "intentSections"] : EDIT_FIELDS[type][action]);
	const unknown = Object.keys(input).filter((key) => !allowed.has(key));
	if (unknown.length) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for ${type} has unknown field(s): ${unknown.join(", ")}`);
	if (type === "task" && input.assignment !== undefined) {
		const unknownAssignment = Object.keys(record(input.assignment)).filter((key) => !["agent", "role", "tier", "rationale", "tierJustification"].includes(key));
		if (unknownAssignment.length) throw new HarnessError("INVALID_ARTIFACT", `Plan ${action} for task has unknown assignment field(s): ${unknownAssignment.join(", ")}`);
	}
	if (type === "task" && input.verification !== undefined) {
		const unknownVerification = Object.keys(record(input.verification)).filter((key) => !["timing", "methods", "rationale"].includes(key));
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
	if ((input.briefSections !== undefined) !== (input.acceptanceSections !== undefined)) throw new HarnessError("INVALID_ARTIFACT", `Legacy task update for ${ref} requires briefSections and acceptanceSections together`);
	const contractFields = ["goal", "context", "included", "work", "excluded", "interfaces", "constraints", "acceptance", "proof", "risks", "integrationExpectation"];
	if (!contractFields.some((field) => input[field] !== undefined)) return;
	for (const required of ["goal", "included", "acceptance"]) {
		if (input[required] === undefined) throw new HarnessError("INVALID_ARTIFACT", `Plan task contract update for ${ref} requires ${required} so the executor packet remains self-contained`);
	}
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
			...(verification !== undefined || input.checks !== undefined ? { verification: definedEntries({ ...verification, taskChecks: input.checks }) } : {}),
		});
		const hasContract = input.goal !== undefined || input.briefSections !== undefined;
		const normalized = hasContract ? normalizePlanTask({ ...input, id: ref.slice(ref.lastIndexOf(":") + 1) }) : undefined;
		const patch = definedEntries({
			...(Object.keys(manifest).length ? { manifest } : {}),
			...(normalized ? { briefSections: normalized.briefSections, acceptanceSections: normalized.acceptanceSections, narrativeSchemaVersion: 2 } : {}),
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
