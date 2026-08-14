import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { reconcileReportedAgents } from "./agent-reconciliation.js";
import { isAgentProcessActive, SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { loadHarnessConfig } from "./config.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { registerExplorationCapabilities } from "./exploration-capabilities.js";
import { validateExplorationAssignment, validateExplorationHandoff, type ExplorationAssignment, type ExplorationHandoff } from "./exploration-contracts.js";
import { RepositoryEventStore } from "./event-store.js";
import { isEvaluatorProcess, registerEvaluatorCapabilities } from "./evaluator-capabilities.js";
import { HarnessRunStore } from "./run-store.js";
import { scaffoldHarness, type HarnessScaffoldProfile } from "./scaffold.js";
import { LaunchCoordinator } from "../workflow-runtime/launch-coordinator.js";
import { resolveHarnessModel } from "./model-resolver.js";
import { IdempotencyStore, RepositoryMutex } from "./idempotency.js";
import { buildReviewPersistentContext, buildTaskPersistentContext } from "./implementation-context.js";
import { OrchestratorResourceService, parseResourceRef, type CanonicalResourceType, type PlanEdit } from "./orchestrator-resources.js";
import { normalizePlanBundle, normalizePlanEdit } from "./plan-authoring.js";
import { paginateCatalog, sliceText } from "./progressive-disclosure.js";
import { assertCleanRepository, atomicWriteFile, discoverRepository, readTextIfExists, runGit, type RepositoryIdentity } from "./repository.js";
import { isTierTaskAssignment, taskAgentName, type CapabilityTier, type Deliberation, type HarnessEffort, type HarnessStatusSnapshot, type MutationAuthority, type TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { isWorkerProcess, registerWorkerCapabilities } from "./worker-capabilities.js";
import { SubagentSupervisor } from "./supervisor.js";
import { ResourceLockSet, WorktreeManager } from "./worktrees.js";
import { WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, type DynamicSubagentRequest, type WorkflowAdapterDiscovery, type WorkflowRunResult } from "../workflow-runtime/api.js";
import { createHarnessWorkflowAdapter } from "./workflow-adapter.js";
import { BUILT_IN_AGENT_ROOT, readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";

const WORKFLOW_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

const WORKER_TOOL_NAMES = new Set([
	"task_clarify",
	"task_checkpoint",
	"task_request_change",
	"task_report_decision",
	"task_blocked",
	"task_complete",
]);
const EVALUATOR_TOOL_NAMES = new Set(["evaluation_context", "evidence_record", "finding_report", "evaluation_checkpoint", "evaluation_complete"]);
const EXPLORATION_TOOL_NAMES = new Set(["exploration_context", "exploration_checkpoint", "exploration_blocked", "exploration_complete"]);
const isSubagentProcess = () => Boolean(process.env.PIBOX_SUBAGENT_ID);
const ORCHESTRATOR_CONTRACT = readBuiltInPrompt("orchestrator-routing");

const ORCHESTRATOR_TOOL_NAMES = new Set([
	"workflow_status",
	"workflow_list",
	"workflow_get",
	"workflow_schema",
	"workflow_plan_write",
	"workflow_create",
	"workflow_patch",
	"workflow_delete",
	"workflow_apply_change",
	"workflow_transition",
	"workflow_init",
	"exploration_launch",
	"task_integrate",
	"evaluation_record",
	"work_item_complete",
]);

interface HarnessRuntime {
	identity: RepositoryIdentity;
	events: RepositoryEventStore;
	workItems: WorkItemStore;
	config: ReturnType<typeof loadHarnessConfig>["config"];
	operations: IdempotencyStore;
	mutex: RepositoryMutex;
	agents: SessionAgentRegistry;
	coordinator: LaunchCoordinator;
	sessionId: string;
	mainAgentId: string;
}

const textResult = (text: string, details: unknown = null) => ({
	content: [{ type: "text" as const, text }],
	details,
});
const CANONICAL_RESOURCE_TYPE = Type.Union([Type.Literal("work-item"), Type.Literal("artifact"), Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("evaluation")]);
const LISTABLE_RESOURCE_TYPE = Type.Union([CANONICAL_RESOURCE_TYPE, Type.Literal("agent"), Type.Literal("message"), Type.Literal("run")]);
const MUTATION_AUTHORITY = Type.Object({
	rationale: Type.String(),
	sources: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
const EFFORT = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
const CAPABILITY_TIER = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("max")]);
const DELIBERATION = Type.Union([Type.Literal("standard"), Type.Literal("deep")]);
const TASK_MANIFEST_RESOURCE = Type.Object({
	schemaVersion: Type.Literal(1), id: Type.String({ description: "Bare kebab-case task id" }), title: Type.String(),
	status: Type.Union([Type.Literal("draft"), Type.Literal("blocked"), Type.Literal("ready")]),
	dependsOn: Type.Array(Type.String()),
	references: Type.Object({ specs: Type.Array(Type.String()), designs: Type.Array(Type.String()), decisions: Type.Array(Type.String()) }, { additionalProperties: false }),
	execution: Type.Object({
		resourceClaims: Type.Array(Type.String({ description: "Shared files or external resources used to validate parallel-stage compatibility" })),
		assignment: Type.Object({
			agent: Type.String({ description: "Configured agent definition, normally implementer" }),
			tier: CAPABILITY_TIER,
			deliberation: DELIBERATION,
			modelOverride: Type.Optional(Type.Object({
				model: Type.String({ description: "Exceptional configured concrete model pin required by the user" }),
				effort: Type.Optional(EFFORT),
				strict: Type.Optional(Type.Boolean()),
			}, { additionalProperties: false })),
			rationale: Type.String({ description: "Why this task needs the selected capability tier and deliberation profile after decomposition" }),
		}, { additionalProperties: false }),
	}, { additionalProperties: false }),
	assembly: Type.Object({ stageId: Type.Optional(Type.String()), integrationUnit: Type.Optional(Type.String({ description: "Legacy alias for stageId" })), intermediateState: Type.Union([Type.Literal("complete"), Type.Literal("partial")]) }, { additionalProperties: false }),
	verification: Type.Object({ timing: Type.Union([Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("work-item"), Type.Literal("skipped")]), methods: Type.Array(Type.String()), taskChecks: Type.Array(Type.String()), rationale: Type.String() }, { additionalProperties: false }),
}, { additionalProperties: false });
const EVALUATION_MANIFEST_RESOURCE = Type.Object({
	schemaVersion: Type.Literal(1), id: Type.String(), type: Type.Union([Type.Literal("deterministic"), Type.Literal("spec-review"), Type.Literal("quality-review"), Type.Literal("combined-review"), Type.Literal("regression"), Type.Literal("e2e")]),
	scope: Type.Union([Type.Object({ task: Type.String() }, { additionalProperties: false }), Type.Object({ integrationUnit: Type.String() }, { additionalProperties: false }), Type.Object({ workItem: Type.String() }, { additionalProperties: false })]),
	status: Type.Literal("planned"), required: Type.Boolean(), attempt: Type.Literal(0), methods: Type.Array(Type.String()), criteria: Type.Optional(Type.Array(Type.String({ description: "Qualified artifact-id#AC-NNN reference; omit when no specification criterion applies" }))),
}, { additionalProperties: false });
const INTENT_SECTIONS = Type.Object({ problem: Type.String(), desiredOutcome: Type.String(), scopeIncluded: Type.Array(Type.String()), successSignals: Type.Array(Type.String()), scopeExcluded: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), assumptions: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const DELIVERY_CONTRACT = Type.Object({ branchType: Type.Union([Type.Literal("feature"), Type.Literal("fix")]), branchMode: Type.Union([Type.Literal("create"), Type.Literal("continue")]), baseBranch: Type.Literal("develop"), featureBranch: Type.Optional(Type.String({ description: "Required for continue; optional for create, which defaults to <branchType>/<work-item-id>" })) }, { additionalProperties: false });
const SPEC_SECTIONS = Type.Object({ context: Type.String(), actors: Type.Optional(Type.Array(Type.String())), requiredBehaviors: Type.Array(Type.String()), acceptanceCriteria: Type.Array(Type.Object({ id: Type.String({ description: "AC-NNN" }), statement: Type.String() }, { additionalProperties: false })), constraints: Type.Optional(Type.Array(Type.String())), edgeCases: Type.Optional(Type.Array(Type.String())), assumptions: Type.Optional(Type.Array(Type.String())), outOfScope: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const DESIGN_SECTIONS = Type.Object({ designGoal: Type.String(), chosenApproach: Type.Array(Type.String()), verificationBoundaries: Type.Array(Type.String()), componentsAndInterfaces: Type.Optional(Type.Array(Type.String())), dataAndControlFlow: Type.Optional(Type.Array(Type.String())), failureAndRecovery: Type.Optional(Type.Array(Type.String())), securityAndPrivacy: Type.Optional(Type.Array(Type.String())), compatibilityAndMigration: Type.Optional(Type.Array(Type.String())), alternativesConsidered: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const DECISION_SECTIONS = Type.Object({ decision: Type.String(), context: Type.String(), rationale: Type.String(), consequences: Type.Array(Type.String()), alternativesConsidered: Type.Optional(Type.Array(Type.String())), revisitWhen: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const TASK_BRIEF_SECTIONS = Type.Object({ contributionGoal: Type.String(), boundaryIncluded: Type.Array(Type.String()), requiredWork: Type.Array(Type.String()), integrationExpectation: Type.String(), boundaryExcluded: Type.Optional(Type.Array(Type.String())), interfacesAndDependencies: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), risksAndUncertainties: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const TASK_ACCEPTANCE_SECTIONS = Type.Object({ deliverables: Type.Array(Type.String()), criterionContributions: Type.Array(Type.Union([Type.String(), Type.Object({ criteria: Type.Array(Type.String({ description: "Qualified artifact#AC-NNN references" })), contribution: Type.String() }, { additionalProperties: false })])), boundaryProof: Type.Array(Type.String()), expectedIntermediateState: Type.Optional(Type.String()), integrationProof: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const WORK_ITEM_RESOURCE_BODY = Type.Union([
	Type.Object({ id: Type.String(), title: Type.String(), kind: Type.Union([Type.Literal("change"), Type.Literal("story")]), delivery: DELIVERY_CONTRACT, narrativeSchemaVersion: Type.Literal(2), intentSections: INTENT_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), title: Type.String(), kind: Type.Union([Type.Literal("change"), Type.Literal("story")]), delivery: DELIVERY_CONTRACT, intent: Type.String() }, { additionalProperties: false }),
]);
const ARTIFACT_RESOURCE_BODY = Type.Union([
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("spec"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: SPEC_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("design"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: DESIGN_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("decision"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: DECISION_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Union([Type.Literal("spec"), Type.Literal("design"), Type.Literal("decision")]), content: Type.String() }, { additionalProperties: false }),
]);
const TASK_RESOURCE_BODY = Type.Union([
	Type.Object({ manifest: TASK_MANIFEST_RESOURCE, brief: Type.String(), acceptance: Type.String() }, { additionalProperties: false }),
	Type.Object({ manifest: TASK_MANIFEST_RESOURCE, narrativeSchemaVersion: Type.Literal(2), briefSections: TASK_BRIEF_SECTIONS, acceptanceSections: TASK_ACCEPTANCE_SECTIONS }, { additionalProperties: false }),
]);
const INTEGRATION_UNIT_RESOURCE_BODY = Type.Object({ id: Type.String(), tasks: Type.Array(Type.String({ description: "Bare task id in this work item, not a resource reference" })), intermediatePolicy: Type.Union([Type.Literal("coherent"), Type.Literal("partial-allowed")]) }, { additionalProperties: false });
const EVALUATION_RESOURCE_BODY = Type.Object({ manifest: EVALUATION_MANIFEST_RESOURCE }, { additionalProperties: false });
const CANONICAL_PLAN_BUNDLE = Type.Object({
	workItem: WORK_ITEM_RESOURCE_BODY,
	artifacts: Type.Array(ARTIFACT_RESOURCE_BODY),
	tasks: Type.Array(TASK_RESOURCE_BODY),
	integrationUnits: Type.Array(INTEGRATION_UNIT_RESOURCE_BODY),
	evaluations: Type.Array(EVALUATION_RESOURCE_BODY),
}, { additionalProperties: false });

// Planner-facing authoring contracts omit harness-owned lifecycle and schema
// boilerplate. Normalization restores the complete canonical shape before write.
const PLAN_WORK_ITEM = Type.Object({
	id: Type.String({ description: "Bare kebab-case work-item id" }),
	title: Type.String(),
	kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])),
	delivery: Type.Object({
		branchType: Type.Union([Type.Literal("feature"), Type.Literal("fix")]),
		branchMode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("continue")])),
		featureBranch: Type.Optional(Type.String({ description: "Required only when branchMode=continue" })),
	}, { additionalProperties: false }),
	intentSections: INTENT_SECTIONS,
}, { additionalProperties: false });
const PLAN_ARTIFACT = Type.Union([
	Type.Object({ id: Type.String(), type: Type.Literal("spec"), title: Type.Optional(Type.String()), sections: SPEC_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Literal("design"), title: Type.Optional(Type.String()), sections: DESIGN_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Literal("decision"), title: Type.Optional(Type.String()), sections: DECISION_SECTIONS }, { additionalProperties: false }),
]);
const PLAN_TASK = Type.Object({
	id: Type.String({ description: "Bare kebab-case task id" }),
	title: Type.Optional(Type.String()),
	dependsOn: Type.Optional(Type.Array(Type.String())),
	references: Type.Optional(Type.Object({ specs: Type.Optional(Type.Array(Type.String())), designs: Type.Optional(Type.Array(Type.String())), decisions: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })),
	stageId: Type.Optional(Type.String({ description: "Defaults to the task id, producing a safe singleton stage" })),
	intermediateState: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("partial")])),
	resourceClaims: Type.Optional(Type.Array(Type.String())),
	assignment: Type.Optional(Type.Object({
		agent: Type.Optional(Type.String()), tier: Type.Optional(CAPABILITY_TIER), deliberation: Type.Optional(DELIBERATION),
		modelOverride: Type.Optional(Type.Object({ model: Type.String(), effort: Type.Optional(EFFORT), strict: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
		rationale: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	verification: Type.Optional(Type.Object({
		timing: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("work-item"), Type.Literal("skipped")])),
		methods: Type.Optional(Type.Array(Type.String())), taskChecks: Type.Optional(Type.Array(Type.String())), rationale: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	briefSections: Type.Object({
		contributionGoal: Type.String(), boundaryIncluded: Type.Array(Type.String()),
		requiredWork: Type.Optional(Type.Array(Type.String())), integrationExpectation: Type.Optional(Type.String()),
		boundaryExcluded: Type.Optional(Type.Array(Type.String())), interfacesAndDependencies: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), risksAndUncertainties: Type.Optional(Type.Array(Type.String())),
	}, { additionalProperties: false }),
	acceptanceSections: Type.Object({
		deliverables: Type.Optional(Type.Array(Type.String())),
		criterionContributions: Type.Array(Type.Object({ criteria: Type.Array(Type.String({ description: "Qualified artifact#AC-NNN references" })), contribution: Type.String() }, { additionalProperties: false })),
		boundaryProof: Type.Array(Type.String()), expectedIntermediateState: Type.Optional(Type.String()), integrationProof: Type.Optional(Type.Array(Type.String())),
	}, { additionalProperties: false }),
}, { additionalProperties: false });
const PLAN_INTEGRATION_UNIT = Type.Object({ id: Type.String(), tasks: Type.Array(Type.String()), intermediatePolicy: Type.Optional(Type.Union([Type.Literal("coherent"), Type.Literal("partial-allowed")])) }, { additionalProperties: false });
const PLAN_EVALUATION = Type.Object({
	id: Type.String(), type: Type.Union([Type.Literal("deterministic"), Type.Literal("spec-review"), Type.Literal("quality-review"), Type.Literal("combined-review"), Type.Literal("regression"), Type.Literal("e2e")]),
	scope: Type.Optional(Type.Union([Type.Object({ task: Type.String() }, { additionalProperties: false }), Type.Object({ integrationUnit: Type.String() }, { additionalProperties: false }), Type.Object({ workItem: Type.String() }, { additionalProperties: false })])),
	required: Type.Optional(Type.Boolean()), methods: Type.Array(Type.String()), criteria: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
const PLAN_BUNDLE = Type.Object({
	workItem: PLAN_WORK_ITEM,
	artifacts: Type.Optional(Type.Array(PLAN_ARTIFACT)),
	tasks: Type.Array(PLAN_TASK),
	integrationUnits: Type.Optional(Type.Array(PLAN_INTEGRATION_UNIT)),
	evaluations: Type.Optional(Type.Array(PLAN_EVALUATION)),
}, { additionalProperties: false });
const PLAN_EDIT = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
	ref: Type.String({ description: "Exact child resource ref within target; target itself for a work-item update" }),
	value: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Compact resource body for create, or only changed fields for update; omit for delete" })),
}, { additionalProperties: false });
const PLAN_WRITE_PARAMETERS = Type.Object({
	mode: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("edit")]),
	basedOn: Type.Optional(Type.String({ description: "Create only: optional existing work-item ref used as read-only background; it is never mutated" })),
	target: Type.Optional(Type.String({ description: "Update/edit: exact existing work-item ref" })),
	expectedRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Update/edit: revision read before writing" })),
	plan: Type.Optional(PLAN_BUNDLE),
	edits: Type.Optional(Type.Array(PLAN_EDIT, { minItems: 1 })),
}, { additionalProperties: false });
const CREATE_OPERATION_VARIANTS = [
	Type.Object({ method: Type.Literal("create"), resource: Type.Literal("work-item"), body: WORK_ITEM_RESOURCE_BODY, authority: Type.Optional(MUTATION_AUTHORITY) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("create"), resource: Type.Literal("artifact"), parent: Type.String(), body: ARTIFACT_RESOURCE_BODY, authority: Type.Optional(MUTATION_AUTHORITY) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("create"), resource: Type.Literal("task"), parent: Type.String(), body: TASK_RESOURCE_BODY, authority: Type.Optional(MUTATION_AUTHORITY) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("create"), resource: Type.Literal("integration-unit"), parent: Type.String(), body: INTEGRATION_UNIT_RESOURCE_BODY, authority: Type.Optional(MUTATION_AUTHORITY) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("create"), resource: Type.Literal("evaluation"), parent: Type.String(), body: EVALUATION_RESOURCE_BODY, authority: Type.Optional(MUTATION_AUTHORITY) }, { additionalProperties: false }),
] as const;
const TASK_MANIFEST_PATCH = Type.Object({ title: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String())), references: Type.Optional(Type.Record(Type.String(), Type.Unknown())), execution: Type.Optional(Type.Record(Type.String(), Type.Unknown())), assembly: Type.Optional(Type.Record(Type.String(), Type.Unknown())), verification: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false });
const TASK_PATCH_BODY = Type.Object({
	manifest: Type.Optional(TASK_MANIFEST_PATCH), title: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String())), references: Type.Optional(Type.Partial(Type.Object({ specs: Type.Array(Type.String()), designs: Type.Array(Type.String()), decisions: Type.Array(Type.String()) }))), execution: Type.Optional(Type.Record(Type.String(), Type.Unknown())), assembly: Type.Optional(Type.Record(Type.String(), Type.Unknown())), verification: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	brief: Type.Optional(Type.String()), acceptance: Type.Optional(Type.String()), narrativeSchemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), briefSections: Type.Optional(TASK_BRIEF_SECTIONS), acceptanceSections: Type.Optional(TASK_ACCEPTANCE_SECTIONS),
}, { additionalProperties: false });
const PATCH_RESOURCE_PARAMETERS = Type.Union([
	Type.Object({ resource: Type.Literal("work-item"), ref: Type.String(), patch: Type.Object({ title: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])), delivery: Type.Optional(DELIVERY_CONTRACT), intent: Type.Optional(Type.String()), narrativeSchemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), intentSections: Type.Optional(INTENT_SECTIONS) }, { additionalProperties: false }), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("artifact"), ref: Type.String(), patch: Type.Object({ type: Type.Optional(Type.Union([Type.Literal("spec"), Type.Literal("design"), Type.Literal("decision")])), narrativeSchemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), title: Type.Optional(Type.String()), content: Type.Optional(Type.String()), sections: Type.Optional(Type.Record(Type.String(), Type.Unknown())), links: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("task"), ref: Type.String(), patch: TASK_PATCH_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("integration-unit"), ref: Type.String(), patch: Type.Partial(INTEGRATION_UNIT_RESOURCE_BODY), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("evaluation"), ref: Type.String(), patch: Type.Object({ manifest: Type.Partial(EVALUATION_MANIFEST_RESOURCE) }, { additionalProperties: false }), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
]);
const PATCH_OPERATION_VARIANTS = [
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("work-item"), ref: Type.String(), patch: Type.Object({ title: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])), delivery: Type.Optional(DELIVERY_CONTRACT), intent: Type.Optional(Type.String()), intentSections: Type.Optional(INTENT_SECTIONS) }, { additionalProperties: false }) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("artifact"), ref: Type.String(), patch: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("task"), ref: Type.String(), patch: TASK_PATCH_BODY }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("integration-unit"), ref: Type.String(), patch: Type.Partial(INTEGRATION_UNIT_RESOURCE_BODY) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("evaluation"), ref: Type.String(), patch: Type.Object({ manifest: Type.Partial(EVALUATION_MANIFEST_RESOURCE) }, { additionalProperties: false }) }, { additionalProperties: false }),
] as const;
const CREATE_RESOURCE_PARAMETERS = Type.Union([
	Type.Object({ resource: Type.Literal("work-item"), body: WORK_ITEM_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("artifact"), parent: Type.String(), body: ARTIFACT_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("task"), parent: Type.String(), body: TASK_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("integration-unit"), parent: Type.String(), body: INTEGRATION_UNIT_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("evaluation"), parent: Type.String(), body: EVALUATION_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
]);
const APPLY_CHANGE_PARAMETERS = Type.Object({
	authority: MUTATION_AUTHORITY,
	executionDisposition: Type.Union([Type.Literal("continue"), Type.Literal("resume-requesting-agent"), Type.Literal("restart-affected"), Type.Literal("pause-affected")]),
	operations: Type.Array(Type.Union([
		...CREATE_OPERATION_VARIANTS,
		...PATCH_OPERATION_VARIANTS,
		Type.Object({ method: Type.Literal("delete"), ref: Type.String() }, { additionalProperties: false }),
	])),
	response: Type.Optional(Type.Object({ agentId: Type.String(), messageId: Type.String(), text: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });

// Keep the always-visible mutation schemas small. Exact per-resource schemas are
// available on demand through workflow_schema and are revalidated before mutation.
const OPEN_OBJECT = Type.Record(Type.String(), Type.Unknown());
const COMPACT_PLAN_WRITE_PARAMETERS = Type.Object({
	mode: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("edit")]),
	basedOn: Type.Optional(Type.String()),
	target: Type.Optional(Type.String()),
	expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	plan: Type.Optional(OPEN_OBJECT),
	edits: Type.Optional(Type.Array(Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]), ref: Type.String(), value: Type.Optional(OPEN_OBJECT) }, { additionalProperties: false }))),
}, { additionalProperties: false });
const COMPACT_CREATE_PARAMETERS = Type.Object({ resource: CANONICAL_RESOURCE_TYPE, parent: Type.Optional(Type.String()), body: OPEN_OBJECT, authority: MUTATION_AUTHORITY }, { additionalProperties: false });
const COMPACT_PATCH_PARAMETERS = Type.Object({ resource: CANONICAL_RESOURCE_TYPE, ref: Type.String(), patch: OPEN_OBJECT, authority: MUTATION_AUTHORITY }, { additionalProperties: false });
const COMPACT_APPLY_CHANGE_PARAMETERS = Type.Object({
	authority: MUTATION_AUTHORITY,
	executionDisposition: Type.Union([Type.Literal("continue"), Type.Literal("resume-requesting-agent"), Type.Literal("restart-affected"), Type.Literal("pause-affected")]),
	operations: Type.Array(Type.Object({ method: Type.Union([Type.Literal("create"), Type.Literal("patch"), Type.Literal("delete")]), resource: Type.Optional(CANONICAL_RESOURCE_TYPE), parent: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), body: Type.Optional(OPEN_OBJECT), patch: Type.Optional(OPEN_OBJECT) }, { additionalProperties: false })),
	response: Type.Optional(Type.Object({ agentId: Type.String(), messageId: Type.String(), text: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });

function assertExactSchema(schema: any, value: unknown, label: string): void {
	if (Check(schema, value)) return;
	const problems = [...Errors(schema, value)].slice(0, 4).map((error) => `${error.instancePath || "/"} ${error.message}`);
	throw new HarnessError("INVALID_ARTIFACT", `${label} does not match its exact resource schema: ${problems.join("; ")}. Call workflow_schema for the bounded contract.`);
}

function createdResourceRef(resource: CanonicalResourceType, parent: string | undefined, body: Record<string, any>): string {
	if (resource === "work-item") return `work-item:${body.id}`;
	if (!parent) throw new HarnessError("INVALID_ARTIFACT", `${resource} creation requires parent`);
	const workItemId = parseResourceRef(parent).workItemId;
	const id = resource === "task" || resource === "evaluation" ? body.manifest?.id : body.id;
	if (typeof id !== "string") throw new HarnessError("INVALID_ARTIFACT", `${resource} body is missing its id`);
	return `work-item:${workItemId}/${resource}:${id}`;
}

async function mutationReceipt(runtime: HarnessRuntime, commit: string | undefined, changes: Array<{ action: "create" | "patch" | "delete" | "transition"; ref: string }>, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const affectedIds = [...new Set(changes.map((change) => parseResourceRef(change.ref).workItemId))];
	const affected = [];
	for (const id of affectedIds) {
		const item = await runtime.workItems.read(id).catch((error) => error instanceof HarnessError && error.code === "WORK_ITEM_NOT_FOUND" ? undefined : Promise.reject(error));
		if (item) affected.push({ ref: `work-item:${id}`, revision: item.planning.revision, state: item.state });
	}
	return { ok: true, ...(commit ? { commit } : {}), changes, affected, ...extra };
}

function schemaFor(operation: "create" | "patch" | "apply-change" | "plan-write", resource?: CanonicalResourceType): unknown {
	if (operation === "plan-write") return PLAN_WRITE_PARAMETERS;
	if (operation === "apply-change") return APPLY_CHANGE_PARAMETERS;
	if (!resource) throw new HarnessError("INVALID_ARTIFACT", `resource is required for the ${operation} schema`);
	const variants = operation === "create" ? CREATE_RESOURCE_PARAMETERS.anyOf : PATCH_RESOURCE_PARAMETERS.anyOf;
	const selected = variants.find((variant: any) => variant.properties?.resource?.const === resource);
	if (!selected) throw new HarnessError("INVALID_ARTIFACT", `No ${operation} schema is available for ${resource}`);
	return selected;
}

function structuredCapabilityError(error: unknown, ref?: string): Error {
	const harness = error instanceof HarnessError ? error : undefined;
	const code = harness?.code ?? "INTERNAL_ERROR";
	const allowedActions = code === "WORK_ITEM_EXISTS" ? ["get", "patch", "transition"] : code === "CAPABILITY_DENIED" ? ["get", "reopen", "supersede"] : ["get", "patch"];
	const message = error instanceof Error ? error.message : String(error);
	return new Error(JSON.stringify({ ok: false, code, message, ...(ref ? { resourceRef: ref } : {}), allowedActions, conflicts: [], retryable: false }));
}

async function createRuntime(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Promise<HarnessRuntime> {
	const identity = await discoverRepository(ctx.cwd);
	const loaded = loadHarnessConfig(identity.root);
	const events = new RepositoryEventStore(identity);
	await events.initialize();
	const sessionId = ctx.sessionManager.getSessionId();
	const mainAgentId = `main:${sessionId}`;
	const agents = new SessionAgentRegistry(identity.privateRoot, sessionId, loaded.config.limits.maxActiveSubagentsPerSession, loaded.config.limits.maxSubagentDepth);
	await agents.initialize(mainAgentId);
	return {
		identity,
		events,
		workItems: new WorkItemStore(identity.root),
		config: loaded.config,
		operations: new IdempotencyStore(identity.privateRoot),
		mutex: new RepositoryMutex(identity.privateRoot),
		agents,
		coordinator: new LaunchCoordinator(agents, mainAgentId, undefined, [WORKFLOW_EXTENSION_PATH]),
		sessionId,
		mainAgentId,
	};
}

async function idempotentMutation<T>(runtime: HarnessRuntime, operationId: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
	return runtime.operations.execute(operationId, payload, () => runtime.mutex.run(operationId, operation));
}

function resolveConfiguredPath(repositoryRoot: string, configuredPath: string): string | undefined {
	const candidates = isAbsolute(configuredPath)
		? [configuredPath]
		: [join(repositoryRoot, ".pi", configuredPath), join(homedir(), ".pi", "agent", "harness", configuredPath)];
	return candidates.find((candidate) => existsSync(candidate));
}

function requireTrusted(ctx: ExtensionContext): void {
	if (isWorkerProcess()) throw new HarnessError("CAPABILITY_DENIED", "Worker runs cannot invoke orchestrator capabilities");
	if (!ctx.isProjectTrusted()) throw new HarnessError("CAPABILITY_DENIED", "Workflow mutations require a trusted repository");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = -1;
	do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

async function snapshot(runtime: HarnessRuntime): Promise<HarnessStatusSnapshot> {
	const workItems = await runtime.workItems.list();
	const taskCounts: Record<string, Record<string, number>> = {};
	const runs: HarnessStatusSnapshot["runs"] = [];
	for (const item of workItems) {
		const counts: Record<string, number> = {};
		for (const task of item.tasks) {
			const manifest = await runtime.workItems.readTask(item.id, task.id);
			counts[manifest.status] = (counts[manifest.status] ?? 0) + 1;
		}
		taskCounts[item.id] = counts;
		for (const run of await new HarnessRunStore(runtime.identity.privateRoot, item.id).list()) {
			runs.push({
				id: run.id,
				workItemId: item.id,
				role: run.role,
				state: run.state,
				...(run.taskId ? { taskId: run.taskId } : {}),
				...(run.resolvedModel ? { model: `${run.resolvedProvider}/${run.resolvedModel}:${run.resolvedEffort}` } : {}),
			});
		}
	}
	const agents = (await runtime.agents.list()).map((agent) => ({
		id: agent.id,
		role: agent.role,
		state: agent.state,
		model: `${agent.provider}/${agent.model}:${agent.effort}`,
		processActive: isAgentProcessActive(agent),
		...(agent.runId ? { runId: agent.runId } : {}),
		...(agent.taskId ? { taskId: agent.taskId } : {}),
		...(agent.evaluationId ? { evaluationId: agent.evaluationId } : {}),
	}));
	return { repositoryRoot: runtime.identity.root, repositoryId: runtime.identity.id, workItems, taskCounts, runs, agents };
}

async function reconcileSessionAgents(runtime: HarnessRuntime): Promise<{ reported: number; interrupted: number; ambiguous: number }> {
	const result = { reported: 0, interrupted: 0, ambiguous: 0 };
	for (const agent of await runtime.agents.list()) {
		if (["completed", "failed", "protocol_failed", "cancelled", "waiting_model", "waiting_capacity", "waiting_decision", "blocked", "paused", "reported"].includes(agent.state)) continue;
		const agentRoot = join(runtime.agents.root, "agents", agent.id);
		let hasHandoff = Boolean(await readTextIfExists(join(agentRoot, "handoff.json")));
		if (!hasHandoff && agent.workItemId && agent.runId) {
			const runs = new HarnessRunStore(runtime.identity.privateRoot, agent.workItemId);
			hasHandoff = agent.evaluationId ? Boolean(await runs.readEvaluationHandoff(agent.runId).catch(() => undefined)) : Boolean(await runs.readHandoff(agent.runId).catch(() => undefined));
		}
		if (hasHandoff) {
			await runtime.agents.transition(agent.id, "reported", { summary: agent.summary ?? "Recovered durable handoff" }).catch(() => undefined);
			result.reported += 1;
			continue;
		}
		const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
		if (!attempt) continue;
		const attemptRoot = join(agentRoot, "attempts", attempt.id);
		const processExit = await readTextIfExists(join(attemptRoot, "process-exit.json"));
		const finalResult = await readTextIfExists(join(attemptRoot, "result.json"));
		if (processExit && finalResult && !agent.taskId && !agent.evaluationId && agent.role !== "explorer") {
			const summary = (JSON.parse(finalResult) as { text?: string }).text ?? "Background specialist completed";
			await runtime.agents.transition(agent.id, "reported", { summary }).catch(() => undefined);
			await runtime.agents.transition(agent.id, "completed", { summary }).catch(() => undefined);
			result.reported += 1;
			continue;
		}
		const heartbeatText = await readTextIfExists(join(attemptRoot, "heartbeat.json"));
		const heartbeat = heartbeatText ? JSON.parse(heartbeatText) as { attemptId?: string; pid?: number; at?: string } : undefined;
		const fresh = heartbeat?.attemptId === attempt.id && heartbeat.at !== undefined && Date.now() - Date.parse(heartbeat.at) < 15_000;
		let alive = false;
		if (heartbeat?.pid) {
			try { process.kill(heartbeat.pid, 0); alive = true; } catch { alive = false; }
		}
		if (fresh && alive) continue;
		if (alive) {
			await runtime.agents.transition(agent.id, "recovery_required", { error: "Process PID exists but its scoped heartbeat is stale" }).catch(() => undefined);
			result.ambiguous += 1;
		} else {
			await runtime.agents.transition(agent.id, "interrupted", { error: "Child process exited without a valid handoff" }).catch(() => undefined);
			result.interrupted += 1;
		}
	}
	return result;
}

function formatStatus(status: HarnessStatusSnapshot): string {
	if (status.workItems.length === 0) return `Workflow: no managed work items\nRepository: ${status.repositoryRoot}`;
	const lines = status.workItems.map((item) => {
		const counts = status.taskCounts[item.id] ?? {};
		const tasks = Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(" · ");
		return `${item.id} · ${item.kind} · ${item.phase}/${item.state} · plan r${item.planning.revision}${tasks ? ` · ${tasks}` : ""}`;
	});
	const activeAgents = status.agents.filter((agent) => agent.processActive);
	const attentionAgents = status.agents.filter((agent) => !agent.processActive && !["completed", "failed", "protocol_failed", "cancelled"].includes(agent.state));
	const active = status.runs.filter((run) => {
		if (run.state.startsWith("waiting_")) return true;
		if (run.state !== "running") return false;
		const agent = status.agents.find((candidate) => candidate.runId === run.id);
		return !agent || agent.processActive;
	});
	return [
		`Workflow: ${status.workItems.length} managed work item${status.workItems.length === 1 ? "" : "s"}`,
		...lines,
		...(activeAgents.length ? [`Subagents: ${activeAgents.length} running · ${activeAgents.map((agent) => `${agent.role}=${agent.state}`).join(" · ")}`] : []),
		...(attentionAgents.length ? [`Subagents needing attention: ${attentionAgents.length} · ${attentionAgents.map((agent) => `${agent.role}=${agent.state}`).join(" · ")}`] : []),
		...(active.length ? [`Legacy runs: ${active.map((run) => `${run.taskId ?? run.id}=${run.state}`).join(" · ")}`] : []),
	].join("\n");
}

export default function workflow(pi: ExtensionAPI): void {
	let sessionRuntime: HarnessRuntime | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	const supervisor = new SubagentSupervisor();
	registerWorkerCapabilities(pi);
	registerEvaluatorCapabilities(pi);
	registerExplorationCapabilities(pi);

	const runtimeFor = async (ctx: ExtensionContext): Promise<HarnessRuntime> => {
		if (sessionRuntime?.identity.root === ctx.cwd || sessionRuntime?.identity.root === (await discoverRepository(ctx.cwd)).root) {
			return sessionRuntime;
		}
		return createRuntime(ctx);
	};

	const launchManagedTask = async (
		ctx: ExtensionContext,
		workItemId: string,
		taskId: string,
		signal?: AbortSignal,
		onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
	) => {
		let locks: ResourceLockSet | undefined;
		try {
			requireTrusted(ctx);
			const runtime = await runtimeFor(ctx);
			const item = await runtime.workItems.read(workItemId);
			const task = await runtime.workItems.readTask(workItemId, taskId);
			if (task.status !== "ready" && task.status !== "failed" && task.status !== "protocol_failed" && task.status !== "running" && task.status !== "paused") {
				throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} is not launchable from status ${task.status}`);
			}
			const agentName = taskAgentName(task);
			const agentPolicy = runtime.config.agents[agentName];
			if (!agentPolicy) throw new HarnessError("INVALID_ARTIFACT", `Unknown task agent: ${agentName}`);
			if (!isTierTaskAssignment(task.execution.assignment)) throw new HarnessError("CONFIG_INVALID", `Task ${task.id} uses a legacy model assignment. Replan it with tier and deliberation before execution.`);
			const modelOverride = task.execution.assignment.modelOverride;
			const plannedRouting = {
				tier: task.execution.assignment.tier,
				deliberation: task.execution.assignment.deliberation,
				...(modelOverride ? { override: { model: modelOverride.model, ...(modelOverride.effort ? { effort: modelOverride.effort } : {}) }, strict: modelOverride.strict ?? false } : {}),
			};
			const allAvailable = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
			const resolution = resolveHarnessModel(runtime.config, allAvailable, plannedRouting);
			if (resolution.status === "waiting_model") {
				await runtime.events.append("task.waiting_model", { workItemId: item.id, taskId: task.id, attempts: resolution.attempts });
				return textResult(`MODEL_UNAVAILABLE: No acceptable model is currently available for ${task.id}.`, resolution);
			}
			const manager = new WorktreeManager(runtime.identity);
			locks = new ResourceLockSet(runtime.identity.privateRoot);
			await locks.acquire(task.execution.resourceClaims, `${item.id}/${task.id}`);
			const allocation = await runtime.mutex.run(`allocate:${item.id}:${task.id}`, () => manager.allocate(item.id, task));
			const persistentContext = await buildTaskPersistentContext(runtime.workItems, item.id, task);
			const launched = await supervisor.launchTask({
				identity: runtime.identity,
				workItemId: item.id,
				task,
				persistentContext,
				workspace: allocation.path,
				branch: allocation.branch,
				baseCommit: allocation.baseCommit,
				executionMode: allocation.isolation,
				planningRevision: item.planning.revision,
				model: { provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, requested: `${plannedRouting.tier}:${plannedRouting.deliberation}${modelOverride ? `:${modelOverride.model}${modelOverride.effort ? `:${modelOverride.effort}` : ""}` : ""}` },
				...(agentPolicy.prompt && resolveConfiguredPath(runtime.identity.root, agentPolicy.prompt)
					? { agentPrompt: readFileSync(resolveConfiguredPath(runtime.identity.root, agentPolicy.prompt) as string, "utf8") }
					: {}),
				...(agentPolicy.tools ? { tools: agentPolicy.tools } : {}),
				...(agentPolicy.skills
					? { skillPaths: agentPolicy.skills.map((skill) => resolveConfiguredPath(runtime.identity.root, skill)).filter((path): path is string => Boolean(path)) }
					: {}),
				canonicalMutation: (owner, operation) => runtime.mutex.run(owner, operation),
				coordinator: runtime.coordinator,
				...(signal ? { signal } : {}),
				...(onUpdate ? { onUpdate } : {}),
			});
			await runtime.events.append("task.run_settled", { workItemId: item.id, taskId: task.id, runId: launched.run.id, state: launched.run.state });
			return textResult(
				`Task ${task.id} settled as ${launched.run.state} on ${resolution.model.provider}/${resolution.model.id}:${resolution.effort} for ${plannedRouting.tier}/${plannedRouting.deliberation}${resolution.fallbackUsed ? " (visible same-tier fallback)" : ""}.${launched.handoff ? `\n${launched.handoff.summary}` : launched.finalText ? `\n${launched.finalText}` : ""}`,
				launched,
			);
		} catch (error) {
			throw new Error(describeHarnessError(error));
		} finally {
			await locks?.release();
		}
	};

	const launchManagedRepair = async (ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal) => {
		requireTrusted(ctx);
		const runtime = await runtimeFor(ctx);
		const item = await runtime.workItems.read(workItemId);
		const evaluation = await runtime.workItems.readEvaluation(workItemId, evaluationId);
		const loop = evaluation.loop;
		if (!loop || loop.state !== "fixing" || !loop.managerPrompt?.trim()) throw new HarnessError("INVALID_HANDOFF", `Evaluation ${evaluationId} is not awaiting a prompted repair`);
		const agentDefinition = runtime.config.agents["repair-implementer"];
		if (!agentDefinition) throw new HarnessError("CONFIG_INVALID", "Missing repair-implementer agent definition");
		const routing = { tier: agentDefinition.tier!, deliberation: agentDefinition.deliberation! };
		const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		const resolution = resolveHarnessModel(runtime.config, available, routing);
		if (resolution.status === "waiting_model") throw new HarnessError("MODEL_UNAVAILABLE", "No repair model is available");
		const existing = loop.fixerAgentId ? await runtime.agents.get(loop.fixerAgentId).catch(() => undefined) : undefined;
		const persistentContext = await buildReviewPersistentContext(runtime.workItems, workItemId, evaluation);
		const launched = await runtime.coordinator.launch({
			operationId: `repair:${workItemId}:${evaluationId}:${loop.iteration}`, ...(existing ? { existingAgentId: existing.id } : {}), role: "repair-implementer",
			task: renderBuiltInPrompt("managed-repair", { evaluationId, iteration: loop.iteration, managerPrompt: loop.managerPrompt }),
			assignment: { schemaVersion: 1, workItemId, evaluationId, iteration: loop.iteration, managerPrompt: loop.managerPrompt }, cwd: runtime.identity.root,
			provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, tools: agentDefinition.tools ?? ["read", "grep", "find", "bash", "edit", "write"],
			workItemId, evaluationId, workspace: runtime.identity.root, persistentContext, deferCompletion: true, ...(signal ? { signal } : {}),
			promptPath: agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) ? resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string : join(BUILT_IN_AGENT_ROOT, "repair-implementer.md"),
		});
		if (launched.result.exitCode !== 0) throw new HarnessError("INVALID_HANDOFF", launched.result.stderr || "Repair agent failed");
		await assertCleanRepository(runtime.identity.root);
		await runtime.mutex.run(`repair-settled:${workItemId}:${evaluationId}`, () => runtime.workItems.updateEvaluationLoop(workItemId, evaluationId, { state: "rereviewing", fixerAgentId: launched.agent.id }, "planned"));
		return textResult(`Repair iteration ${loop.iteration} completed for ${evaluationId}; the same reviewer will re-review.`, { agentId: launched.agent.id, iteration: loop.iteration });
	};

	const launchManagedEvaluation = async (ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal) => {
		requireTrusted(ctx);
		const runtime = await runtimeFor(ctx);
		const item = await runtime.workItems.read(workItemId);
		const evaluation = await runtime.workItems.readEvaluation(item.id, evaluationId);
		if (evaluation.attempt >= runtime.config.limits.repairRounds + 1) throw new HarnessError("INVALID_HANDOFF", `Evaluation repair budget exhausted for ${evaluation.id}`);
		const agentName = evaluation.type === "spec-review" ? "spec-reviewer" : evaluation.type === "quality-review" ? "quality-reviewer" : evaluation.type === "e2e" ? "e2e-tester" : "quality-reviewer";
		const agentDefinition = runtime.config.agents[agentName];
		if (!agentDefinition) throw new HarnessError("CONFIG_INVALID", `Missing evaluator agent definition: ${agentName}`);
		const routing = { tier: agentDefinition.tier!, deliberation: agentDefinition.deliberation! };
		const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		const resolution = resolveHarnessModel(runtime.config, available, routing);
		if (resolution.status === "waiting_model") return textResult("MODEL_UNAVAILABLE: No evaluator candidate is available.", resolution);
		await runtime.mutex.run(`evaluation-preflight:${item.id}:${evaluation.id}`, () => assertCleanRepository(runtime.identity.root));
		const runs = new HarnessRunStore(runtime.identity.privateRoot, item.id);
		const created = await runs.create({
			repositoryId: runtime.identity.id, workItemId: item.id, evaluationId: evaluation.id, role: agentName,
			attempt: evaluation.attempt + 1, state: "running", workspace: runtime.identity.root,
			baseCommit: await runGit(runtime.identity.root, ["rev-parse", "HEAD"]), planningRevision: item.planning.revision,
			requestedModel: `${routing.tier}:${routing.deliberation}`, resolvedProvider: resolution.model.provider,
			resolvedModel: resolution.model.id, resolvedEffort: resolution.effort,
		});
		const prompt = renderBuiltInPrompt("managed-evaluation", {
			phase: evaluation.loop?.state === "rereviewing" ? `Re-review iteration ${evaluation.loop.iteration}` : "Evaluate",
			evaluationId: evaluation.id,
			evaluationType: evaluation.type,
			workItemId: item.id,
		});
		const persistentContext = await buildReviewPersistentContext(runtime.workItems, item.id, evaluation);
		let logicalAgentId: string | undefined = evaluation.loop?.reviewerAgentId;
		const runEvaluator = async (taskPrompt: string) => {
			const coordinated = await runtime.coordinator.launch({
				operationId: created.record.id, ...(logicalAgentId ? { existingAgentId: logicalAgentId } : {}), role: agentName, task: taskPrompt,
				assignment: { schemaVersion: 1, workItemId: item.id, evaluationId: evaluation.id, planningRevision: item.planning.revision },
				cwd: runtime.identity.root, provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort,
				tools: [...new Set([...(agentDefinition.tools ?? ["read", "grep", "find", ...(evaluation.type === "e2e" || evaluation.type === "deterministic" || evaluation.type === "regression" ? ["bash"] : [])]), "evaluation_context", "evidence_record", "finding_report", "evaluation_checkpoint", "evaluation_complete"])],
				deferCompletion: true, workItemId: item.id, evaluationId: evaluation.id, runId: created.record.id, workspace: runtime.identity.root, persistentContext,
				env: { PIBOX_HARNESS_RUN_ID: created.record.id, PIBOX_HARNESS_WORK_ITEM: item.id, PIBOX_HARNESS_EVALUATION: evaluation.id, PIBOX_HARNESS_CREDENTIAL: created.credential },
				promptPath: agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) ? resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string : join(BUILT_IN_AGENT_ROOT, `${agentName}.md`),
				onSpawn: (pid) => void runs.update(created.record.id, { ...(pid === undefined ? {} : { pid }) }, "run.process_started"),
				...(signal ? { signal } : {}),
			});
			logicalAgentId = coordinated.agent.id;
			for (const event of coordinated.result.events) await runs.appendTranscript(created.record.id, event);
			return coordinated.result;
		};
		let direct = await runEvaluator(prompt);
		await runs.flushTranscript(created.record.id);
		let handoff = await runs.readEvaluationHandoff(created.record.id);
		if (!handoff && direct.exitCode === 0) {
			await runs.appendEvent(created.record.id, "run.protocol_nudge", { evaluationId: evaluation.id });
			direct = await runEvaluator(`${readBuiltInPrompt("evaluation-protocol-nudge")}\n\n${prompt}`);
			await runs.flushTranscript(created.record.id);
			handoff = await runs.readEvaluationHandoff(created.record.id);
		}
		if (!handoff || handoff.runId !== created.record.id || handoff.evaluationId !== evaluation.id) {
			await runs.update(created.record.id, { state: "protocol_failed", exitCode: direct.exitCode, error: "Missing or invalid evaluation_complete handoff" }, "run.protocol_failed");
			if (logicalAgentId) await runtime.agents.transition(logicalAgentId, "protocol_failed", { error: "Missing or invalid evaluation_complete handoff" }).catch(() => undefined);
			return textResult(`PROTOCOL_FAILED: Evaluator ${evaluation.id} omitted its structured handoff.`, { runId: created.record.id, agentId: logicalAgentId, direct });
		}
		const recorded = await runtime.mutex.run(`evaluation:${evaluation.id}:${created.record.id}`, async () => {
			await assertCleanRepository(runtime.identity.root);
			await runtime.workItems.updateEvaluationLoop(item.id, evaluation.id, { state: evaluation.loop?.state === "rereviewing" ? "rereviewing" : "reviewing", ...(logicalAgentId ? { reviewerAgentId: logicalAgentId } : {}), reviewedCommit: await runGit(runtime.identity.root, ["rev-parse", "HEAD"]) });
			return runtime.workItems.recordEvaluation({ workItemId: item.id, evaluationId: evaluation.id, verdict: handoff.verdict, report: handoff.report, evidence: handoff.evidence, findings: handoff.findings, ...(handoff.residualRisks ? { residualRisks: handoff.residualRisks } : {}) });
		});
		await runs.update(created.record.id, { state: "completed", exitCode: direct.exitCode }, "run.completed");
		await runtime.events.append("evaluation.run_completed", { workItemId: item.id, evaluationId: evaluation.id, runId: created.record.id, agentId: logicalAgentId, verdict: handoff.verdict });
		return textResult(`Evaluation ${evaluation.id} recorded ${handoff.verdict} on attempt ${recorded.attempt}.`, { runId: created.record.id, agentId: logicalAgentId, evaluation: recorded, handoff });
	};

	const spawnDynamicSubagent = async (request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void): Promise<WorkflowRunResult> => {
		try {
			requireTrusted(ctx);
			const runtime = await runtimeFor(ctx);
			const agentDefinition = runtime.config.agents[request.agent];
			if (!agentDefinition) {
				const availableAgents = Object.keys(runtime.config.agents).sort();
				const normalized = request.agent.replace(/[_\s]+/g, "-").toLowerCase();
				const suggestion = availableAgents.find((name) => name === normalized || name.includes(normalized) || normalized.includes(name));
				throw new HarnessError("INVALID_ARTIFACT", `Unknown workflow agent: ${request.agent}.${suggestion ? ` Did you mean ${suggestion}?` : ""} Available agents: ${availableAgents.join(", ")}`);
			}
			if (request.effort && !request.model) throw new HarnessError("INVALID_ARTIFACT", "An explicit effort override requires an explicit model override");
			const routing = {
				tier: (request.tier ?? agentDefinition.tier!) as CapabilityTier,
				deliberation: (request.deliberation ?? agentDefinition.deliberation!) as Deliberation,
				...(request.model ? { override: { model: request.model, ...(request.effort ? { effort: request.effort as HarnessEffort } : {}) } } : {}),
				strict: request.strict ?? false,
			};
			const availableModels = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
			const resolution = resolveHarnessModel(runtime.config, availableModels, routing);
			if (resolution.status === "waiting_model") throw new HarnessError("MODEL_UNAVAILABLE", "No configured candidate is available", { attempts: resolution.attempts });
			if (["implementer", "test-implementer", "repair-implementer"].includes(request.agent)) throw new HarnessError("CAPABILITY_DENIED", `Agent ${request.agent} is managed-work execution and must be scheduled by workflow_start or workflow resume`);
			const defaultTools: Record<string, string[]> = {
				researcher: ["web_search", "source_check", "fetch_content", "get_search_content"],
				explorer: ["read", "grep", "find", "bash"],
				"plan-critic": ["read", "grep", "find"],
				"spec-reviewer": ["read", "grep", "find", "bash"],
				"quality-reviewer": ["read", "grep", "find", "bash"],
				"e2e-tester": ["read", "grep", "find", "bash"],
			};
			const launched = await runtime.coordinator.launch({
				operationId: request.operationId, role: request.agent, task: request.task,
				assignment: { schemaVersion: 1, agent: request.agent, task: request.task, ...(request.tier ? { tier: request.tier } : {}), ...(request.deliberation ? { deliberation: request.deliberation } : {}), ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), ...(request.strict !== undefined ? { strict: request.strict } : {}) }, cwd: runtime.identity.root,
				provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort,
				tools: agentDefinition.tools ?? defaultTools[request.agent] ?? ["read", "grep", "find"],
				workspace: runtime.identity.root,
				...(agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt)
					? { promptPath: resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string }
					: existsSync(join(BUILT_IN_AGENT_ROOT, `${request.agent}.md`))
						? { promptPath: join(BUILT_IN_AGENT_ROOT, `${request.agent}.md`) }
						: {}),
				...(agentDefinition.skills ? { skillPaths: agentDefinition.skills.map((skill) => resolveConfiguredPath(runtime.identity.root, skill)).filter((path): path is string => Boolean(path)) } : {}),
				...(signal ? { signal } : {}), ...(onText ? { onText } : {}),
			});
			const direct = launched.result;
			await runtime.events.append("subagent.settled", { agentId: launched.agent.id, role: request.agent, exitCode: direct.exitCode, model: `${direct.provider}/${direct.model}`, effort: direct.effort });
			return {
				ref: `agent:${launched.agent.id}`,
				state: direct.exitCode === 0 ? "completed" : "failed",
				summary: direct.text || direct.stderr || `Subagent exited ${direct.exitCode}.`, agentId: launched.agent.id,
				...(direct.exitCode === 0 ? {} : { attention: true }),
			};
		} catch (error) {
			throw new Error(describeHarnessError(error));
		}
	};

	pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: unknown) => {
		const discovery = event as WorkflowAdapterDiscovery;
		discovery.register(createHarnessWorkflowAdapter({
			runtimeFor,
			launchTask: launchManagedTask,
			launchEvaluation: launchManagedEvaluation,
			launchRepair: launchManagedRepair,
			spawnSubagent: spawnDynamicSubagent,
			async reconcileReported(runtime) {
				await reconcileReportedAgents({ identity: runtime.identity, registry: runtime.agents, workItems: runtime.workItems, mutex: runtime.mutex });
			},
		}));
	});

	pi.registerTool({
		name: "workflow_status",
		label: "Workflow Status",
		description: "Inspect managed PiBox workflow work items and execution state for the current repository.",
		promptSnippet: "Inspect managed work-item revisions and execution status",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			try {
				const status = await snapshot(await runtimeFor(ctx));
				return textResult(formatStatus(status), status);
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "workflow_list",
		label: "List Workflow Resources",
		description: "List a compact, filtered page of canonical or runtime resource summaries. Use the returned cursor for the next page; use workflow_get to zoom into one ref.",
		parameters: Type.Object({ resource: LISTABLE_RESOURCE_TYPE, workItemId: Type.Optional(Type.String()), query: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const runtime = await runtimeFor(ctx);
				let resources: Array<Record<string, unknown>>;
				if (params.resource === "agent") resources = (await runtime.agents.list()).filter((agent) => !params.workItemId || agent.workItemId === params.workItemId).map((agent) => ({ ref: `agent:${agent.id}`, id: agent.id, role: agent.role, state: agent.state, workItemId: agent.workItemId, taskId: agent.taskId, evaluationId: agent.evaluationId, model: `${agent.provider}/${agent.model}:${agent.effort}`, updatedAt: agent.updatedAt, ...(agent.summary ? { summary: agent.summary.slice(0, 240) } : {}) }));
				else if (params.resource === "message") {
					const agents = new Map((await runtime.agents.list()).map((agent) => [agent.id, agent]));
					resources = (await runtime.agents.listMessages()).filter((message) => !params.workItemId || agents.get(message.agentId)?.workItemId === params.workItemId).map((message) => ({ ref: `message:${message.id}`, id: message.id, agentId: message.agentId, type: message.type, status: message.status, blocking: message.blocking, summary: message.summary.slice(0, 240), updatedAt: message.updatedAt }));
				} else if (params.resource === "run") {
					const items = params.workItemId ? [await runtime.workItems.read(params.workItemId)] : await runtime.workItems.list();
					const runs = (await Promise.all(items.map((item) => new HarnessRunStore(runtime.identity.privateRoot, item.id).list()))).flat();
					resources = runs.map((run) => ({ ref: `run:${run.id}`, id: run.id, workItemId: run.workItemId, taskId: run.taskId, evaluationId: run.evaluationId, role: run.role, state: run.state, model: run.resolvedModel ? `${run.resolvedProvider}/${run.resolvedModel}:${run.resolvedEffort}` : undefined }));
				} else resources = await new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config).listSummaries(params.resource as CanonicalResourceType, params.workItemId);
				const page = paginateCatalog(resources, { ...(params.query ? { query: params.query } : {}), ...(params.cursor ? { cursor: params.cursor } : {}), ...(params.limit ? { limit: params.limit } : {}), searchableText: (resource) => JSON.stringify(resource) });
				const continuation = page.page.nextCursor ? `\nMore results omitted. Call workflow_list again with cursor ${JSON.stringify(page.page.nextCursor)}.` : "";
				return textResult(`${page.page.returned} of ${page.page.total} ${params.resource} resource(s), snapshot ${page.page.snapshot}.\n${JSON.stringify(page.items, null, 2)}${continuation}`, page);
			} catch (error) { throw structuredCapabilityError(error); }
		},
	});

	pi.registerTool({
		name: "workflow_get",
		label: "Get Workflow Resource",
		description: "Get a compact resource summary by default. For a work item, view=full returns the whole plan graph—artifact contents, structured task contracts, units, and evaluations—in revision-pinned slices for review.",
		parameters: Type.Object({ ref: Type.String({ description: "For example work-item:checkout/task:implement-checkout or agent:<id>" }), view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")])), revision: Type.Optional(Type.Integer({ minimum: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })), findText: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const runtime = await runtimeFor(ctx);
				const view = params.view ?? (params.offset !== undefined || params.findText !== undefined ? "full" : "summary");
				if (view === "summary" && (params.offset !== undefined || params.findText !== undefined)) throw new HarnessError("INVALID_ARTIFACT", "offset and findText require view=full");
				if (params.ref.startsWith("agent:")) {
					if (params.revision !== undefined) throw new HarnessError("INVALID_ARTIFACT", "Runtime agent resources use updatedAt rather than canonical revisions");
					const agent = await runtime.agents.get(params.ref.slice(6));
					if (view === "summary") return textResult(`${params.ref}\n${JSON.stringify({ ref: params.ref, id: agent.id, role: agent.role, state: agent.state, scope: { workItemId: agent.workItemId, taskId: agent.taskId, evaluationId: agent.evaluationId }, model: `${agent.provider}/${agent.model}:${agent.effort}`, updatedAt: agent.updatedAt, summary: agent.summary, availableViews: ["summary", "full"] }, null, 2)}`);
					const slice = sliceText(JSON.stringify(agent, null, 2), { ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.limit ? { limit: params.limit } : {}), ...(params.findText ? { findText: params.findText } : {}) });
					return textResult(`${params.ref} full ${slice.mode}.\n${slice.text}${slice.page.nextOffset !== undefined ? `\nMore omitted; call workflow_get with view=full and offset=${slice.page.nextOffset}.` : ""}`, { ref: params.ref, view, page: slice.page });
				}
				const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
				if (view === "summary") {
					const summary = await service.summary(params.ref);
					if (params.revision !== undefined && summary.revision !== params.revision) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `${params.ref} advanced from requested revision ${params.revision} to ${summary.revision as number}`);
					return textResult(`${params.ref}\n${JSON.stringify(summary, null, 2)}`, summary);
				}
				const complete = await service.get(params.ref) as { revision: number };
				if (params.revision !== undefined && complete.revision !== params.revision) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `${params.ref} advanced from requested revision ${params.revision} to ${complete.revision}`);
				const slice = sliceText(JSON.stringify(complete, null, 2), { ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.limit ? { limit: params.limit } : {}), ...(params.findText ? { findText: params.findText } : {}) });
				return textResult(`${params.ref} @ revision ${complete.revision}, full ${slice.mode}.\n${slice.text}${slice.page.nextOffset !== undefined ? `\nMore omitted; call workflow_get with revision=${complete.revision}, view=full, offset=${slice.page.nextOffset}.` : ""}`, { ref: params.ref, revision: complete.revision, view, page: slice.page });
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
	});

	pi.registerTool({
		name: "workflow_schema",
		label: "Read Workflow Mutation Schema",
		description: "Read a bounded exact schema for a complete plan write or one low-level resource mutation. Use before an unfamiliar write instead of keeping every schema in prompt context.",
		parameters: Type.Object({ operation: Type.Union([Type.Literal("plan-write"), Type.Literal("create"), Type.Literal("patch"), Type.Literal("apply-change")]), resource: Type.Optional(CANONICAL_RESOURCE_TYPE), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })) }, { additionalProperties: false }),
		async execute(_id, params) {
			try {
				// Compact JSON keeps the ordinary plan-write contract within one bounded
				// read while remaining an exact machine-readable schema.
				const schema = JSON.stringify(schemaFor(params.operation, params.resource as CanonicalResourceType | undefined));
				const slice = sliceText(schema, { ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.limit ? { limit: params.limit } : {}) });
				return textResult(`${params.operation}${params.resource ? `/${params.resource}` : ""} schema.\n${slice.text}${slice.page.nextOffset !== undefined ? `\nMore omitted; call workflow_schema with offset=${slice.page.nextOffset}.` : ""}`, { operation: params.operation, resource: params.resource, page: slice.page });
			} catch (error) { throw structuredCapabilityError(error); }
		},
	});

	pi.registerTool({
		name: "workflow_plan_write",
		label: "Write Complete Workflow Plan",
		description: "Write a structured workflow plan. Use create for a new/fresh/separate plan, update only for an explicit complete replacement, and revision-pinned edit for surgical self-review corrections without resending unchanged content. basedOn is read-only. Harness-owned defaults keep create/update compact; task brief and acceptance structure stays mandatory. Read workflow_schema operation=plan-write for exact fields.",
		parameters: COMPACT_PLAN_WRITE_PARAMETERS,
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					assertExactSchema(PLAN_WRITE_PARAMETERS, params, "workflow_plan_write");
					const exact = params as any;
					if (exact.mode === "create" && (exact.target !== undefined || exact.expectedRevision !== undefined || exact.plan === undefined || exact.edits !== undefined)) throw new HarnessError("INVALID_ARTIFACT", "Plan create requires plan and accepts basedOn, not target, expectedRevision, or edits");
					if (exact.mode === "update" && (typeof exact.target !== "string" || !Number.isInteger(exact.expectedRevision) || exact.plan === undefined || exact.basedOn !== undefined || exact.edits !== undefined)) throw new HarnessError("INVALID_ARTIFACT", "Plan update requires target, expectedRevision, and plan; it does not accept basedOn or edits");
					if (exact.mode === "edit" && (typeof exact.target !== "string" || !Number.isInteger(exact.expectedRevision) || !Array.isArray(exact.edits) || exact.edits.length === 0 || exact.plan !== undefined || exact.basedOn !== undefined)) throw new HarnessError("INVALID_ARTIFACT", "Plan edit requires target, expectedRevision, and edits; it does not accept plan or basedOn");
					const normalizedPlan = exact.plan === undefined ? undefined : normalizePlanBundle(exact.plan);
					if (exact.mode === "create" && exact.basedOn) {
						const source = parseResourceRef(exact.basedOn);
						if (source.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "basedOn must be a work-item ref");
						await runtime.workItems.read(source.id);
						if (source.id === normalizedPlan!.workItem.id) throw new HarnessError("INVALID_ARTIFACT", "A new plan needs a new work-item id; basedOn remains read-only");
					}
					const target = exact.target ? parseResourceRef(exact.target) : undefined;
					if (target && target.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "Plan target must be a work-item ref");
					const workItemId = exact.mode === "create" ? normalizedPlan!.workItem.id as string : target!.id;
					if (exact.mode === "update" && normalizedPlan!.workItem.id !== workItemId) throw new HarnessError("INVALID_ARTIFACT", `Update target ${exact.target} must match plan id ${String(normalizedPlan!.workItem.id)}`);
					if (normalizedPlan) assertExactSchema(CANONICAL_PLAN_BUNDLE, normalizedPlan, "normalized workflow plan");
					const ref = `work-item:${workItemId}`;
					const authority: MutationAuthority = { rationale: exact.mode === "create" ? "Write the new complete plan for user review" : exact.mode === "update" ? "Replace the explicitly selected plan for user review" : "Apply revision-pinned self-review corrections for user review", ...(exact.basedOn ? { sources: [exact.basedOn] } : {}) };
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					let changes: Array<{ action: "create" | "patch" | "delete"; ref: string }>;
					let result;
					if (exact.mode === "edit") {
						const edits = exact.edits.map((entry: { action: PlanEdit["action"]; ref: string; value?: unknown }) => {
							const parsed = parseResourceRef(entry.ref);
							return normalizePlanEdit(parsed.type, entry.action, entry.ref, entry.value, workItemId);
						});
						result = await service.transaction(`harness: edit plan ${workItemId}`, () => service.editPlan(exact.target, exact.expectedRevision, edits, authority));
						changes = edits.map((edit: PlanEdit) => ({ action: edit.action === "create" ? "create" : edit.action === "delete" ? "delete" : "patch", ref: edit.ref }));
					} else {
						result = await service.transaction(`harness: ${exact.mode} complete plan ${workItemId}`, () => service.writePlan(exact.mode === "create" ? { mode: "create", plan: normalizedPlan! } : { mode: "update", target: exact.target, expectedRevision: exact.expectedRevision, plan: normalizedPlan! }, authority));
						changes = [{ action: exact.mode === "create" ? "create" : "patch", ref }];
					}
					await runtime.events.append("plan.written", { mode: exact.mode, ref, ...(exact.basedOn ? { basedOn: exact.basedOn } : {}), changes: changes.length, commit: result.commit });
					const receipt = await mutationReceipt(runtime, result.commit, changes, { mode: exact.mode });
					const verb = exact.mode === "create" ? "Created" : exact.mode === "update" ? "Replaced" : "Edited";
					return textResult(`${verb} plan ${ref}${result.commit ? ` at ${result.commit.slice(0, 12)}` : ""}.\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error, "target" in params ? params.target : undefined); }
		},
	});

	pi.registerTool({
		name: "workflow_create",
		label: "Create Workflow Resource",
		description: "Compatibility/repair surface for creating one canonical resource. For ordinary planning, use workflow_plan_write so the complete plan is atomic and its create/update identity is explicit.",
		parameters: COMPACT_CREATE_PARAMETERS,
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				assertExactSchema(CREATE_RESOURCE_PARAMETERS, params, "workflow_create");
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const exact = params as any;
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					const parent = exact.parent as string | undefined;
					const ref = createdResourceRef(exact.resource, parent, exact.body);
					const result = await service.transaction(`harness: create ${exact.resource}`, () => service.create(exact.resource, parent, exact.body, exact.authority));
					await runtime.events.append("resource.created", { resource: exact.resource, parent, authority: exact.authority, commit: result.commit });
					const receipt = await mutationReceipt(runtime, result.commit, [{ action: "create", ref }]);
					return textResult(`Created ${ref}${result.commit ? ` at ${result.commit.slice(0, 12)}` : ""}.\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error, "parent" in params ? params.parent : undefined); }
		},
	});

	pi.registerTool({
		name: "workflow_patch",
		label: "Patch Workflow Resource",
		description: "Compatibility/repair surface for one targeted resource patch. For ordinary plan replacement, use workflow_plan_write mode=update.",
		parameters: COMPACT_PATCH_PARAMETERS,
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				assertExactSchema(PATCH_RESOURCE_PARAMETERS, params, "workflow_patch");
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const exact = params as any;
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					const result = await service.transaction(`harness: patch ${exact.ref}`, () => service.patch(exact.ref, exact.patch, { authority: exact.authority }));
					await runtime.events.append("resource.patched", { ref: exact.ref, authority: exact.authority, commit: result.commit });
					const receipt = await mutationReceipt(runtime, result.commit, [{ action: "patch", ref: exact.ref }]);
					return textResult(`Patched ${exact.ref}.\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
	});

	pi.registerTool({
		name: "workflow_delete",
		label: "Delete Workflow Resource",
		description: "Delete an undelivered canonical child resource and repair its catalog relationships atomically. Delivery history remains immutable.",
		parameters: Type.Object({ ref: Type.String(), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					const result = await service.transaction(`harness: delete ${params.ref}`, () => service.delete(params.ref, { authority: params.authority as MutationAuthority }));
					await runtime.events.append("resource.deleted", { ref: params.ref, authority: params.authority, commit: result.commit });
					const receipt = await mutationReceipt(runtime, result.commit, [{ action: "delete", ref: params.ref }]);
					return textResult(`Deleted ${params.ref}.\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
	});

	pi.registerTool({
		name: "workflow_apply_change",
		label: "Apply Orchestrator Change",
		description: "Compatibility/repair surface for a coherent multi-resource amendment. For ordinary plan creation or replacement, use workflow_plan_write.",
		parameters: COMPACT_APPLY_CHANGE_PARAMETERS,
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				assertExactSchema(APPLY_CHANGE_PARAMETERS, params, "workflow_apply_change");
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const exact = params as any;
					const operations = exact.operations as any[];
					const changes = operations.map((operation): { action: "create" | "patch" | "delete"; ref: string } => operation.method === "create"
						? { action: "create", ref: createdResourceRef(operation.resource, operation.parent, operation.body) }
						: { action: operation.method, ref: operation.ref });
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					const baselines = new Map<string, Awaited<ReturnType<WorkItemStore["read"]>> | undefined>();
					for (const change of changes) {
						const workItemId = parseResourceRef(change.ref).workItemId;
						if (!baselines.has(workItemId)) baselines.set(workItemId, await runtime.workItems.read(workItemId).catch((error) => error instanceof HarnessError && error.code === "WORK_ITEM_NOT_FOUND" ? undefined : Promise.reject(error)));
					}
					const respondingAgent = exact.response ? await runtime.agents.get(exact.response.agentId) : undefined;
					const result = await service.transaction("harness: apply orchestrator change", async () => {
						for (const operation of operations) {
							if (operation.method === "create") await service.create(operation.resource, operation.parent, operation.body, exact.authority);
							else if (operation.method === "patch") await service.patch(operation.ref, operation.patch, { authority: exact.authority });
							else await service.delete(operation.ref, { authority: exact.authority });
						}
						if (exact.executionDisposition === "resume-requesting-agent" && respondingAgent?.workItemId && respondingAgent.taskId) {
							const task = await runtime.workItems.readTask(respondingAgent.workItemId, respondingAgent.taskId);
							if (task.status === "blocked") await runtime.workItems.updateTask(respondingAgent.workItemId, respondingAgent.taskId, { status: "ready" });
						}
						for (const [workItemId, baseline] of baselines) await service.coalesceRevision(workItemId, baseline, exact.authority);
					});
					const message = exact.response ? await runtime.agents.respondMessage(exact.response.agentId, exact.response.messageId, exact.response.text) : undefined;
					await runtime.events.append("orchestrator.change_applied", { authority: exact.authority, executionDisposition: exact.executionDisposition, operations: operations.length, commit: result.commit, messageId: exact.response?.messageId });
					if (exact.executionDisposition === "resume-requesting-agent" && respondingAgent?.workItemId) pi.events.emit(WORKFLOW_CONTROL_EVENT, { ref: `work-item:${respondingAgent.workItemId}`, action: "resume" });
					if (exact.executionDisposition === "pause-affected") for (const workItemId of baselines.keys()) pi.events.emit(WORKFLOW_CONTROL_EVENT, { ref: `work-item:${workItemId}`, action: "pause" });
					const receipt = await mutationReceipt(runtime, result.commit, changes, message ? { message: { id: message.id, status: message.status, agentId: message.agentId } } : {});
					return textResult(`Applied ${operations.length} canonical operation(s)${result.commit ? ` as ${result.commit.slice(0, 12)}` : ""}.\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error); }
		},
	});

	pi.registerTool({
		name: "workflow_transition",
		label: "Transition Workflow Resource",
		description: "Apply an explicit resource lifecycle action. Postponed work remains resumable; archive creates the explicit finalization lock.",
		parameters: Type.Object({ ref: Type.String(), action: Type.Union([Type.Literal("submit"), Type.Literal("postpone"), Type.Literal("resume"), Type.Literal("archive"), Type.Literal("reopen"), Type.Literal("request-user"), Type.Literal("blocked"), Type.Literal("ready"), Type.Literal("reviewing"), Type.Literal("changes_requested"), Type.Literal("paused"), Type.Literal("cancelled")]), reason: Type.String() }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const ref = parseResourceRef(params.ref);
					if (ref.type === "work-item" && params.action === "submit") await runtime.workItems.submitPlanning(ref.id);
					else if (ref.type === "work-item" && ["postpone", "resume", "archive", "reopen", "request-user"].includes(params.action)) await runtime.workItems.transitionWorkItem(ref.id, params.action as "postpone" | "resume" | "archive" | "reopen" | "request-user", params.reason);
					else if (ref.type === "task") await runtime.workItems.updateTask(ref.workItemId, ref.id, { status: params.action as TaskManifest["status"] });
					else throw new HarnessError("CAPABILITY_DENIED", `Unsupported transition ${params.action} for ${ref.type}`);
					const receipt = await mutationReceipt(runtime, await runGit(runtime.identity.root, ["rev-parse", "HEAD"]), [{ action: "transition", ref: params.ref }], { transition: params.action });
					const handoff = ref.type === "work-item" && params.action === "submit"
						? `\nPlan review is complete. Ask the user to review or request changes; if they want execution, they can simply say “start the workflow.” No separate approval command is required.`
						: "";
					return textResult(`${params.ref} transitioned to ${params.action}.${handoff}\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
	});

	pi.registerTool({
		name: "workflow_init",
		label: "Initialize Workflow Repository",
		description: "Scaffold and commit trusted repository-local PiBox workflow policy. Use when asked to prepare a project for managed workflows.",
		promptSnippet: "Scaffold repository-local workflow policy before creating managed work",
		parameters: Type.Object({
			profile: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("economy")])),
			overwrite: Type.Optional(Type.Boolean()),
		}),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const scaffold = await scaffoldHarness(runtime.identity.root, params.profile ?? "standard", params.overwrite ?? false);
					const loaded = loadHarnessConfig(runtime.identity.root);
					runtime.config = loaded.config;
					await runtime.events.append("repository.scaffolded", scaffold);
					return textResult(
						scaffold.created
							? `Initialized ${scaffold.profile} workflow policy and repository-local worktree ignore at ${scaffold.commit?.slice(0, 12)}.`
							: scaffold.worktreeIgnoreAdded
								? `Workflow policy already exists; committed repository-local worktree ignore at ${scaffold.commit?.slice(0, 12)}.`
								: "Workflow policy and repository-local worktree ignore already exist; validated without overwriting them.",
						scaffold,
					);
				});
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "exploration_launch",
		label: "Launch Repository Exploration",
		description: "Launch a read-only explorer with a typed question, decision boundary, depth, stop conditions, and structured evidence handoff.",
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("lookup"), Type.Literal("map"), Type.Literal("trace"), Type.Literal("impact"), Type.Literal("diagnose"), Type.Literal("explain")]),
			question: Type.String(), decisionSupported: Type.String(),
			knownEvidence: Type.Array(Type.Object({ source: Type.String(), observation: Type.String() })),
			scope: Type.Object({ start: Type.Array(Type.String()), exclude: Type.Optional(Type.Array(Type.String())) }),
			depth: Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("thorough")]),
			stopConditions: Type.Array(Type.String()), requiredOutput: Type.Array(Type.String()),
			tier: Type.Optional(CAPABILITY_TIER), deliberation: Type.Optional(DELIBERATION),
			model: Type.Optional(Type.String({ description: "Exceptional concrete configured model override" })), effort: Type.Optional(EFFORT),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				const assignment: ExplorationAssignment = { schemaVersion: 1, mode: params.mode, question: params.question, decisionSupported: params.decisionSupported, knownEvidence: params.knownEvidence, scope: params.scope, depth: params.depth, stopConditions: params.stopConditions, requiredOutput: params.requiredOutput };
				validateExplorationAssignment(assignment);
				const agentDefinition = runtime.config.agents.explorer;
				if (!agentDefinition) throw new HarnessError("CONFIG_INVALID", "Missing explorer agent definition");
				if (params.effort && !params.model) throw new HarnessError("INVALID_ARTIFACT", "An explicit effort override requires an explicit model override");
				const routing = {
					tier: (params.tier ?? agentDefinition.tier!) as CapabilityTier,
					deliberation: (params.deliberation ?? agentDefinition.deliberation!) as Deliberation,
					...(params.model ? { override: { model: params.model, ...(params.effort ? { effort: params.effort as HarnessEffort } : {}) } } : {}),
				};
				const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
				const resolution = resolveHarnessModel(runtime.config, available, routing);
				if (resolution.status === "waiting_model") return textResult("MODEL_UNAVAILABLE: No explorer candidate is available.", resolution);
				const launch = (nudge: boolean) => runtime.coordinator.launch({
					operationId: toolCallId, role: "explorer", task: `${renderBuiltInPrompt("managed-exploration", { mode: assignment.mode, depth: assignment.depth })}${nudge ? `\n\n${readBuiltInPrompt("exploration-protocol-nudge")}` : ""}`,
					assignment, cwd: runtime.identity.root, provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort,
					tools: [...(agentDefinition.tools ?? ["read", "grep", "find", "bash"]), ...EXPLORATION_TOOL_NAMES], deferCompletion: true,
					...(signal ? { signal } : {}), ...(onUpdate ? { onText: (text: string) => onUpdate(textResult(text, { role: "explorer", state: "running" })) } : {}),
				});
				let launched = await launch(false);
				const agentRoot = join(runtime.agents.root, "agents", launched.agent.id);
				let handoffText = await readTextIfExists(join(agentRoot, "handoff.json"));
				const blocked = await readTextIfExists(join(agentRoot, "blocked.json"));
				if (!handoffText && blocked) {
					const agent = await runtime.agents.transition(launched.agent.id, "blocked", { summary: JSON.parse(blocked).summary });
					return textResult(`Explorer ${agent.id} is blocked.`, { agent, blocked: JSON.parse(blocked) });
				}
				if (!handoffText && runtime.config.limits.protocolNudges > 0) {
					launched = await launch(true);
					handoffText = await readTextIfExists(join(agentRoot, "handoff.json"));
				}
				if (!handoffText) {
					const agent = await runtime.agents.transition(launched.agent.id, "protocol_failed", { error: "Missing exploration_complete handoff" });
					return textResult(`Explorer ${agent.id} failed its completion protocol.`, agent);
				}
				const handoff = JSON.parse(handoffText) as ExplorationHandoff;
				validateExplorationHandoff(handoff, assignment);
				const agent = await runtime.agents.transition(launched.agent.id, "completed", { summary: handoff.answer });
				return textResult(handoff.answer, { agent, handoff });
			} catch (error) { throw new Error(describeHarnessError(error)); }
		},
	});

	pi.registerTool({
		name: "task_integrate",
		label: "Merge Workflow Task",
		description: "Compatibility merge capability. Merge one accepted task contribution into the checked-out feature branch and run its declared post-merge checks.",
		parameters: Type.Object({ workItemId: Type.String(), integrationUnit: Type.String({ description: "Legacy parameter containing the task id to merge." }), checks: Type.Optional(Type.Array(Type.String({ description: "Optional shell-command override; omitted uses the task manifest's declared checks." }))) }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const manager = new WorktreeManager(runtime.identity);
					const integrated = await manager.mergeTask(params.workItemId, params.integrationUnit, params.checks);
					await runtime.events.append("task.merged", integrated);
					return textResult(`Merged ${integrated.taskId} into the feature branch as ${integrated.commit.slice(0, 12)}.`, integrated);
				});
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "evaluation_record",
		label: "Record Workflow Evaluation",
		description: "Atomically record a completed planned evaluation, curated report, and checksummed evidence manifest.",
		parameters: Type.Object({
			workItemId: Type.String(),
			evaluationId: Type.String(),
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked"), Type.Literal("not_applicable")]),
			report: Type.String({ description: "Evaluation observations; canonical report headings are rendered deterministically." }),
			residualRisks: Type.Optional(Type.Array(Type.String())),
			evidence: Type.Optional(Type.Array(Type.Object({ command: Type.Optional(Type.String()), result: Type.String(), path: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }))),
			findings: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
				status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("duplicate"), Type.Literal("deferred"), Type.Literal("resolved"), Type.Literal("needs_user")]),
				criterion: Type.Optional(Type.String()),
				location: Type.Optional(Type.String()),
				summary: Type.String(),
				blocking: Type.Boolean(),
			}))),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const current = await runtime.workItems.readEvaluation(params.workItemId, params.evaluationId);
					if (current.attempt >= runtime.config.limits.repairRounds + 1) throw new HarnessError("INVALID_HANDOFF", `Evaluation repair budget exhausted for ${params.evaluationId}`);
					const evaluation = await runtime.workItems.recordEvaluation({ ...params, evidence: params.evidence ?? [] });
					await runtime.events.append("evaluation.recorded", { workItemId: params.workItemId, evaluationId: evaluation.id, verdict: params.verdict, attempt: evaluation.attempt });
					return textResult(`Recorded ${evaluation.id} attempt ${evaluation.attempt}: ${params.verdict}.`, evaluation);
				});
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "work_item_complete",
		label: "Complete Workflow Work Item",
		description: "Apply the completion gate and render a structured outcome from delivered work, canonical verification, deviations, findings, and residual risk.",
		parameters: Type.Union([
			Type.Object({
				workItemId: Type.String(),
				outcomeSections: Type.Object({
					delivered: Type.Array(Type.String()),
					deviations: Type.Optional(Type.Array(Type.String())),
					residualRisks: Type.Optional(Type.Array(Type.String())),
					followUp: Type.Optional(Type.Array(Type.String())),
				}, { additionalProperties: false }),
			}, { additionalProperties: false }),
			Type.Object({ workItemId: Type.String(), outcome: Type.String({ description: "Legacy schema-v1 outcome Markdown" }) }, { additionalProperties: false }),
		]),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = "outcome" in params
						? await runtime.workItems.completeWorkItem(params.workItemId, params.outcome)
						: await runtime.workItems.completeWorkItem(params.workItemId, undefined, params.outcomeSections);
					await runtime.events.append("work_item.completed", { workItemId: item.id });
					return textResult(`Completed ${item.id}.`, item);
				});
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerCommand("workflow", {
		description: "Control PiBox workflows: init | status | pause | resume | stop | recover",
		handler: async (args, ctx) => {
			const [command = "status", target, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			try {
				const runtime = await runtimeFor(ctx);
				if (command === "status" && !target) {
					ctx.ui.notify(formatStatus(await snapshot(runtime)), "info");
					return;
				}
				if (command === "init" && extra.length === 0 && (!target || target === "standard" || target === "economy")) {
					requireTrusted(ctx);
					const profile = (target ?? "standard") as HarnessScaffoldProfile;
					const scaffold = await runtime.mutex.run(`init:${profile}`, () => scaffoldHarness(runtime.identity.root, profile));
					const loaded = loadHarnessConfig(runtime.identity.root);
					runtime.config = loaded.config;
					await runtime.events.append("repository.scaffolded", scaffold);
					ctx.ui.notify(scaffold.created ? `Initialized ${profile} workflow policy and committed it.` : "Workflow policy already exists and is valid.", "info");
					return;
				}
				if (command === "recover" && !target) {
					const staleLockRecovered = await runtime.mutex.recoverStale();
					const recovered = [];
					for (const item of await runtime.workItems.list()) {
						recovered.push(...(await new HarnessRunStore(runtime.identity.privateRoot, item.id).recoverInterrupted()));
					}
					await runtime.events.append("recovery.inspected", { interruptedRuns: recovered.map((run) => run.id), staleLockRecovered });
					ctx.ui.notify(recovered.length || staleLockRecovered ? `Recovered ${recovered.length} interrupted run(s)${staleLockRecovered ? " and one stale canonical lock" : ""}.${recovered.length ? `\n${recovered.map((run) => `${run.taskId ?? run.id}`).join("\n")}` : ""}` : "No newly interrupted runs or stale locks found.", recovered.length || staleLockRecovered ? "warning" : "info");
					return;
				}
				if ((command === "pause" || command === "stop") && target && extra.length === 0) {
					for (const item of await runtime.workItems.list()) {
						const catalog = item.tasks.find((task) => task.id === target);
						if (!catalog) continue;
						const task = await runtime.workItems.readTask(item.id, target);
						const stopped = task.runtime?.lastRunId
							? command === "pause" ? supervisor.pause(task.runtime.lastRunId) : supervisor.stop(task.runtime.lastRunId)
							: false;
						if (command === "pause" && !stopped) await runtime.mutex.run(`pause:${item.id}:${target}`, () => runtime.workItems.updateTask(item.id, target, { status: "paused" }));
						ctx.ui.notify(`${command === "pause" ? "Pause" : "Stop"} ${stopped ? "requested" : "recorded; no active local process"} for ${target}.`, "warning");
						return;
					}
					ctx.ui.notify(`Unknown task: ${target}`, "error");
					return;
				}
				if (command === "resume" && target && extra.length === 0) {
					for (const item of await runtime.workItems.list()) {
						if (!item.tasks.some((task) => task.id === target)) continue;
						const launch = await launchManagedTask(ctx, item.id, target);
						ctx.ui.notify(launch.content[0]?.text ?? `Resume settled for ${target}.`, "info");
						return;
					}
					ctx.ui.notify(`Unknown task: ${target}`, "error");
					return;
				}
				ctx.ui.notify("Usage: /workflow init [standard|economy] | status | pause <task> | resume <task> | stop <task> | recover", "warning");
			} catch (error) {
				ctx.ui.notify(describeHarnessError(error), "error");
			}
		},
	});

	pi.registerCommand("harness", {
		description: "Manage PiBox operational state: worktrees [cleanupAll | remove <work-item/task> [--force]]",
		handler: async (args, ctx) => {
			const [command, action = "list", target, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (command !== "worktrees") {
				ctx.ui.notify("Usage: /harness worktrees [cleanupAll | remove <work-item/task> [--force]]", "warning");
				return;
			}
			try {
				const runtime = await runtimeFor(ctx);
				const manager = new WorktreeManager(runtime.identity);
				if (action === "list" && !target) {
					const worktrees = await manager.listManaged();
					const total = worktrees.reduce((sum, worktree) => sum + worktree.bytes, 0);
					ctx.ui.notify(worktrees.length ? `PiBox worktrees: ${worktrees.length}, ${formatBytes(total)}\n${worktrees.map((worktree) => `${worktree.name} — ${worktree.status}${worktree.active ? ", active" : ""}, ${formatBytes(worktree.bytes)}${worktree.branch ? ` (${worktree.branch})` : ""}`).join("\n")}` : "No PiBox worktrees.", "info");
					return;
				}
				if (action === "cleanupAll" && !target) {
					requireTrusted(ctx);
					const removed = await manager.cleanupManaged();
					await runtime.events.append("worktrees.cleaned", { count: removed.length, worktrees: removed.map((worktree) => worktree.name) });
					ctx.ui.notify(removed.length ? `Removed ${removed.length} clean inactive PiBox worktree(s): ${removed.map((worktree) => worktree.name).join(", ")}.` : "No clean inactive PiBox worktrees to remove.", "info");
					return;
				}
				if (action === "remove" && target && extra.every((value) => value === "--force")) {
					requireTrusted(ctx);
					const removed = await manager.removeManaged(target, extra.includes("--force"));
					await runtime.events.append("worktree.removed", { name: removed.name, forced: extra.includes("--force") });
					ctx.ui.notify(`Removed PiBox worktree ${removed.name}. Its branch ${removed.branch ?? "(detached)"} was retained.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /harness worktrees [cleanupAll | remove <work-item/task> [--force]]", "warning");
			} catch (error) {
				ctx.ui.notify(describeHarnessError(error), "error");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (isWorkerProcess() || isEvaluatorProcess() || isSubagentProcess()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_CONTRACT}` };
	});

	pi.on("session_start", async (event, ctx) => {
		const disallowed = new Set<string>();
		if (isEvaluatorProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...WORKER_TOOL_NAMES, ...EXPLORATION_TOOL_NAMES].forEach((name) => disallowed.add(name));
		else if (isWorkerProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES, ...EXPLORATION_TOOL_NAMES].forEach((name) => disallowed.add(name));
		else if (isSubagentProcess()) {
			[...ORCHESTRATOR_TOOL_NAMES, ...WORKER_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES].forEach((name) => disallowed.add(name));
			if ((process.env.PIBOX_SUBAGENT_AGENT ?? process.env.PIBOX_SUBAGENT_ROLE) !== "explorer") EXPLORATION_TOOL_NAMES.forEach((name) => disallowed.add(name));
		} else [...WORKER_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES, ...EXPLORATION_TOOL_NAMES].forEach((name) => disallowed.add(name));
		pi.setActiveTools(pi.getActiveTools().filter((name) => !disallowed.has(name)));
		if (isSubagentProcess()) {
			const agentRoot = process.env.PIBOX_SUBAGENT_ROOT;
			const attemptId = process.env.PIBOX_SUBAGENT_ATTEMPT_ID;
			if (agentRoot && attemptId) {
				const writeHeartbeat = () => atomicWriteFile(join(agentRoot, "attempts", attemptId, "heartbeat.json"), `${JSON.stringify({ agentId: process.env.PIBOX_SUBAGENT_ID, attemptId, pid: process.pid, at: new Date().toISOString() })}\n`, 0o600).catch(() => undefined);
				await writeHeartbeat();
				heartbeatTimer = setInterval(writeHeartbeat, 5_000);
				heartbeatTimer.unref();
			}
			return;
		}
		if (isWorkerProcess() || isEvaluatorProcess()) return;
		try {
			sessionRuntime = await createRuntime(ctx);
			const staleLockRecovered = await sessionRuntime.mutex.recoverStale();
			await sessionRuntime.events.append("session.started", {
				reason: event.reason,
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				staleLockRecovered,
			});
			if (!isWorkerProcess() && !isEvaluatorProcess()) {
				const agents = await reconcileSessionAgents(sessionRuntime);
				const finalized = await reconcileReportedAgents({ identity: sessionRuntime.identity, registry: sessionRuntime.agents, workItems: sessionRuntime.workItems, mutex: sessionRuntime.mutex });
				if (agents.reported || agents.interrupted || agents.ambiguous || finalized.completed.length || finalized.errors.length) ctx.ui.notify(`Workflow reconciled subagents: ${finalized.completed.length} completed, ${agents.reported} reported, ${agents.interrupted} interrupted, ${agents.ambiguous + finalized.errors.length} require recovery.`, agents.ambiguous || finalized.errors.length ? "warning" : "info");
				const recovered = [];
				for (const item of await sessionRuntime.workItems.list()) {
					recovered.push(...(await new HarnessRunStore(sessionRuntime.identity.privateRoot, item.id).recoverInterrupted()));
				}
				if (recovered.length > 0) ctx.ui.notify(`Workflow recovered ${recovered.length} interrupted run(s). Use /workflow recover or /workflow resume <task>.`, "warning");
			}
		} catch (error) {
			sessionRuntime = undefined;
			if (error instanceof HarnessError && error.code === "NOT_A_GIT_REPOSITORY") return;
			ctx.ui.notify(`Workflow initialization failed: ${describeHarnessError(error)}`, "warning");
		}
	});

	pi.on("message_end", async (event) => {
		if (!isSubagentProcess() || event.message.role !== "assistant") return;
		const agentRoot = process.env.PIBOX_SUBAGENT_ROOT;
		const attemptId = process.env.PIBOX_SUBAGENT_ATTEMPT_ID;
		if (!agentRoot || !attemptId) return;
		const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		await atomicWriteFile(join(agentRoot, "attempts", attemptId, "result.json"), `${JSON.stringify({ agentId: process.env.PIBOX_SUBAGENT_ID, attemptId, text, at: new Date().toISOString() }, null, 2)}\n`, 0o600);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!sessionRuntime) return;
		await sessionRuntime.events.append("orchestrator.settled", { idle: ctx.isIdle() });
	});

	pi.on("session_shutdown", async (event) => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (isSubagentProcess() && process.env.PIBOX_SUBAGENT_ROOT && process.env.PIBOX_SUBAGENT_ATTEMPT_ID) {
			await atomicWriteFile(join(process.env.PIBOX_SUBAGENT_ROOT, "attempts", process.env.PIBOX_SUBAGENT_ATTEMPT_ID, "process-exit.json"), `${JSON.stringify({ agentId: process.env.PIBOX_SUBAGENT_ID, attemptId: process.env.PIBOX_SUBAGENT_ATTEMPT_ID, reason: event.reason, at: new Date().toISOString() }, null, 2)}\n`, 0o600).catch(() => undefined);
		}
		heartbeatTimer = undefined;
		if (!sessionRuntime) return;
		await sessionRuntime.events.append("session.shutdown", { reason: event.reason });
		await sessionRuntime.events.flush();
		sessionRuntime = undefined;
	});
}
