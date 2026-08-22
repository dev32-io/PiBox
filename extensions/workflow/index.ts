import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { reconcileReportedAgents } from "./agent-reconciliation.js";
import { AGENT_HEARTBEAT_FRESH_MS, AGENT_HEARTBEAT_INTERVAL_MS, isAgentProcessActive, SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { WorkflowControlStore } from "../workflow-runtime/control-store.js";
import { loadHarnessConfig } from "./config.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { finalizeReviewerAfterSettlement, reusableReviewerAgentId, settleManagedEvaluation } from "./evaluation-settlement.js";
import { RepositoryEventStore } from "./event-store.js";
import { isEvaluatorProcess, registerEvaluatorCapabilities } from "./evaluator-capabilities.js";
import { HarnessRunStore } from "./run-store.js";
import { initializeHarnessRepository, type HarnessScaffoldProfile, type HarnessScaffoldResult } from "./scaffold.js";
import { LaunchCoordinator } from "../workflow-runtime/launch-coordinator.js";
import { normalizeExplicitModelOverride, resolveHarnessModel } from "./model-resolver.js";
import { IdempotencyStore, RepositoryMutex } from "./idempotency.js";
import { buildReviewPersistentContext, buildTaskPersistentContext } from "./implementation-context.js";
import { OrchestratorResourceService, parseResourceRef, type CanonicalResourceType, type PlanEdit } from "./orchestrator-resources.js";
import { normalizePlanArtifact, normalizePlanBundle, normalizePlanEdit, normalizePlanStage, normalizePlanTask, normalizeResourceArtifact } from "./plan-authoring.js";
import { paginateCatalog, sliceText } from "./progressive-disclosure.js";
import { assertCleanRepository, atomicWriteFile, discoverRepository, readTextIfExists, runGit, type RepositoryIdentity } from "./repository.js";
import { isTierTaskAssignment, taskAgentName, type CapabilityTier, type HarnessEffort, type HarnessStatusSnapshot, type ModelTier, type MutationAuthority, type TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { CanonicalMutationCoordinator, runManagedChild } from "./canonical-mutation.js";
import { isWorkerProcess, registerWorkerCapabilities } from "./worker-capabilities.js";
import { SubagentSupervisor } from "./supervisor.js";
import { ResourceLockSet, WorktreeManager, type WorktreeProgress } from "./worktrees.js";
import { inferDynamicSubagentTier, WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, type DynamicSubagentRequest, type DynamicSubagentStarted, type SpawnableAgentDefinition, type WorkflowAdapterDiscovery, type WorkflowRunResult } from "../workflow-runtime/api.js";
import type { AgentProgress } from "../workflow-runtime/agent-progress.js";
import { createHarnessWorkflowAdapter } from "./workflow-adapter.js";
import { BUILT_IN_AGENT_ROOT, readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import { ALL_TOOLS_SUBAGENT_ENV, DEFAULT_SUBAGENT_TOOLS, PIBOX_EVALUATION_TOOL_GROUP, PIBOX_TASK_TOOL_GROUP, PIBOX_TOOL_GROUPS, resolveToolSelectors, SUBAGENT_CONTROL_TOOLS } from "./tool-groups.js";
import { authorizeMcpProxyCall, configuredMcpServerAllowlist, mcpLaunchEnvironment } from "./mcp-capabilities.js";
import { resourceDisplayDiff } from "./resource-diff.js";
import { RepairRecoveryStore } from "./repair-recovery.js";
import { FAST_MODE_EXTENSION_PATH } from "../fast-mode/index.js";
import { FAST_MODE_POLICY_EVENT, normalizeFastModePolicy } from "../fast-mode/policy.js";
import { resetActiveFastModePolicy, setActiveFastModePolicy } from "../fast-mode/runtime.js";
import { MODEL_TIER_PROFILE_EVENT, normalizeModelTierProfilePolicy } from "../model-tier-list-profiles/policy.js";
import { cleanupCompletedWorkItem } from "./completion-cleanup.js";

const WORKFLOW_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const MEMORY_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../memory-adapter/index.ts");
const DISTILL_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../distill/index.ts");
export const WORKFLOW_CHILD_EXTENSION_PATHS = [WORKFLOW_EXTENSION_PATH, MEMORY_EXTENSION_PATH, DISTILL_EXTENSION_PATH, FAST_MODE_EXTENSION_PATH] as const;

const WORKER_TOOL_NAMES = new Set(PIBOX_TOOL_GROUPS[PIBOX_TASK_TOOL_GROUP]);
const EVALUATOR_TOOL_NAMES = new Set(PIBOX_TOOL_GROUPS[PIBOX_EVALUATION_TOOL_GROUP]);
const isSubagentProcess = () => Boolean(process.env.PIBOX_SUBAGENT_ID);
const ORCHESTRATOR_CONTRACT = readBuiltInPrompt("orchestrator-routing");

const ORCHESTRATOR_TOOL_NAMES = new Set([
	"workflow_status",
	"resource_list",
	"resource_read",
	"resource_write",
	"resource_delete",
	"workflow_apply_change",
	"workflow_transition",
	"workflow_init",
	"task_integrate",
	"evaluation_record",
	"work_item_complete",
]);
const COMPATIBILITY_RESOURCE_TOOL_NAMES = new Set([
	"workflow_list", "workflow_get", "workflow_schema", "workflow_plan_write",
	"workflow_create", "workflow_patch", "workflow_delete",
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
const boundedStructuredResult = (value: unknown, label: string) => {
	const serialized = JSON.stringify(value, null, 2);
	const slice = sliceText(serialized, { limit: 12_000 });
	return textResult(`${slice.text}${slice.page.hasMore ? `\n[${label} truncated at 12,000 characters; list and read individual child resources for the remainder.]` : ""}`, { label, page: slice.page });
};
const CANONICAL_RESOURCE_TYPE = Type.Union([Type.Literal("work-item"), Type.Literal("artifact"), Type.Literal("task"), Type.Literal("stage"), Type.Literal("evaluation")]);
const AUTHORABLE_RESOURCE_TYPE = Type.Union([Type.Literal("work-item"), Type.Literal("artifact"), Type.Literal("task"), Type.Literal("stage")]);
const LISTABLE_RESOURCE_TYPE = Type.Union([CANONICAL_RESOURCE_TYPE, Type.Literal("agent"), Type.Literal("message"), Type.Literal("run")]);
const MUTATION_AUTHORITY = Type.Object({
	rationale: Type.String(),
	sources: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
const EFFORT = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
const CAPABILITY_TIER = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("max")]);
const TASK_MANIFEST_RESOURCE = Type.Object({
	schemaVersion: Type.Literal(1), id: Type.String({ description: "Bare kebab-case task id" }), title: Type.String(),
	status: Type.Union([Type.Literal("draft"), Type.Literal("blocked"), Type.Literal("ready")]),
	dependsOn: Type.Array(Type.String()),
	references: Type.Optional(Type.Object({ specs: Type.Array(Type.String()), designs: Type.Array(Type.String()), decisions: Type.Array(Type.String()) }, { additionalProperties: false })),
	execution: Type.Object({
		resourceClaims: Type.Array(Type.String({ description: "Shared files or external resources used to validate parallel-stage compatibility" })),
		assignment: Type.Object({
			agent: Type.String({ description: "Configured agent definition, normally implementer" }),
			tier: CAPABILITY_TIER,
			rationale: Type.String({ description: "Why this task needs the selected capability tier after decomposition" }),
			tierJustification: Type.Optional(Type.String({ description: "Required by policy for high/max: why medium is insufficient, irreducible ambiguity, and why further decomposition is unsafe or incoherent" })),
		}, { additionalProperties: false }),
	}, { additionalProperties: false }),
	assembly: Type.Object({ stageId: Type.Optional(Type.String()), integrationUnit: Type.Optional(Type.String({ description: "Legacy alias for stageId" })), intermediateState: Type.Union([Type.Literal("complete"), Type.Literal("partial")]) }, { additionalProperties: false }),
	verification: Type.Object({ timing: Type.Union([Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("work-item"), Type.Literal("skipped")]), methods: Type.Array(Type.String()), taskChecks: Type.Array(Type.String()), rationale: Type.String() }, { additionalProperties: false }),
}, { additionalProperties: false });
const INTENT_SECTIONS = Type.Object({ problem: Type.String(), desiredOutcome: Type.String(), scopeIncluded: Type.Array(Type.String()), successSignals: Type.Array(Type.String()), scopeExcluded: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), assumptions: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const WORKING_BRANCH_AUTHORING = { workingBranch: Type.Optional(Type.String({ description: "Explicit feature/<name> or fix/<name>; on develop defaults to <branchKind>/<work-item-id>, while an existing checked-out feature/fix branch is continued when omitted or matching" })), branchKind: Type.Optional(Type.Union([Type.Literal("feature"), Type.Literal("fix")])) };
const SPEC_SECTIONS = Type.Object({ context: Type.String(), domainLanguage: Type.Optional(Type.Array(Type.String())), actors: Type.Optional(Type.Array(Type.String())), requiredBehaviors: Type.Array(Type.String()), acceptanceCriteria: Type.Array(Type.Object({ id: Type.String({ description: "AC-NNN" }), statement: Type.String() }, { additionalProperties: false })), scenarios: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), edgeCases: Type.Optional(Type.Array(Type.String())), assumptions: Type.Optional(Type.Array(Type.String())), outOfScope: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const DESIGN_SECTIONS = Type.Object({ designGoal: Type.String(), chosenApproach: Type.Array(Type.String()), verificationBoundaries: Type.Array(Type.String()), componentsAndInterfaces: Type.Optional(Type.Array(Type.String())), dataAndControlFlow: Type.Optional(Type.Array(Type.String())), failureAndRecovery: Type.Optional(Type.Array(Type.String())), securityAndPrivacy: Type.Optional(Type.Array(Type.String())), compatibilityAndMigration: Type.Optional(Type.Array(Type.String())), alternativesConsidered: Type.Optional(Type.Array(Type.String())), openQuestions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false });
const DECISION_SECTIONS = Type.Object({ decision: Type.String(), context: Type.String(), rationale: Type.String(), consequences: Type.Array(Type.String()), alternativesConsidered: Type.Optional(Type.Array(Type.String())), revisitWhen: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const TASK_BRIEF_SECTIONS = Type.Object({ contributionGoal: Type.String(), context: Type.Optional(Type.Array(Type.String())), boundaryIncluded: Type.Array(Type.String()), requiredWork: Type.Array(Type.String()), integrationExpectation: Type.String(), boundaryExcluded: Type.Optional(Type.Array(Type.String())), interfacesAndDependencies: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), risksAndUncertainties: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const LEGACY_TASK_ACCEPTANCE_SECTIONS = Type.Object({ deliverables: Type.Array(Type.String()), criterionContributions: Type.Array(Type.Union([Type.String(), Type.Object({ criteria: Type.Array(Type.String({ description: "Qualified artifact#AC-NNN references" })), contribution: Type.String() }, { additionalProperties: false })])), boundaryProof: Type.Array(Type.String()), expectedIntermediateState: Type.Optional(Type.String()), integrationProof: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const SELF_CONTAINED_TASK_ACCEPTANCE_SECTIONS = Type.Object({ deliverables: Type.Array(Type.String()), acceptance: Type.Array(Type.String()), boundaryProof: Type.Optional(Type.Array(Type.String())), expectedIntermediateState: Type.Optional(Type.String()), integrationProof: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const TASK_ACCEPTANCE_SECTIONS = Type.Union([SELF_CONTAINED_TASK_ACCEPTANCE_SECTIONS, LEGACY_TASK_ACCEPTANCE_SECTIONS]);
const WORK_ITEM_RESOURCE_BODY = Type.Union([
	Type.Object({ id: Type.String(), title: Type.String(), kind: Type.Union([Type.Literal("change"), Type.Literal("story")]), ...WORKING_BRANCH_AUTHORING, narrativeSchemaVersion: Type.Literal(2), intentSections: INTENT_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), title: Type.String(), kind: Type.Union([Type.Literal("change"), Type.Literal("story")]), ...WORKING_BRANCH_AUTHORING, intent: Type.String() }, { additionalProperties: false }),
]);
const E2E_MATRIX_SECTIONS = Type.Object({
	scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	cases: Type.Array(Type.Object({ id: Type.String({ pattern: "^E2E-[0-9]{3}$" }), classification: Type.Union([Type.Literal("golden-path"), Type.Literal("edge"), Type.Literal("failure"), Type.Literal("recovery")]), journey: Type.String({ minLength: 1 }), setup: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), actions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), expectedOutcomes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), safety: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })) }, { additionalProperties: false }), { minItems: 1 }),
	safety: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })), notes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
}, { additionalProperties: false });
const ARTIFACT_RESOURCE_BODY = Type.Union([
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("e2e-matrix"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: E2E_MATRIX_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("spec"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: SPEC_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("design"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: DESIGN_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String({ description: "Bare kebab-case artifact id; no type prefix or colon" }), type: Type.Literal("decision"), narrativeSchemaVersion: Type.Literal(2), title: Type.String(), sections: DECISION_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Union([Type.Literal("spec"), Type.Literal("design"), Type.Literal("decision")]), content: Type.String() }, { additionalProperties: false }),
]);
const TASK_RESOURCE_BODY = Type.Union([
	Type.Object({ manifest: TASK_MANIFEST_RESOURCE, brief: Type.String(), acceptance: Type.String() }, { additionalProperties: false }),
	Type.Object({ manifest: TASK_MANIFEST_RESOURCE, narrativeSchemaVersion: Type.Literal(2), briefSections: TASK_BRIEF_SECTIONS, acceptanceSections: TASK_ACCEPTANCE_SECTIONS }, { additionalProperties: false }),
]);
const PLAN_STAGE_CHECK = Type.Union([
	Type.String(),
	Type.Object({ id: Type.Optional(Type.String()), command: Type.String(), profile: Type.Optional(Type.String()) }, { additionalProperties: false }),
]);
const PLAN_STAGE = Type.Object({ id: Type.String(), tasks: Type.Array(Type.String(), { description: "Draft planning may temporarily leave a stage empty; submission rejects empty stages" }), mode: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("concurrent")])), checks: Type.Optional(Type.Array(PLAN_STAGE_CHECK)), review: Type.Optional(Type.Object({ tier: Type.Optional(Type.Union([Type.Literal("medium"), Type.Literal("high")])), focus: Type.Optional(Type.Array(Type.String())), rationale: Type.Optional(Type.String()) }, { additionalProperties: false })) }, { additionalProperties: false });
const CANONICAL_PLAN_BUNDLE = Type.Object({
	workItem: WORK_ITEM_RESOURCE_BODY,
	artifacts: Type.Array(ARTIFACT_RESOURCE_BODY),
	tasks: Type.Array(TASK_RESOURCE_BODY),
	stages: Type.Array(PLAN_STAGE),
}, { additionalProperties: false });

// Planner-facing authoring contracts omit harness-owned lifecycle and schema
// boilerplate. Normalization restores the complete canonical shape before write.
const RESOURCE_WORK_ITEM = Type.Object({
	id: Type.String({ description: "Bare kebab-case work-item id" }),
	title: Type.String(),
	kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])),
	...WORKING_BRANCH_AUTHORING,
	intentSections: INTENT_SECTIONS,
}, { additionalProperties: false });
const PLAN_WORK_ITEM = Type.Object({
	id: Type.String({ description: "Bare kebab-case work-item id" }),
	title: Type.String(),
	kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])),
	...WORKING_BRANCH_AUTHORING,
	intentSections: INTENT_SECTIONS,
}, { additionalProperties: false });
const PLAN_ARTIFACT = Type.Union([
	Type.Object({ id: Type.String(), type: Type.Literal("e2e-matrix"), title: Type.Optional(Type.String()), sections: E2E_MATRIX_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Literal("spec"), title: Type.Optional(Type.String()), sections: SPEC_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Literal("design"), title: Type.Optional(Type.String()), sections: DESIGN_SECTIONS }, { additionalProperties: false }),
	Type.Object({ id: Type.String(), type: Type.Literal("decision"), title: Type.Optional(Type.String()), sections: DECISION_SECTIONS }, { additionalProperties: false }),
]);
const SELF_CONTAINED_PLAN_TASK = Type.Object({
	id: Type.String({ description: "Bare kebab-case task id" }),
	title: Type.Optional(Type.String()),
	goal: Type.String({ description: "The independently useful contribution this task delivers" }),
	context: Type.Optional(Type.Array(Type.String({ description: "Only story or technical context the executor needs to understand this task" }))),
	included: Type.Array(Type.String({ description: "Concrete behavior and implementation boundary owned by this task" })),
	work: Type.Optional(Type.Array(Type.String({ description: "Ordered required implementation and test steps" }))),
	requiredWork: Type.Optional(Type.Array(Type.String({ description: "Alias for ordered required implementation and test steps" }))),
	excluded: Type.Optional(Type.Array(Type.String())),
	interfaces: Type.Optional(Type.Array(Type.String({ description: "Interfaces, dependencies, or handoffs that constrain this task" }))),
	constraints: Type.Optional(Type.Array(Type.String())),
	acceptance: Type.Array(Type.String({ description: "Observable, self-contained completion conditions; do not use artifact references" })),
	proof: Type.Optional(Type.Array(Type.String({ description: "Evidence that demonstrates the acceptance conditions" }))),
	checks: Type.Optional(Type.Array(Type.String({ description: "Deterministic commands assigned at this task boundary" }))),
	risks: Type.Optional(Type.Array(Type.String())),
	dependsOn: Type.Optional(Type.Array(Type.String())),
	stageId: Type.Optional(Type.String({ description: "Defaults to the task id, producing a safe singleton stage" })),
	intermediateState: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("partial")])),
	integrationExpectation: Type.Optional(Type.String()),
	resourceClaims: Type.Optional(Type.Array(Type.String())),
	assignment: Type.Optional(Type.Object({
		agent: Type.Optional(Type.String()), tier: Type.Optional(CAPABILITY_TIER),
		rationale: Type.Optional(Type.String()), tierJustification: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	verification: Type.Optional(Type.Object({
		timing: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("work-item"), Type.Literal("skipped")])),
		methods: Type.Optional(Type.Array(Type.String())), rationale: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
const LEGACY_PLAN_TASK = Type.Object({
	id: Type.String(), title: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String())),
	references: Type.Optional(Type.Object({ specs: Type.Optional(Type.Array(Type.String())), designs: Type.Optional(Type.Array(Type.String())), decisions: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })),
	stageId: Type.Optional(Type.String()), intermediateState: Type.Optional(Type.Union([Type.Literal("complete"), Type.Literal("partial")])), resourceClaims: Type.Optional(Type.Array(Type.String())),
	assignment: Type.Optional(Type.Object({ agent: Type.Optional(Type.String()), tier: Type.Optional(CAPABILITY_TIER), rationale: Type.Optional(Type.String()), tierJustification: Type.Optional(Type.String()) }, { additionalProperties: false })),
	verification: Type.Optional(Type.Object({ timing: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("work-item"), Type.Literal("skipped")])), methods: Type.Optional(Type.Array(Type.String())), taskChecks: Type.Optional(Type.Array(Type.String())), rationale: Type.Optional(Type.String()) }, { additionalProperties: false })),
	briefSections: Type.Object({ contributionGoal: Type.String(), boundaryIncluded: Type.Array(Type.String()), requiredWork: Type.Optional(Type.Array(Type.String())), integrationExpectation: Type.Optional(Type.String()), boundaryExcluded: Type.Optional(Type.Array(Type.String())), interfacesAndDependencies: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())), risksAndUncertainties: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
	acceptanceSections: Type.Object({ deliverables: Type.Optional(Type.Array(Type.String())), criterionContributions: Type.Array(Type.Object({ criteria: Type.Array(Type.String()), contribution: Type.String() }, { additionalProperties: false })), boundaryProof: Type.Array(Type.String()), expectedIntermediateState: Type.Optional(Type.String()), integrationProof: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
}, { additionalProperties: false });
const PLAN_TASK = Type.Union([SELF_CONTAINED_PLAN_TASK, LEGACY_PLAN_TASK]);
const PLAN_BUNDLE = Type.Object({
	workItem: PLAN_WORK_ITEM,
	artifacts: Type.Optional(Type.Array(PLAN_ARTIFACT)),
	tasks: Type.Array(PLAN_TASK),
	stages: Type.Array(PLAN_STAGE),
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
	Type.Object({ method: Type.Literal("create"), resource: Type.Literal("stage"), parent: Type.String(), body: PLAN_STAGE, authority: Type.Optional(MUTATION_AUTHORITY) }, { additionalProperties: false }),
] as const;
const TASK_MANIFEST_PATCH = Type.Object({ title: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String())), references: Type.Optional(Type.Record(Type.String(), Type.Unknown())), execution: Type.Optional(Type.Record(Type.String(), Type.Unknown())), assembly: Type.Optional(Type.Record(Type.String(), Type.Unknown())), verification: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false });
const TASK_PATCH_BODY = Type.Object({
	manifest: Type.Optional(TASK_MANIFEST_PATCH), title: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String())), references: Type.Optional(Type.Partial(Type.Object({ specs: Type.Array(Type.String()), designs: Type.Array(Type.String()), decisions: Type.Array(Type.String()) }))), execution: Type.Optional(Type.Record(Type.String(), Type.Unknown())), assembly: Type.Optional(Type.Record(Type.String(), Type.Unknown())), verification: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	brief: Type.Optional(Type.String()), acceptance: Type.Optional(Type.String()), narrativeSchemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), briefSections: Type.Optional(TASK_BRIEF_SECTIONS), acceptanceSections: Type.Optional(TASK_ACCEPTANCE_SECTIONS),
}, { additionalProperties: false });
const PATCH_RESOURCE_PARAMETERS = Type.Union([
	Type.Object({ resource: Type.Literal("work-item"), ref: Type.String(), patch: Type.Object({ title: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])), intent: Type.Optional(Type.String()), narrativeSchemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), intentSections: Type.Optional(INTENT_SECTIONS) }, { additionalProperties: false }), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("artifact"), ref: Type.String(), patch: Type.Object({ type: Type.Optional(Type.Union([Type.Literal("spec"), Type.Literal("design"), Type.Literal("decision")])), narrativeSchemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), title: Type.Optional(Type.String()), content: Type.Optional(Type.String()), sections: Type.Optional(Type.Record(Type.String(), Type.Unknown())), links: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("task"), ref: Type.String(), patch: TASK_PATCH_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("stage"), ref: Type.String(), patch: Type.Partial(PLAN_STAGE), authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
]);
const PATCH_OPERATION_VARIANTS = [
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("work-item"), ref: Type.String(), patch: Type.Object({ title: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("story")])), intent: Type.Optional(Type.String()), intentSections: Type.Optional(INTENT_SECTIONS) }, { additionalProperties: false }) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("artifact"), ref: Type.String(), patch: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("task"), ref: Type.String(), patch: TASK_PATCH_BODY }, { additionalProperties: false }),
	Type.Object({ method: Type.Literal("patch"), resource: Type.Literal("stage"), ref: Type.String(), patch: Type.Partial(PLAN_STAGE) }, { additionalProperties: false }),
] as const;
const CREATE_RESOURCE_PARAMETERS = Type.Union([
	Type.Object({ resource: Type.Literal("work-item"), body: WORK_ITEM_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("artifact"), parent: Type.String(), body: ARTIFACT_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("task"), parent: Type.String(), body: TASK_RESOURCE_BODY, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
	Type.Object({ resource: Type.Literal("stage"), parent: Type.String(), body: PLAN_STAGE, authority: MUTATION_AUTHORITY }, { additionalProperties: false }),
]);
const APPLY_CHANGE_PARAMETERS = Type.Object({
	authority: MUTATION_AUTHORITY,
	executionDisposition: Type.Union([Type.Literal("continue"), Type.Literal("resume-requesting-agent"), Type.Literal("pause-affected")]),
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
	executionDisposition: Type.Union([Type.Literal("continue"), Type.Literal("resume-requesting-agent"), Type.Literal("pause-affected")]),
	operations: Type.Array(Type.Object({ method: Type.Union([Type.Literal("create"), Type.Literal("patch"), Type.Literal("delete")]), resource: Type.Optional(CANONICAL_RESOURCE_TYPE), parent: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), body: Type.Optional(OPEN_OBJECT), patch: Type.Optional(OPEN_OBJECT) }, { additionalProperties: false })),
	response: Type.Optional(Type.Object({ agentId: Type.String(), messageId: Type.String(), text: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });

function assertExactSchema(schema: any, value: unknown, label: string): void {
	if (Check(schema, value)) return;
	const problems = [...Errors(schema, value)].slice(0, 4).map((error) => `${error.instancePath || "/"} ${error.message}`);
	throw new HarnessError("INVALID_ARTIFACT", `${label} has invalid structured fields: ${problems.join("; ")}. Use the concise resource example from the active skill and omit fields that add no information.`);
}

function idFromTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return id || undefined;
}

function compactResourceBody(resource: CanonicalResourceType, value: Record<string, unknown>, parent?: string): Record<string, unknown> {
	const withId = value.id === undefined && (resource === "artifact" || resource === "task" || resource === "stage")
		? { ...value, id: idFromTitle(value.title) }
		: value;
	if (resource === "artifact") {
		const authored = normalizeResourceArtifact(withId);
		assertExactSchema(PLAN_ARTIFACT, authored, "artifact");
		return normalizePlanArtifact(authored);
	}
	if (resource === "task") { assertExactSchema(PLAN_TASK, withId, "task"); return normalizePlanTask(withId); }
	if (resource === "stage") { assertExactSchema(PLAN_STAGE, withId, "stage"); return normalizePlanStage(withId); }
	if (resource === "evaluation") throw new HarnessError("CAPABILITY_DENIED", "Evaluation resources are runtime-owned");
	assertExactSchema(RESOURCE_WORK_ITEM, withId, "work item");
	return { id: withId.id, title: withId.title, kind: withId.kind ?? "story", ...(withId.workingBranch ? { workingBranch: withId.workingBranch } : {}), ...(withId.branchKind ? { branchKind: withId.branchKind } : {}), narrativeSchemaVersion: 2, intentSections: withId.intentSections };
}

function createdResourceRef(resource: CanonicalResourceType, parent: string | undefined, body: Record<string, any>): string {
	if (resource === "work-item") return `work-item:${body.id}`;
	if (!parent) throw new HarnessError("INVALID_ARTIFACT", `${resource} creation requires parent`);
	const workItemId = parseResourceRef(parent).workItemId;
	const id = resource === "task" ? body.manifest?.id : body.id;
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

async function draftTopologyReceipt(runtime: HarnessRuntime, ref: string): Promise<{ valid: boolean; issues: Awaited<ReturnType<WorkItemStore["planningTopologyIssues"]>> }> {
	const issues = await runtime.workItems.planningTopologyIssues(parseResourceRef(ref).workItemId);
	return { valid: issues.length === 0, issues };
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

export function structuredCapabilityError(error: unknown, ref?: string): Error {
	const harness = error instanceof HarnessError ? error : undefined;
	const code = harness?.code ?? "INTERNAL_ERROR";
	const allowedActions = code === "WORK_ITEM_EXISTS" ? ["get", "patch", "transition"] : code === "CAPABILITY_DENIED" ? ["get", "reopen", "supersede"] : ["get", "patch"];
	const message = error instanceof Error ? error.message : String(error);
	return new Error(JSON.stringify({ ok: false, code, message, ...(ref ? { resourceRef: ref } : {}), ...(harness && Object.keys(harness.details).length ? { details: harness.details } : {}), allowedActions, conflicts: [], retryable: false }));
}

async function createRuntime(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, modelTierProfile?: string): Promise<HarnessRuntime> {
	const identity = await discoverRepository(ctx.cwd);
	const loaded = loadHarnessConfig(identity.root, { ...(modelTierProfile ? { modelTierProfile } : {}) });
	const events = new RepositoryEventStore(identity);
	await events.initialize();
	const sessionId = ctx.sessionManager.getSessionId();
	const mainAgentId = `main:${sessionId}`;
	const agents = new SessionAgentRegistry(identity.privateRoot, sessionId, loaded.config.limits.maxActiveSubagentsPerSession, loaded.config.limits.maxSubagentDepth);
	await agents.initialize(mainAgentId);
	const canonical = new CanonicalMutationCoordinator(identity.root, identity.commonDir ?? join(identity.root, ".git"));
	return {
		identity,
		events,
		workItems: new WorkItemStore(identity.root, canonical),
		config: loaded.config,
		operations: new IdempotencyStore(identity.privateRoot),
		mutex: canonical.mutex,
		agents,
		// Memory retrieval and bounded distillation reads are agent-context
		// capabilities, not orchestrator-only tools. Load their hooks explicitly so
		// managed and dynamically spawned agents receive the same repository scope.
		coordinator: new LaunchCoordinator(agents, mainAgentId, undefined, [...WORKFLOW_CHILD_EXTENSION_PATHS]),
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function formatWorktreeProgress(progress: WorktreeProgress): string {
	if (progress.phase === "inventory") return "Discovering PiBox worktrees…";
	const count = progress.total > 0 ? ` ${progress.current}/${progress.total}` : "";
	const name = progress.name ? ` · ${progress.name}` : "";
	if (progress.phase === "status") return `Inspecting${count}${name}`;
	if (progress.phase === "size") return `Measuring sizes${count}${name}`;
	if (progress.phase === "removing") return `Removing${count}${name}`;
	return `Removed${count}${name}`;
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
		const runStore = new HarnessRunStore(runtime.identity, item.id);
		for (const run of await runStore.list()) {
			const handoffReady = ["launching", "running"].includes(run.state)
				? Boolean(run.evaluationId ? await runStore.readEvaluationHandoff(run.id) : await runStore.readHandoff(run.id))
				: false;
			runs.push({
				id: run.id,
				workItemId: item.id,
				role: run.role,
				state: run.state,
				...(handoffReady ? { handoffReady: true } : {}),
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
	const executionControls = (await new WorkflowControlStore(runtime.identity.privateRoot).list()).map((control) => ({
		workflowRef: control.workflowRef,
		mode: control.mode,
		generation: control.generation,
		updatedAt: control.updatedAt,
	}));
	return { repositoryRoot: runtime.identity.root, repositoryId: runtime.identity.id, workItems, taskCounts, runs, executionControls, agents };
}

async function reconcileSessionAgents(runtime: HarnessRuntime): Promise<{ reported: number; interrupted: number; ambiguous: number }> {
	const result = { reported: 0, interrupted: 0, ambiguous: 0 };
	for (const agent of await runtime.agents.list()) {
		if (["completed", "failed", "protocol_failed", "cancelled", "waiting_model", "waiting_capacity", "waiting_decision", "blocked", "paused", "reported"].includes(agent.state)) continue;
		const agentRoot = join(runtime.agents.root, "agents", agent.id);
		let hasHandoff = Boolean(await readTextIfExists(join(agentRoot, "handoff.json")));
		if (!hasHandoff && agent.workItemId && agent.runId) {
			const runs = new HarnessRunStore(runtime.identity, agent.workItemId);
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
		if (processExit && finalResult && !agent.taskId && !agent.evaluationId) {
			const summary = (JSON.parse(finalResult) as { text?: string }).text ?? "Background specialist completed";
			await runtime.agents.transition(agent.id, "reported", { summary }).catch(() => undefined);
			await runtime.agents.transition(agent.id, "completed", { summary }).catch(() => undefined);
			result.reported += 1;
			continue;
		}
		const heartbeatText = await readTextIfExists(join(attemptRoot, "heartbeat.json"));
		const heartbeat = heartbeatText ? JSON.parse(heartbeatText) as { attemptId?: string; pid?: number; at?: string } : undefined;
		const fresh = heartbeat?.attemptId === attempt.id && heartbeat.at !== undefined && Date.now() - Date.parse(heartbeat.at) < AGENT_HEARTBEAT_FRESH_MS;
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
		const execution = status.executionControls.find((control) => control.workflowRef === `work-item:${item.id}`);
		return `${item.id} · ${item.kind} · ${item.phase}/${item.state} · plan r${item.planning.revision}${item.amendment ? ` · amendment ${item.amendment.generation} of ${item.amendment.rootWorkItemId}` : ""}${execution ? ` · runner ${execution.mode}` : ""}${tasks ? ` · ${tasks}` : ""}`;
	});
	const activeAgents = status.agents.filter((agent) => agent.processActive);
	const attentionAgents = status.agents.filter((agent) => !agent.processActive && !["completed", "failed", "protocol_failed", "cancelled"].includes(agent.state));
	const active = status.runs.filter((run) => {
		if (run.state.startsWith("waiting_")) return true;
		if (run.state !== "running" || run.handoffReady) return false;
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
	let modelTierProfile: string | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let sessionShuttingDown = false;
	const worktreeOperations = new Set<AbortController>();
	const supervisor = new SubagentSupervisor();
	const syncRuntimeModelTierProfile = (runtime: HarnessRuntime): HarnessRuntime => {
		if (modelTierProfile && runtime.config.modelTierProfile !== modelTierProfile) runtime.config = loadHarnessConfig(runtime.identity.root, { modelTierProfile }).config;
		return runtime;
	};
	resetActiveFastModePolicy();
	pi.events.on(FAST_MODE_POLICY_EVENT, (value: unknown) => {
		const policy = normalizeFastModePolicy(value);
		if (policy) setActiveFastModePolicy(policy);
	});
	pi.events.on(MODEL_TIER_PROFILE_EVENT, (value: unknown) => {
		const policy = normalizeModelTierProfilePolicy(value);
		if (!policy) return;
		modelTierProfile = policy.profile;
		if (sessionRuntime) syncRuntimeModelTierProfile(sessionRuntime);
	});
	registerWorkerCapabilities(pi);
	registerEvaluatorCapabilities(pi);

	pi.on("tool_call", (event) => {
		if (event.toolName !== "mcp") return;
		const allowedServers = configuredMcpServerAllowlist();
		if (allowedServers === undefined) return;
		return authorizeMcpProxyCall(event.input as Record<string, unknown>, allowedServers);
	});

	const runtimeFor = async (ctx: ExtensionContext): Promise<HarnessRuntime> => {
		if (sessionRuntime?.identity.root === ctx.cwd || sessionRuntime?.identity.root === (await discoverRepository(ctx.cwd)).root) {
			return sessionRuntime;
		}
		return syncRuntimeModelTierProfile(await createRuntime(ctx, modelTierProfile));
	};

	const runWorktreeOperation = async <T>(
		ctx: ExtensionContext,
		label: string,
		operation: (signal: AbortSignal, onProgress: (progress: WorktreeProgress) => void) => Promise<T>,
	): Promise<T> => {
		const shutdownController = new AbortController();
		worktreeOperations.add(shutdownController);
		const update = (progress: WorktreeProgress) => {
			if (ctx.hasUI && !sessionShuttingDown) ctx.ui.setStatus("pibox-worktrees", formatWorktreeProgress(progress));
		};
		try {
			if (ctx.mode !== "tui") return await operation(shutdownController.signal, update);
			type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
			const outcome = await ctx.ui.custom<Outcome>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, label);
				const signal = AbortSignal.any([shutdownController.signal, loader.signal]);
				loader.onAbort = () => {
					if (ctx.hasUI) ctx.ui.setStatus("pibox-worktrees", "Cancelling after the current safe boundary…");
				};
				operation(signal, update).then(
					(value) => done({ ok: true, value }),
					(error) => done({ ok: false, error }),
				);
				return loader;
			});
			if (!outcome) throw new Error("PiBox worktree operation closed without a result");
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		} finally {
			worktreeOperations.delete(shutdownController);
			if (ctx.hasUI && !sessionShuttingDown) ctx.ui.setStatus("pibox-worktrees", undefined);
		}
	};

	const initializeRepository = async (ctx: ExtensionContext, profile: HarnessScaffoldProfile, overwrite = false): Promise<{ runtime: HarnessRuntime; scaffold: HarnessScaffoldResult }> => {
		requireTrusted(ctx);
		const initialize = () => initializeHarnessRepository(ctx.cwd, profile, overwrite);
		const scaffold = sessionRuntime
			? await sessionRuntime.mutex.run(`init:${profile}`, initialize)
			: await initialize();
		sessionRuntime = syncRuntimeModelTierProfile(await createRuntime(ctx, modelTierProfile));
		await sessionRuntime.events.append("repository.scaffolded", scaffold);
		return { runtime: sessionRuntime, scaffold };
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
			if (!isTierTaskAssignment(task.execution.assignment)) throw new HarnessError("CONFIG_INVALID", `Task ${task.id} uses a legacy model assignment. Replan it with a capability tier before execution.`);
			const plannedRouting = { tier: task.execution.assignment.tier };
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
			const launch = () => supervisor.launchTask({
				identity: runtime.identity,
				workItemId: item.id,
				task,
				persistentContext,
				workspace: allocation.path,
				branch: allocation.branch,
				baseCommit: allocation.baseCommit,
				executionMode: allocation.isolation,
				planningRevision: item.planning.revision,
				model: { provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, providerCandidates: resolution.candidates, requested: plannedRouting.tier, capabilityTier: plannedRouting.tier },
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
			// Repository children may commit in the canonical checkout. Hold the
			// common-dir lock until the child exits and handoff settlement finishes.
			// Isolated worktree children have distinct indexes and remain parallel.
			const launched = await runManagedChild(runtime.mutex, allocation.isolation, `task-child:${item.id}:${task.id}`, launch);
			await runtime.events.append("task.run_settled", { workItemId: item.id, taskId: task.id, runId: launched.run.id, state: launched.run.state });
			const settledRoute = `${launched.run.resolvedProvider ?? resolution.model.provider}/${launched.run.resolvedModel ?? resolution.model.id}#${launched.run.resolvedEffort ?? resolution.effort}`;
			return textResult(
				`Task ${task.id} settled as ${launched.run.state} on ${settledRoute} for ${plannedRouting.tier}${resolution.fallbackUsed ? " (visible same-tier fallback)" : ""}.${launched.handoff ? `\n${launched.handoff.summary}` : launched.finalText ? `\n${launched.finalText}` : ""}`,
				launched,
			);
		} catch (error) {
			throw new Error(describeHarnessError(error));
		} finally {
			await locks?.release();
		}
	};

	const launchManagedIntegrationRepair = async (ctx: ExtensionContext, workItemId: string, stageId: string, taskIds: string[], evidencePath: string, signal?: AbortSignal) => {
		const runtime = await runtimeFor(ctx);
		return runtime.mutex.run(`integration-repair:${workItemId}:${stageId}`, () => launchManagedIntegrationRepairUnlocked(ctx, workItemId, stageId, taskIds, evidencePath, signal));
	};

	const launchManagedIntegrationRepairUnlocked = async (ctx: ExtensionContext, workItemId: string, stageId: string, taskIds: string[], evidencePath: string, signal?: AbortSignal) => {
		requireTrusted(ctx);
		const runtime = await runtimeFor(ctx);
		const item = await runtime.workItems.read(workItemId);
		const task = await runtime.workItems.readTask(workItemId, taskIds[0]!);
		const agentDefinition = runtime.config.agents["repair-implementer"];
		if (!agentDefinition) throw new HarnessError("CONFIG_INVALID", "Missing repair-implementer agent definition");
		const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		const resolution = resolveHarnessModel(runtime.config, available, { tier: "medium" });
		if (resolution.status === "waiting_model") throw new HarnessError("MODEL_UNAVAILABLE", "No medium repair model is available");
		const manager = new WorktreeManager(runtime.identity);
		const operationBase = `integration-repair:${workItemId}:${stageId}`;
		const historical = (await runtime.agents.list()).filter((agent) => agent.operationId === operationBase || agent.operationId.startsWith(`${operationBase}:legacy:`));
		// New integration workers stay reported (submitted) until candidate CI is
		// green. A terminal legacy worker remains immutable and receives a one-time
		// successor identity for migration to the submission/CI lifecycle.
		let owner = historical.find((agent) => !["completed", "failed", "protocol_failed", "cancelled"].includes(agent.state));
		const operationId = owner ? owner.operationId : historical.length > 0 ? `${operationBase}:legacy:r${item.planning.revision}` : operationBase;
		let activeEvidencePath = evidencePath;
		for (let generation = 1; generation <= 3; generation++) {
			const failure = await manager.activeConflict(workItemId);
			if (!failure) throw new HarnessError("INVALID_ARTIFACT", `Integration repair ${stageId} has no deterministic failure evidence`);
			if ((failure.repairGeneration ?? 0) >= 3) throw new HarnessError("INVALID_HANDOFF", `Integration repair exhausted after ${failure.repairGeneration} deterministic CI generations for ${workItemId}/${stageId}`, { stageId, evidencePath: failure.evidencePath, failureSignature: failure.failureSignature });
			activeEvidencePath = failure.evidencePath;
			const prompt = [
				`Integration candidate ${failure.candidateCommit} for stage ${stageId} is red (${failure.kind}).`,
				`Continue as the stage integration owner in ${failure.candidatePath}.`,
				failure.ownerTaskId ? `The failure surfaced while applying ${failure.ownerTaskId} at train position ${failure.position ?? "unknown"}.` : "The complete combined candidate owns this failure.",
				failure.checkId ? `Failed check: ${failure.checkId}${failure.command ? ` — ${failure.command}` : ""}.` : "Resolve the recorded merge conflict.",
				failure.attemptPath ? `Durable CI evidence: ${join(runtime.identity.root, failure.attemptPath)}.` : `Private integration evidence: ${failure.evidencePath}.`,
				"Resolve only the surfaced deterministic issue, preserve all contribution commits and reviewed contracts, commit the candidate repair, keep the candidate worktree clean, and resubmit. Do not alter task topology, the canonical working branch, or spawn another agent.",
			].join("\n");
			const launched = await runtime.coordinator.launch({
				operationId,
				...(owner ? { existingAgentId: owner.id } : {}),
				role: "repair-implementer", task: prompt,
				assignment: { schemaVersion: 1, workItemId, stageId, taskIds, managerPrompt: prompt, generation }, cwd: failure.candidatePath,
				provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, capabilityTier: "medium", providerCandidates: resolution.candidates,
				tools: resolveToolSelectors(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS), workItemId,
				workspace: failure.candidatePath, additionalPrompt: readBuiltInPrompt("workflow-repair-agent"), deferCompletion: true,
				persistentContext: `${await buildTaskPersistentContext(runtime.workItems, workItemId, task)}\n\n${prompt}`,
				env: mcpLaunchEnvironment(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS), ...(signal ? { signal } : {}),
				promptPath: agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) ? resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string : join(BUILT_IN_AGENT_ROOT, "repair-implementer.md"),
			});
			owner = launched.agent;
			if (launched.result.exitCode !== 0) throw new HarnessError("INVALID_HANDOFF", launched.result.stderr || "Integration repair agent failed");
			try {
				const integrated = await manager.settleIntegrationRepair(workItemId, stageId, taskIds, activeEvidencePath);
				await runtime.agents.transition(owner.id, "completed", { summary: `Integration candidate ${integrated.commit.slice(0, 12)} passed CI` });
				return textResult(`Managed integration repair for ${item.id}/${stageId} completed at ${integrated.commit.slice(0, 12)} with ${integrated.checks.length} harness check(s).`, { agentId: owner.id, stageId, taskIds, integratedCommit: integrated.commit, checks: integrated.checks });
			} catch (error) {
				if (!(error instanceof HarnessError) || error.details.workerRoutable !== true || generation === 3) throw error;
				// The reported logical worker remains resumable. The next process attempt
				// receives the new post-repair CI evidence in the same Pi session.
			}
		}
		throw new HarnessError("INVALID_HANDOFF", `Integration repair exhausted for ${workItemId}/${stageId}`);
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
		const routing = { tier: agentDefinition.tier! };
		const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		const resolution = resolveHarnessModel(runtime.config, available, routing);
		if (resolution.status === "waiting_model") throw new HarnessError("MODEL_UNAVAILABLE", "No repair model is available");
		const existing = loop.fixerAgentId ? await runtime.agents.get(loop.fixerAgentId).catch(() => undefined) : undefined;
		const repairIteration = loop.iteration + 1;
		const operationBase = `repair:${workItemId}:${evaluationId}:${repairIteration}`;
		const priorAttempts = (await runtime.agents.list()).filter((agent) => agent.operationId === operationBase || agent.operationId.startsWith(`${operationBase}:retry:`));
		const operationId = priorAttempts.length === 0 ? operationBase : `${operationBase}:retry:${priorAttempts.length}`;
		const persistentContext = await buildReviewPersistentContext(runtime.workItems, workItemId, evaluation);
		// Repair implementers work in the canonical checkout and may commit there.
		// Keep the common-dir lock for the child lifetime and settlement; unlike
		// evaluators, repair agents do not need evaluation_record while running.
		return runtime.mutex.run(`repair-child:${workItemId}:${evaluationId}`, async () => {
			let launched: Awaited<ReturnType<LaunchCoordinator["launch"]>> | undefined;
			try {
				if (existing?.state === "reserved") {
					const recovery = await new RepairRecoveryStore(runtime.identity).read(workItemId, evaluationId);
					if (!recovery || recovery.agentId !== existing.id) throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Retry-ready fixer ${existing.id} has no matching durable repair recovery record`);
					await new RepairRecoveryStore(runtime.identity).assertCurrent(recovery);
				} else await assertCleanRepository(runtime.identity.root);
				launched = await runtime.coordinator.launch({
					operationId, ...(existing ? { existingAgentId: existing.id } : {}), role: "repair-implementer",
					task: renderBuiltInPrompt("managed-repair", { evaluationId, iteration: repairIteration, managerPrompt: loop.managerPrompt! }),
					assignment: { schemaVersion: 1, workItemId, evaluationId, iteration: repairIteration, managerPrompt: loop.managerPrompt! }, cwd: runtime.identity.root,
					activity: { kind: "repair", generation: repairIteration },
					provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, capabilityTier: routing.tier, providerCandidates: resolution.candidates, tools: resolveToolSelectors(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS),
					workItemId, evaluationId, workspace: runtime.identity.root, additionalPrompt: readBuiltInPrompt("workflow-repair-agent"), persistentContext, deferCompletion: true,
					env: mcpLaunchEnvironment(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS), ...(signal ? { signal } : {}),
					promptPath: agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) ? resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string : join(BUILT_IN_AGENT_ROOT, "repair-implementer.md"),
				});
				if (launched.result.exitCode !== 0) throw new HarnessError("INVALID_HANDOFF", launched.result.stderr || "Repair agent failed");
				const settledFixerId = launched.agent.id;
				await assertCleanRepository(runtime.identity.root);
				await runtime.mutex.run(`repair-settled:${workItemId}:${evaluationId}`, () => runtime.workItems.updateEvaluationLoop(workItemId, evaluationId, { state: "rereviewing", iteration: repairIteration, fixerAgentId: settledFixerId }, "planned"));
				await new RepairRecoveryStore(runtime.identity).clear(workItemId, evaluationId);
				return textResult(`Repair iteration ${repairIteration} completed for ${evaluationId}; the same reviewer will re-review.`, { agentId: settledFixerId, iteration: repairIteration });
			} catch (error) {
				const fixerAgentId = launched?.agent.id ?? existing?.id;
				let stateRecoveryError: unknown;
				try {
					await runtime.mutex.run(`repair-failed:${workItemId}:${evaluationId}`, () => runtime.workItems.updateEvaluationLoop(workItemId, evaluationId, { state: "fixing", iteration: loop.iteration, managerPrompt: loop.managerPrompt!, ...(fixerAgentId ? { fixerAgentId } : {}) }, evaluation.status));
				} catch (recoveryError) {
					stateRecoveryError = recoveryError;
				}
				let recordRecoveryError: unknown;
				if (fixerAgentId) {
					try {
						// Persist the exact post-failure workspace even when restoring loop
						// metadata failed, so explicit recovery never depends on that commit.
						await new RepairRecoveryStore(runtime.identity).record({ workItemId, evaluationId, agentId: fixerAgentId, operationId, iteration: repairIteration });
					} catch (recoveryError) {
						recordRecoveryError = recoveryError;
					}
				}
				if (stateRecoveryError || recordRecoveryError) {
					const message = (value: unknown) => value instanceof Error ? value.message : String(value);
					throw new HarnessError("INVALID_HANDOFF", `Repair failed: ${message(error)}; recovery persistence failed: ${[stateRecoveryError, recordRecoveryError].filter((value) => value !== undefined).map(message).join("; ")}`, { workItemId, evaluationId, fixerAgentId, originalError: message(error) });
				}
				throw error;
			}
		});
	};

	const launchManagedEvaluation = async (ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal) => {
		requireTrusted(ctx);
		const runtime = await runtimeFor(ctx);
		const item = await runtime.workItems.read(workItemId);
		const evaluation = await runtime.workItems.readEvaluation(item.id, evaluationId);
		if (evaluation.attempt >= runtime.config.limits.repairRounds + 1) throw new HarnessError("INVALID_HANDOFF", `Evaluation repair budget exhausted for ${evaluation.id}`);
		const agentName = evaluation.type === "e2e" ? "e2e-tester" : "code-reviewer";
		const agentDefinition = runtime.config.agents[agentName];
		if (!agentDefinition) throw new HarnessError("CONFIG_INVALID", `Missing evaluator agent definition: ${agentName}`);
		const stagePolicy = evaluation.checkpoint === "stage-review" ? item.executionStages?.find((stage) => stage.id === evaluation.stageId)?.review : undefined;
		const routing = { tier: evaluation.checkpoint === "stage-review" ? (stagePolicy?.tier ?? "medium") : agentDefinition.tier! };
		const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		const resolution = resolveHarnessModel(runtime.config, available, routing);
		if (resolution.status === "waiting_model") return textResult("MODEL_UNAVAILABLE: No evaluator candidate is available.", resolution);
		await runtime.mutex.run(`evaluation-preflight:${item.id}:${evaluation.id}`, () => assertCleanRepository(runtime.identity.root));
		const runs = new HarnessRunStore(runtime.identity, item.id);
		const created = await runs.create({
			repositoryId: runtime.identity.id, workItemId: item.id, evaluationId: evaluation.id, role: agentName,
			attempt: evaluation.attempt + 1, state: "running", workspace: runtime.identity.root,
			baseCommit: await runGit(runtime.identity.root, ["rev-parse", "HEAD"]), planningRevision: item.planning.revision,
			requestedModel: routing.tier, resolvedProvider: resolution.model.provider,
			resolvedModel: resolution.model.id, resolvedEffort: resolution.effort,
		});
		const reviewedCommit = await runGit(runtime.identity.root, ["rev-parse", "HEAD"]);
		const prompt = renderBuiltInPrompt("managed-evaluation", {
			phase: evaluation.loop?.state === "rereviewing" ? `Re-review iteration ${evaluation.loop.iteration}` : "Evaluate",
			evaluationId: evaluation.id,
			evaluationType: evaluation.type,
			workItemId: item.id,
		});
		const persistentContext = await buildReviewPersistentContext(runtime.workItems, item.id, evaluation, reviewedCommit);
		const persistedReviewerAgentId = evaluation.loop?.reviewerAgentId;
		let logicalAgentId = await reusableReviewerAgentId(runtime.agents, persistedReviewerAgentId);
		if (persistedReviewerAgentId && !logicalAgentId) {
			await runtime.events.append("evaluation.reviewer_replaced", { workItemId: item.id, evaluationId: evaluation.id, priorReviewerAgentId: persistedReviewerAgentId, reason: "missing-or-terminal" });
		}
		const runEvaluator = async (taskPrompt: string) => {
			const coordinated = await runtime.coordinator.launch({
				operationId: created.record.id, ...(logicalAgentId ? { existingAgentId: logicalAgentId } : {}), role: agentName, task: taskPrompt,
				assignment: { schemaVersion: 1, workItemId: item.id, evaluationId: evaluation.id, planningRevision: item.planning.revision },
				activity: { kind: "review", generation: evaluation.loop?.state === "rereviewing" ? evaluation.loop.iteration : 0 },
				cwd: runtime.identity.root, provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, capabilityTier: routing.tier, providerCandidates: resolution.candidates,
				tools: resolveToolSelectors(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS, [PIBOX_EVALUATION_TOOL_GROUP]),
				deferCompletion: true, workItemId: item.id, evaluationId: evaluation.id, runId: created.record.id, workspace: runtime.identity.root, additionalPrompt: readBuiltInPrompt("workflow-review-agent"), persistentContext,
				env: { ...mcpLaunchEnvironment(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS), PIBOX_HARNESS_RUN_ID: created.record.id, PIBOX_HARNESS_WORK_ITEM: item.id, PIBOX_HARNESS_EVALUATION: evaluation.id, PIBOX_HARNESS_CREDENTIAL: created.credential },
				promptPath: agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) ? resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string : join(BUILT_IN_AGENT_ROOT, `${agentName}.md`),
				onSpawn: (pid) => void runs.update(created.record.id, { ...(pid === undefined ? {} : { pid }) }, "run.process_started"),
				...(signal ? { signal } : {}),
			});
			logicalAgentId = coordinated.agent.id;
			if (coordinated.result.provider !== resolution.model.provider || coordinated.result.model !== resolution.model.id || coordinated.result.effort !== resolution.effort) {
				await runs.update(created.record.id, {
					resolvedProvider: coordinated.result.provider,
					resolvedModel: coordinated.result.model,
					resolvedEffort: coordinated.result.effort,
				}, "run.provider_fallback");
			}
			return coordinated.result;
		};
		let direct = await runEvaluator(prompt);
		if (logicalAgentId && (await runtime.agents.get(logicalAgentId)).state === "waiting_capacity") {
			await runs.update(created.record.id, { state: "waiting_capacity", exitCode: direct.exitCode, error: direct.stderr || "Every configured provider route is temporarily unavailable" }, "run.waiting_capacity");
			return textResult(`WAITING_CAPACITY: Evaluator ${evaluation.id} exhausted its currently available provider routes.`, { runId: created.record.id, agentId: logicalAgentId, direct });
		}
		let handoff = await runs.readEvaluationHandoff(created.record.id);
		if (!handoff && direct.exitCode === 0) {
			await runs.appendEvent(created.record.id, "run.protocol_nudge", { evaluationId: evaluation.id });
			direct = await runEvaluator(`${readBuiltInPrompt("evaluation-protocol-nudge")}\n\n${prompt}`);
			if (logicalAgentId && (await runtime.agents.get(logicalAgentId)).state === "waiting_capacity") {
				await runs.update(created.record.id, { state: "waiting_capacity", exitCode: direct.exitCode, error: direct.stderr || "Every configured provider route is temporarily unavailable" }, "run.waiting_capacity");
				return textResult(`WAITING_CAPACITY: Evaluator ${evaluation.id} exhausted its currently available provider routes.`, { runId: created.record.id, agentId: logicalAgentId, direct });
			}
			handoff = await runs.readEvaluationHandoff(created.record.id);
		}
		if (!handoff || handoff.runId !== created.record.id || handoff.evaluationId !== evaluation.id) {
			await runs.update(created.record.id, { state: "protocol_failed", exitCode: direct.exitCode, error: "Missing or invalid evaluation_complete handoff" }, "run.protocol_failed");
			if (logicalAgentId) await runtime.agents.transition(logicalAgentId, "protocol_failed", { error: "Missing or invalid evaluation_complete handoff" }).catch(() => undefined);
			return textResult(`PROTOCOL_FAILED: Evaluator ${evaluation.id} omitted its structured handoff.`, { runId: created.record.id, agentId: logicalAgentId, direct });
		}
		if (!logicalAgentId) throw new HarnessError("INVALID_HANDOFF", `Evaluator ${evaluation.id} completed without a logical agent identity`);
		const settlement = await settleManagedEvaluation({
			workItems: runtime.workItems,
			runs,
			workItemId: item.id,
			evaluationId: evaluation.id,
			runId: created.record.id,
			handoff,
			reviewerAgentId: logicalAgentId,
			reviewedCommit,
			exitCode: direct.exitCode,
			completionEvent: "run.completed",
		});
		await finalizeReviewerAfterSettlement(runtime.agents, logicalAgentId, handoff.verdict);
		await runtime.events.append("evaluation.run_completed", { workItemId: item.id, evaluationId: evaluation.id, runId: created.record.id, agentId: logicalAgentId, verdict: handoff.verdict });
		return textResult(`Evaluation ${evaluation.id} recorded ${handoff.verdict} on attempt ${settlement.evaluation.attempt}.`, { runId: created.record.id, agentId: logicalAgentId, evaluation: settlement.evaluation, handoff });
	};

	const spawnDynamicSubagent = async (request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void, onStarted?: (status: DynamicSubagentStarted) => void, onProgress?: (progress: AgentProgress) => void): Promise<WorkflowRunResult> => {
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
			if (request.effort && !request.model) throw new HarnessError("INVALID_ARTIFACT", "An explicit effort preference requires an explicit model preference");
			const selectedModel = request.model ?? agentDefinition.model;
			const preferred = selectedModel
				? normalizeExplicitModelOverride(selectedModel, request.effort as HarnessEffort | undefined)
				: undefined;
			const routing = {
				tier: inferDynamicSubagentTier(request.tier, preferred?.model) as ModelTier,
				...(preferred ? { override: preferred } : {}),
				...(request.model ? { strict: true } : {}),
			};
			const availableModels = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
			const resolution = resolveHarnessModel(runtime.config, availableModels, routing);
			if (resolution.status === "waiting_model") {
				const requestedRoute = preferred ? `${preferred.model}${preferred.effort ? `#${preferred.effort}` : ""}` : "the configured local route list";
				const attempts = resolution.attempts.map((attempt) => `${attempt.provider ? `${attempt.provider}/` : ""}${attempt.model}${attempt.effort ? `#${attempt.effort}` : ""}: ${attempt.status}`).join("; ");
				if (request.model) {
					throw new HarnessError("MODEL_UNAVAILABLE", `Explicit model request ${requestedRoute} failed closed without fallback.${attempts ? ` ${attempts}` : ""}`, { attempts: resolution.attempts });
				}
				if (routing.tier === "local") {
					throw new HarnessError("MODEL_UNAVAILABLE", `Local model request ${requestedRoute} failed closed without fallback.${attempts ? ` ${attempts}` : ""}`, { attempts: resolution.attempts });
				}
				throw new HarnessError("MODEL_UNAVAILABLE", "No configured candidate is available", { attempts: resolution.attempts });
			}
			const launched = await runtime.coordinator.launch({
				operationId: request.operationId, role: request.agent, task: request.task,
				assignment: { schemaVersion: 1, agent: request.agent, task: request.task, ...(request.presentation ? { presentation: request.presentation } : {}), ...(request.tier ? { tier: request.tier } : {}), ...(preferred ? { model: preferred.model, ...(preferred.effort ? { effort: preferred.effort } : {}) } : {}) }, cwd: runtime.identity.root,
				...(request.presentation ? { presentation: request.presentation } : {}),
				provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, capabilityTier: routing.tier, providerCandidates: resolution.candidates,
				tools: resolveToolSelectors(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS),
				workspace: runtime.identity.root,
				env: mcpLaunchEnvironment(agentDefinition.tools ?? DEFAULT_SUBAGENT_TOOLS),
				...(agentDefinition.prompt && resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt)
					? { promptPath: resolveConfiguredPath(runtime.identity.root, agentDefinition.prompt) as string }
					: existsSync(join(BUILT_IN_AGENT_ROOT, `${request.agent}.md`))
						? { promptPath: join(BUILT_IN_AGENT_ROOT, `${request.agent}.md`) }
						: {}),
				...(agentDefinition.skills ? { skillPaths: agentDefinition.skills.map((skill) => resolveConfiguredPath(runtime.identity.root, skill)).filter((path): path is string => Boolean(path)) } : {}),
				...(signal ? { signal } : {}), ...(onText ? { onText } : {}),
				...(onStarted ? { onStarted: (agent: { id: string; provider: string; model: string; effort: string; startedAt: string; currentAttemptId?: string; attempts: Array<{ id: string; fast?: boolean }> }) => {
					const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
					onStarted({ agentId: agent.id, provider: agent.provider, model: agent.model, effort: agent.effort, fast: attempt?.fast === true, startedAt: agent.startedAt });
				} } : {}),
				...(onProgress ? { onProgress } : {}),
			});
			const direct = launched.result;
			await runtime.events.append("subagent.settled", { agentId: launched.agent.id, role: request.agent, exitCode: direct.exitCode, model: `${direct.provider}/${direct.model}`, effort: direct.effort });
			const waitingCapacity = launched.agent.state === "waiting_capacity";
			return {
				ref: `agent:${launched.agent.id}`,
				state: waitingCapacity ? "blocked" : direct.exitCode === 0 ? "completed" : "failed",
				summary: direct.text || direct.stderr || (waitingCapacity ? "Every configured provider route is temporarily unavailable." : `Subagent exited ${direct.exitCode}.`), agentId: launched.agent.id,
				...(direct.exitCode === 0 ? {} : { attention: true }),
			};
		} catch (error) {
			throw new Error(describeHarnessError(error));
		}
	};

	const listSpawnableAgents = async (ctx: ExtensionContext): Promise<SpawnableAgentDefinition[]> => {
		if (!ctx.isProjectTrusted()) return [];
		const runtime = await runtimeFor(ctx);
		const projectAgentRoot = join(runtime.identity.root, ".pi", "agents");
		return Object.entries(runtime.config.agents).sort(([left], [right]) => left.localeCompare(right)).map(([name, definition]) => ({
			name,
			description: definition.description ?? `Configured ${name} agent`,
			tier: definition.tier!,
			source: definition.prompt?.startsWith(projectAgentRoot) ? "project" : definition.prompt?.startsWith(BUILT_IN_AGENT_ROOT) ? "built-in" : "configured",
		}));
	};

	pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: unknown) => {
		const discovery = event as WorkflowAdapterDiscovery;
		discovery.register(createHarnessWorkflowAdapter({
			runtimeFor,
			launchTask: launchManagedTask,
			launchEvaluation: launchManagedEvaluation,
			launchRepair: launchManagedRepair,
			launchIntegrationRepair: launchManagedIntegrationRepair,
			spawnSubagent: spawnDynamicSubagent,
			listSpawnableAgents,
			async reconcileReported(runtime) {
				await reconcileReportedAgents({ identity: runtime.identity, registry: runtime.agents, workItems: runtime.workItems, mutex: runtime.mutex, excludedRunIds: new Set(supervisor.activeRunIds()) });
			},
		}));
	});

	pi.registerTool({
		name: "resource_list",
		label: "List Resources",
		description: "List concise canonical resource summaries. Filter by type or parent work item, then use resource_read for one complete resource.",
		promptSnippet: "List structured story, task, or stage resources",
		parameters: Type.Object({ type: Type.Optional(CANONICAL_RESOURCE_TYPE), parent: Type.Optional(Type.String({ description: "Work-item ref whose children should be listed" })), query: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const runtime = await runtimeFor(ctx);
				const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
				const workItemId = params.parent ? parseResourceRef(params.parent).workItemId : undefined;
				const types: CanonicalResourceType[] = params.type ? [params.type as CanonicalResourceType] : ["work-item", "artifact", "task", "stage", "evaluation"];
				const resources = (await Promise.all(types.map((type) => service.listSummaries(type, workItemId)))).flat();
				const filtered = params.query ? resources.filter((resource) => JSON.stringify(resource).toLowerCase().includes(params.query!.toLowerCase())) : resources;
				return boundedStructuredResult({ count: filtered.length, resources: filtered }, "resource list");
			} catch (error) { throw structuredCapabilityError(error, params.parent); }
		},
	});

	pi.registerTool({
		name: "resource_read",
		label: "Read Resource",
		description: "Read one structured canonical resource. A work-item ref returns its compact manifest and child refs; read each artifact (including e2e-matrix), task, integration unit, or evaluation ref for complete content.",
		promptSnippet: "Read one complete structured workflow resource",
		parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const runtime = await runtimeFor(ctx);
				const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
				const parsed = parseResourceRef(params.ref);
				if (parsed.type === "work-item") {
					const resource = await service.summary(params.ref);
					const childTypes: CanonicalResourceType[] = ["artifact", "task", "stage", "evaluation"];
					const children = (await Promise.all(childTypes.map((type) => service.listSummaries(type, parsed.workItemId)))).flat();
					return boundedStructuredResult({ resource, children }, params.ref);
				}
				return boundedStructuredResult(await service.get(params.ref), params.ref);
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
	});

	pi.registerTool({
		name: "resource_write",
		label: "Write Resource",
		description: "Create or update one planner-owned resource. Planning drafts may be temporarily incomplete; topology diagnostics are advisory here and become blocking when workflow_transition submits the plan. Evaluation resources are harness-owned.",
		promptSnippet: "Create or update one structured story, task, or stage resource; never create evaluations",
		parameters: Type.Object({ ref: Type.Optional(Type.String()), type: Type.Optional(AUTHORABLE_RESOURCE_TYPE), parent: Type.Optional(Type.String()), value: OPEN_OBJECT }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					if (params.ref && (params.type || params.parent)) throw new HarnessError("INVALID_ARTIFACT", "Resource update uses ref and value only");
					if (!params.ref && !params.type) throw new HarnessError("INVALID_ARTIFACT", "Resource creation requires type");
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					const before = params.ref ? await service.get(params.ref) : undefined;
					const authority: MutationAuthority = { rationale: params.ref ? "Update the selected canonical resource" : "Create the authored canonical resource" };
					let ref: string;
					let result;
					if (params.ref) {
						const parsed = parseResourceRef(params.ref);
						const authoredValue = parsed.type === "artifact"
							? (() => { const normalized = normalizeResourceArtifact({ ...params.value, id: parsed.id }); return { type: normalized.type, title: normalized.title, sections: normalized.sections }; })()
							: params.value;
						const edit = normalizePlanEdit(parsed.type, "update", params.ref, authoredValue, parsed.workItemId);
						result = await service.transaction(`harness: write ${params.ref}`, () => service.patch(params.ref!, edit.value, { authority }));
						ref = params.ref;
					} else {
						const type = params.type as CanonicalResourceType;
						if (type !== "work-item" && !params.parent) throw new HarnessError("INVALID_ARTIFACT", `${type} creation requires parent`);
						const body = compactResourceBody(type, params.value, params.parent);
						ref = createdResourceRef(type, params.parent, body);
						result = await service.transaction(`harness: write ${ref}`, () => service.create(type, params.parent, body, authority));
					}
					const after = await service.get(ref);
					const planningTopology = await draftTopologyReceipt(runtime, ref);
					await runtime.events.append("resource.written", { ref, commit: result.commit, planningTopology });
					const receipt = await mutationReceipt(runtime, result.commit, [{ action: params.ref ? "patch" : "create", ref }], { planningTopology });
					const draftNotice = planningTopology.valid ? "Draft topology: valid." : `Draft topology: ${planningTopology.issues.length} advisory issue${planningTopology.issues.length === 1 ? "" : "s"}; submission will compile the complete plan.`;
					return textResult(`Wrote ${ref}.\n${draftNotice}\n${JSON.stringify(receipt, null, 2)}`, {
						...receipt,
						piboxResourceDiff: resourceDisplayDiff(params.ref ? "update" : "create", ref, before, after),
					});
				});
			} catch (error) { throw structuredCapabilityError(error, params.ref ?? params.parent); }
		},
	});

	pi.registerTool({
		name: "resource_delete",
		label: "Delete Resource",
		description: "Delete one undelivered child resource by ref. Work items and delivered history remain protected.",
		parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const service = new OrchestratorResourceService(runtime.identity.root, runtime.workItems, runtime.config);
					const before = await service.get(params.ref);
					const result = await service.transaction(`harness: delete ${params.ref}`, () => service.delete(params.ref, { authority: { rationale: "Delete the selected undelivered resource" } }));
					const planningTopology = await draftTopologyReceipt(runtime, params.ref);
					const receipt = await mutationReceipt(runtime, result.commit, [{ action: "delete", ref: params.ref }], { planningTopology });
					return textResult(`Deleted ${params.ref}.\n${planningTopology.valid ? "Draft topology: valid." : `Draft topology: ${planningTopology.issues.length} advisory issue${planningTopology.issues.length === 1 ? "" : "s"}.`}\n${JSON.stringify(receipt, null, 2)}`, {
						...receipt,
						piboxResourceDiff: resourceDisplayDiff("delete", params.ref, before, undefined),
					});
				});
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
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
					const runs = (await Promise.all(items.map((item) => new HarnessRunStore(runtime.identity, item.id).list()))).flat();
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
		description: "Write tasks and ordered stages for a workflow plan. Stage checks and optional medium/high review policy are planner-owned; all evaluation resources are harness-owned. Use create, complete update, or revision-pinned surgical edit. Read workflow_schema operation=plan-write for exact fields.",
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
					const planningTopologies = await Promise.all([...baselines.keys()].map(async (workItemId) => ({ ref: `work-item:${workItemId}`, ...await draftTopologyReceipt(runtime, `work-item:${workItemId}`) })));
					const receipt = await mutationReceipt(runtime, result.commit, changes, { ...(message ? { message: { id: message.id, status: message.status, agentId: message.agentId } } : {}), planningTopologies });
					return textResult(`Applied ${operations.length} canonical operation(s)${result.commit ? ` as ${result.commit.slice(0, 12)}` : ""}.\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error); }
		},
	});

	pi.registerTool({
		name: "workflow_transition",
		label: "Transition Workflow Resource",
		description: "Apply an explicit lifecycle action. Submit compiles the complete plan. Reopen resumes an archived planning item, but forks a linked editable amendment when the target is completed so delivered history remains immutable; use the returned amendment ref for subsequent mutations.",
		parameters: Type.Object({ ref: Type.String(), action: Type.Union([Type.Literal("submit"), Type.Literal("postpone"), Type.Literal("resume"), Type.Literal("archive"), Type.Literal("reopen"), Type.Literal("request-user"), Type.Literal("blocked"), Type.Literal("ready"), Type.Literal("reviewing"), Type.Literal("changes_requested"), Type.Literal("paused"), Type.Literal("cancelled")]), reason: Type.String() }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const ref = parseResourceRef(params.ref);
					let transitionedWorkItem;
					if (ref.type === "work-item" && params.action === "submit") transitionedWorkItem = await runtime.workItems.submitPlanning(ref.id);
					else if (ref.type === "work-item" && ["postpone", "resume", "archive", "reopen", "request-user"].includes(params.action)) transitionedWorkItem = await runtime.workItems.transitionWorkItem(ref.id, params.action as "postpone" | "resume" | "archive" | "reopen" | "request-user", params.reason);
					else if (ref.type === "task") await runtime.workItems.updateTask(ref.workItemId, ref.id, { status: params.action as TaskManifest["status"] });
					else throw new HarnessError("CAPABILITY_DENIED", `Unsupported transition ${params.action} for ${ref.type}`);
					const amendmentRef = ref.type === "work-item" && params.action === "reopen" && transitionedWorkItem?.id !== ref.id ? `work-item:${transitionedWorkItem!.id}` : undefined;
					const changes: Array<{ action: "create" | "transition"; ref: string }> = [{ action: "transition", ref: params.ref }, ...(amendmentRef ? [{ action: "create" as const, ref: amendmentRef }] : [])];
					const receipt = await mutationReceipt(runtime, await runGit(runtime.identity.root, ["rev-parse", "HEAD"]), changes, { transition: params.action, ...(amendmentRef ? { amendmentRef, baselineRef: params.ref } : {}) });
					const handoff = ref.type === "work-item" && params.action === "submit"
						? `\nPlan review is complete. Ask the user to review or request changes; if they want execution, they can simply say “start the workflow.” No separate approval command is required.`
						: amendmentRef
							? `\nThe completed baseline remains immutable. Continue shaping and planning against ${amendmentRef}; use ${params.ref} only as read-only baseline context.`
							: "";
					return textResult(`${params.ref} transitioned to ${params.action}${amendmentRef ? ` as ${amendmentRef}` : ""}.${handoff}\n${JSON.stringify(receipt, null, 2)}`, receipt);
				});
			} catch (error) { throw structuredCapabilityError(error, params.ref); }
		},
	});

	pi.registerTool({
		name: "workflow_init",
		label: "Initialize Workflow Repository",
		description: "Initialize a safe Git/develop boundary, scaffold explicit repository-local PiBox policy and runtime ignores, and commit harness-owned setup. Refuses to stage pre-existing project files.",
		promptSnippet: "Initialize Git, develop, and repository-local workflow policy before creating managed work",
		parameters: Type.Object({
			profile: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("economy")])),
			overwrite: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			try {
				const { scaffold } = await initializeRepository(ctx, params.profile ?? "standard", params.overwrite ?? false);
				return textResult(
					scaffold.created
						? `Initialized ${scaffold.profile} workflow policy on develop at ${scaffold.commit?.slice(0, 12)}${scaffold.gitInitialized ? "; Git was initialized" : ""}.`
						: scaffold.worktreeIgnoreAdded
							? `Workflow policy already exists; committed repository-local runtime ignores on develop at ${scaffold.commit?.slice(0, 12)}.`
							: "Workflow policy, develop branch, and repository-local runtime ignores already exist and are valid.",
					scaffold,
				);
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "task_integrate",
		label: "Merge Workflow Task",
		description: "Compatibility merge capability. Merge one accepted task contribution into the checked-out working branch and run its declared post-merge checks.",
		parameters: Type.Object({ workItemId: Type.String(), integrationUnit: Type.String({ description: "Legacy parameter containing the task id to merge." }), checks: Type.Optional(Type.Array(Type.String({ description: "Optional shell-command override; omitted uses the task manifest's declared checks." }))) }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const manager = new WorktreeManager(runtime.identity);
					const integrated = await manager.mergeTask(params.workItemId, params.integrationUnit, params.checks);
					await runtime.events.append("task.merged", integrated);
					return textResult(`Merged ${integrated.taskId} into the working branch as ${integrated.commit.slice(0, 12)}.`, integrated);
				});
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "evaluation_record",
		label: "Record Workflow Evaluation",
		description: "Atomically record a completed planned evaluation, curated report, and checksummed evidence manifest. Evidence paths must name individual sanitized regular files; directories are not accepted.",
		parameters: Type.Object({
			workItemId: Type.String(),
			evaluationId: Type.String(),
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked"), Type.Literal("not_applicable")]),
			report: Type.String({ description: "Evaluation observations; canonical report headings are rendered deterministically." }),
			residualRisks: Type.Optional(Type.Array(Type.String())),
			evidence: Type.Optional(Type.Array(Type.Object({ command: Type.Optional(Type.String()), result: Type.String(), path: Type.Optional(Type.String({ description: "Optional repository or temporary regular-file path. Directories are unsupported; provide a specific sanitized file." })), description: Type.Optional(Type.String()) }))),
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
		description: "Apply the completion gate and render a structured outcome from delivered work, canonical verification, deviations, findings, and residual risk. Pass the bare work-item ID with outcomeSections. Legacy schema-v1 callers may pass outcome Markdown instead. The gate creates outcome.md when absent.",
		// Keep a top-level object schema: strict OpenAI-compatible servers discard
		// discoverability when a function's parameter root is an anyOf union.
		parameters: Type.Object({
			workItemId: Type.String({ description: "Bare work-item ID, for example checkout; do not pass work-item:checkout." }),
			outcomeSections: Type.Optional(Type.Object({
				delivered: Type.Array(Type.String()),
				deviations: Type.Optional(Type.Array(Type.String())),
				residualRisks: Type.Optional(Type.Array(Type.String())),
				followUp: Type.Optional(Type.Array(Type.String())),
			}, { additionalProperties: false })),
			outcome: Type.Optional(Type.String({ description: "Legacy schema-v1 outcome Markdown; do not combine with outcomeSections." })),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const hasSections = params.outcomeSections !== undefined;
				const hasLegacyOutcome = params.outcome !== undefined;
				if (hasSections === hasLegacyOutcome) throw new HarnessError("INVALID_ARTIFACT", "Provide exactly one of outcomeSections or outcome");
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = hasLegacyOutcome
						? await runtime.workItems.completeWorkItem(params.workItemId, params.outcome)
						: await runtime.workItems.completeWorkItem(params.workItemId, undefined, params.outcomeSections);
					await runtime.events.append("work_item.completed", { workItemId: item.id });
					await cleanupCompletedWorkItem(runtime.identity, item.id).catch(async () => {
						// Completion and its semantic event are already durable. Preserve the
						// prior narrow cleanup as a safe fallback without rolling either back.
						await runtime.agents.cleanupWorkItemTransport(item.id).catch(() => undefined);
					});
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
				if (command === "init" && extra.length === 0 && (!target || target === "standard" || target === "economy")) {
					const profile = (target ?? "standard") as HarnessScaffoldProfile;
					const { scaffold } = await initializeRepository(ctx, profile);
					ctx.ui.notify(scaffold.created ? `Initialized ${profile} workflow policy on develop and committed it.` : "Workflow policy, develop branch, and runtime ignores already exist and are valid.", "info");
					return;
				}
				const runtime = await runtimeFor(ctx);
				if (command === "status" && !target) {
					ctx.ui.notify(formatStatus(await snapshot(runtime)), "info");
					return;
				}
				if (command === "recover" && !target) {
					const staleLockRecovered = await runtime.mutex.recoverStale();
					const recovered = [];
					for (const item of await runtime.workItems.list()) {
						recovered.push(...(await new HarnessRunStore(runtime.identity, item.id).recoverInterrupted()));
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
		description: "Initialize PiBox or manage operational state: init [standard|economy] | worktrees [...]",
		handler: async (args, ctx) => {
			const [command, action = "list", target, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			const usage = "Usage: /harness init [standard|economy] | worktrees [sizes | cleanupAll | remove <work-item/task> [--force]]";
			try {
				if (command === "init" && !target && extra.length === 0 && (action === "list" || action === "standard" || action === "economy")) {
					const profile = (action === "list" ? "standard" : action) as HarnessScaffoldProfile;
					const { scaffold } = await initializeRepository(ctx, profile);
					ctx.ui.notify(scaffold.created ? `Initialized ${profile} harness policy on develop and committed it.` : "Harness policy, develop branch, and runtime ignores already exist and are valid.", "info");
					return;
				}
				if (command !== "worktrees") {
					ctx.ui.notify(usage, "warning");
					return;
				}
				const runtime = await runtimeFor(ctx);
				const manager = new WorktreeManager(runtime.identity);
				const includeBytes = (action === "sizes" && !target) || (action === "list" && target === "--sizes" && extra.length === 0);
				if ((action === "list" && !target) || includeBytes) {
					let worktrees;
					try {
						worktrees = await runWorktreeOperation(ctx, includeBytes ? "Measuring PiBox worktrees…" : "Inspecting PiBox worktrees…", (signal, onProgress) =>
							manager.listManaged({ includeBytes, signal, onProgress }));
					} catch (error) {
						if (isAbortError(error)) {
							if (!sessionShuttingDown) ctx.ui.notify("PiBox worktree inspection cancelled.", "info");
							return;
						}
						throw error;
					}
					if (sessionShuttingDown) return;
					const total = worktrees.reduce((sum, worktree) => sum + (worktree.bytes ?? 0), 0);
					const heading = includeBytes ? `PiBox worktrees: ${worktrees.length}, ${formatBytes(total)}` : `PiBox worktrees: ${worktrees.length}`;
					const rows = worktrees.map((worktree) => `${worktree.name} — ${worktree.status}${worktree.active ? ", active" : ""}${worktree.bytes === undefined ? "" : `, ${formatBytes(worktree.bytes)}`}${worktree.branch ? ` (${worktree.branch})` : ""}`);
					ctx.ui.notify(worktrees.length ? `${heading}\n${rows.join("\n")}${includeBytes ? "" : "\nUse /harness worktrees sizes for exact disk usage."}` : "No PiBox worktrees.", "info");
					return;
				}
				if (action === "cleanupAll" && !target) {
					requireTrusted(ctx);
					const removedNames: string[] = [];
					let removed;
					try {
						removed = await runWorktreeOperation(ctx, "Cleaning inactive PiBox worktrees…", (signal, onProgress) => manager.cleanupManaged({
							signal,
							onProgress: (progress) => {
								onProgress(progress);
								if (progress.phase === "removed" && progress.name) removedNames.push(progress.name);
							},
						}));
					} catch (error) {
						if (isAbortError(error)) {
							if (!sessionShuttingDown) {
								await runtime.events.append("worktrees.cleanup_cancelled", { count: removedNames.length, worktrees: removedNames });
								ctx.ui.notify(`PiBox worktree cleanup cancelled${removedNames.length ? ` after removing ${removedNames.length}: ${removedNames.join(", ")}` : " before removing any worktrees"}.`, "warning");
							}
							return;
						}
						throw error;
					}
					if (sessionShuttingDown) return;
					await runtime.events.append("worktrees.cleaned", { count: removed.length, worktrees: removed.map((worktree) => worktree.name) });
					ctx.ui.notify(removed.length ? `Removed ${removed.length} clean inactive PiBox worktree(s): ${removed.map((worktree) => worktree.name).join(", ")}.` : "No clean inactive PiBox worktrees to remove.", "info");
					return;
				}
				if (action === "remove" && target && extra.every((value) => value === "--force")) {
					requireTrusted(ctx);
					const removed = await runWorktreeOperation(ctx, `Removing PiBox worktree ${target}…`, async (signal, onProgress) => {
						onProgress({ phase: "removing", current: 1, total: 1, name: target });
						const result = await manager.removeManaged(target, extra.includes("--force"), { signal });
						onProgress({ phase: "removed", current: 1, total: 1, name: target });
						return result;
					});
					if (sessionShuttingDown) return;
					await runtime.events.append("worktree.removed", { name: removed.name, forced: extra.includes("--force") });
					ctx.ui.notify(`Removed PiBox worktree ${removed.name}. Its branch ${removed.branch ?? "(detached)"} was retained.`, "info");
					return;
				}
				ctx.ui.notify(usage, "warning");
			} catch (error) {
				if (isAbortError(error)) {
					if (!sessionShuttingDown) ctx.ui.notify("PiBox worktree operation cancelled.", "info");
					return;
				}
				ctx.ui.notify(describeHarnessError(error), "error");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (isWorkerProcess() || isEvaluatorProcess() || isSubagentProcess()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_CONTRACT}` };
	});

	pi.on("session_start", async (event, ctx) => {
		sessionShuttingDown = false;
		const disallowed = new Set<string>();
		if (isEvaluatorProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...COMPATIBILITY_RESOURCE_TOOL_NAMES, ...WORKER_TOOL_NAMES].forEach((name) => disallowed.add(name));
		else if (isWorkerProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...COMPATIBILITY_RESOURCE_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES].forEach((name) => disallowed.add(name));
		else if (isSubagentProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...COMPATIBILITY_RESOURCE_TOOL_NAMES, ...WORKER_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES, ...SUBAGENT_CONTROL_TOOLS].forEach((name) => disallowed.add(name));
		else [...COMPATIBILITY_RESOURCE_TOOL_NAMES, ...WORKER_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES].forEach((name) => disallowed.add(name));
		const activeTools = isSubagentProcess() && process.env[ALL_TOOLS_SUBAGENT_ENV] === "1"
			? pi.getAllTools().map((tool) => tool.name)
			: pi.getActiveTools();
		pi.setActiveTools(activeTools.filter((name) => !disallowed.has(name)));
		if (isSubagentProcess()) {
			const agentRoot = process.env.PIBOX_SUBAGENT_ROOT;
			const attemptId = process.env.PIBOX_SUBAGENT_ATTEMPT_ID;
			if (agentRoot && attemptId) {
				const writeHeartbeat = () => atomicWriteFile(join(agentRoot, "attempts", attemptId, "heartbeat.json"), `${JSON.stringify({ agentId: process.env.PIBOX_SUBAGENT_ID, attemptId, pid: process.pid, at: new Date().toISOString() })}\n`, 0o600).catch(() => undefined);
				await writeHeartbeat();
				heartbeatTimer = setInterval(writeHeartbeat, AGENT_HEARTBEAT_INTERVAL_MS);
				heartbeatTimer.unref();
			}
			return;
		}
		if (isWorkerProcess() || isEvaluatorProcess()) return;
		try {
			sessionRuntime = syncRuntimeModelTierProfile(await createRuntime(ctx, modelTierProfile));
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
					recovered.push(...(await new HarnessRunStore(sessionRuntime.identity, item.id).recoverInterrupted()));
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


	pi.on("session_shutdown", async (event) => {
		sessionShuttingDown = true;
		for (const controller of worktreeOperations) controller.abort(new DOMException("PiBox session is shutting down", "AbortError"));
		worktreeOperations.clear();
		resetActiveFastModePolicy();
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
