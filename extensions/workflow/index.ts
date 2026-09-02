import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadHarnessConfig } from "./config.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { initializeHarnessRepository } from "./scaffold.js";
import { discoverRepository, type RepositoryIdentity } from "./repository.js";
import { CanonicalMutationCoordinator } from "./canonical-mutation.js";
import { OrchestratorResourceService, parseResourceRef, type CanonicalResourceType } from "./orchestrator-resources.js";
import { WorkItemStore } from "./work-items.js";
import { StoryRuntimeStore } from "./story-runtime-store.js";
import { registerWorkerCapabilities, isTargetTaskProcess } from "./worker-capabilities.js";
import { registerWorkflowAdapter, type WorkflowAdapterRegistration } from "../workflow-runtime/capability-registry.js";
import { createHarnessWorkflowAdapter } from "./workflow-adapter.js";
import { WorkflowSubagentLauncher } from "../workflow-runtime/subagent-launcher.js";
import { STANDALONE_CHILD_EXTENSION_PATHS } from "../subagent/child-extensions.js";
import { getSubagentProcessInstanceId } from "../subagent/process-instance.js";
import { resolveSubagentServiceForConsumer } from "../subagent/registry.js";
import { isSubagentRuntime } from "../subagent/tool-policy.js";
import { authorizeMcpProxyCall, configuredMcpServerAllowlist } from "../subagent/mcp-capabilities.js";
import { FAST_MODE_POLICY_EVENT, normalizeFastModePolicy } from "../fast-mode/policy.js";
import { resetActiveFastModePolicy, setActiveFastModePolicy } from "../fast-mode/runtime.js";
import { MODEL_TIER_PROFILE_EVENT, normalizeModelTierProfilePolicy } from "../model-tier-list-profiles/policy.js";
import { readBuiltInPrompt } from "./prompt-loader.js";

const WORKFLOW_EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
export const WORKFLOW_CHILD_EXTENSION_PATHS = [WORKFLOW_EXTENSION_PATH, ...STANDALONE_CHILD_EXTENSION_PATHS] as const;
const ORCHESTRATOR_CONTRACT = readBuiltInPrompt("orchestrator-routing");
const RESOURCE_TYPE = StringEnum(["work-item", "task", "stage", "e2e"] as const);
const CHECKS = Type.Array(Type.Unknown(), { description: "Executable deterministic commands, or existing command/profile check objects. The supplied array replaces prior checks." });
const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

interface HarnessRuntime {
	identity: RepositoryIdentity;
	workItems: WorkItemStore;
	config: ReturnType<typeof loadHarnessConfig>["config"];
	launcher: WorkflowSubagentLauncher;
	mutex: CanonicalMutationCoordinator["mutex"];
}

export function structuredCapabilityError(error: unknown, ref?: string): Error {
	const harness = error instanceof HarnessError ? error : undefined;
	return new Error(JSON.stringify({ ok: false, code: harness?.code ?? "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), ...(ref ? { resourceRef: ref } : {}), ...(harness && Object.keys(harness.details).length ? { details: harness.details } : {}), retryable: false }));
}

function rethrowCapabilityError(error: unknown, signal: AbortSignal | undefined, ref?: string): never {
	if (signal?.aborted) throw signal.reason ?? error;
	throw structuredCapabilityError(error, ref);
}

function requireTrusted(ctx: ExtensionContext): void {
	if (isSubagentRuntime(process.env)) throw new HarnessError("CAPABILITY_DENIED", "Managed children cannot invoke orchestrator workflow tools");
	if (!ctx.isProjectTrusted()) throw new HarnessError("CAPABILITY_DENIED", "Workflow mutations require a trusted repository");
}

async function createRuntime(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, modelTierProfile?: string): Promise<HarnessRuntime> {
	const identity = await discoverRepository(ctx.cwd);
	const config = loadHarnessConfig(identity.root, { ...(modelTierProfile ? { modelTierProfile } : {}) }).config;
	const sessionId = ctx.sessionManager.getSessionId();
	const capability = resolveSubagentServiceForConsumer({ sessionId, processInstanceId: getSubagentProcessInstanceId() });
	if (!capability) throw new HarnessError("CAPABILITY_DENIED", "The standalone SubagentService is unavailable for this workflow activation");
	const canonical = new CanonicalMutationCoordinator(identity.root, identity.commonDir ?? join(identity.root, ".git"));
	return { identity, config, workItems: new WorkItemStore(identity.root, canonical), launcher: new WorkflowSubagentLauncher(capability.service, [...WORKFLOW_CHILD_EXTENSION_PATHS]), mutex: canonical.mutex };
}

function formatState(state: Awaited<ReturnType<StoryRuntimeStore["readState"]>>): string {
	if (!state) return "not started";
	const stage = state.stages.find((candidate) => candidate.status !== "completed");
	const tasks = stage?.tasks.map((task) => `${task.id}=${task.status}`).join(" · ");
	return `${state.status}${stage ? ` · stage ${stage.id}/${stage.status}${tasks ? ` · ${tasks}` : ""}` : ""} · ${state.metrics.workflowMs}ms${state.metrics.incompleteCategories.length ? "+" : ""}`;
}

export default function workflow(pi: ExtensionAPI): void {
	resetActiveFastModePolicy();
	pi.events.on(FAST_MODE_POLICY_EVENT, (value: unknown) => { const policy = normalizeFastModePolicy(value); if (policy) setActiveFastModePolicy(policy); });
	let modelTierProfile: string | undefined;
	pi.events.on(MODEL_TIER_PROFILE_EVENT, (value: unknown) => { const policy = normalizeModelTierProfilePolicy(value); if (policy) modelTierProfile = policy.profile; });
	pi.on("tool_call", (event) => { if (event.toolName !== "mcp") return; const allowed = configuredMcpServerAllowlist(); if (allowed) return authorizeMcpProxyCall(event.input as Record<string, unknown>, allowed); });

	if (isSubagentRuntime(process.env)) {
		if (isTargetTaskProcess()) registerWorkerCapabilities(pi);
		pi.on("session_shutdown", () => resetActiveFastModePolicy());
		return;
	}

	let runtime: HarnessRuntime | undefined;
	let runtimePromise: Promise<HarnessRuntime> | undefined;
	const runtimeFor = async (ctx: ExtensionContext): Promise<HarnessRuntime> => {
		const identity = await discoverRepository(ctx.cwd);
		if (runtime?.identity.root === identity.root) {
			if (modelTierProfile && runtime.config.modelTierProfile !== modelTierProfile) runtime.config = loadHarnessConfig(identity.root, { modelTierProfile }).config;
			return runtime;
		}
		if (runtimePromise) return runtimePromise;
		const pending = createRuntime(ctx, modelTierProfile).then((created) => runtime = created);
		runtimePromise = pending;
		try { return await pending; } finally { if (runtimePromise === pending) runtimePromise = undefined; }
	};
	const serviceFor = async (ctx: ExtensionContext) => { const current = await runtimeFor(ctx); return new OrchestratorResourceService(current.identity.root, current.workItems, current.config); };
	const mutate = async <T>(ctx: ExtensionContext, _operationId: string, operation: (current: HarnessRuntime) => Promise<T>) => { requireTrusted(ctx); return operation(await runtimeFor(ctx)); };

	const adapter = createHarnessWorkflowAdapter({ runtimeFor });
	let registration: WorkflowAdapterRegistration | undefined = registerWorkflowAdapter(adapter, { replace: true });

	pi.registerTool({ name: "resource_list", label: "List Workflow Resources", description: "List target stories, E2E cases, authored tasks, and ordered stages. Legacy artifacts and runtime projections are not resources.", parameters: Type.Object({ type: Type.Optional(RESOURCE_TYPE), parent: Type.Optional(Type.String()), query: Type.Optional(Type.String()) }, { additionalProperties: false }), async execute(_id, params, _signal, _update, ctx) {
		try { const parsed = params.parent ? parseResourceRef(params.parent) : undefined; let rows = await (await serviceFor(ctx)).listSummaries(params.type as CanonicalResourceType | undefined, parsed?.workItemId); if (params.query) { const query = params.query.toLowerCase(); rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)); } return result(JSON.stringify(rows, null, 2), rows); } catch (error) { throw structuredCapabilityError(error, params.parent); }
	} });

	pi.registerTool({ name: "resource_read", label: "Read Workflow Resource", description: "Read one complete target story, E2E case, task, or stage resource.", parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }), async execute(_id, params, _signal, _update, ctx) {
		try { const value = await (await serviceFor(ctx)).get(params.ref); return result(JSON.stringify(value.resource, null, 2), value); } catch (error) { throw structuredCapabilityError(error, params.ref); }
	} });

	pi.registerTool({ name: "story_write", label: "Write Story", description: "Create requires id, title, all seven story sections, and e2eScope. Edit requires ref plus changed fields; omit unchanged fields. Malformed stored spec/design requires replacing its complete field group. This does not compile, review, plan, or execute.", parameters: Type.Object({
		ref: Type.Optional(Type.String({ description: "Canonical work-item ref when editing, for example work-item:checkout. Omit when creating." })),
		id: Type.Optional(Type.String({ description: "New story kebab-case id. Required only when creating." })), title: Type.Optional(Type.String({ description: "Concise story title." })), kind: Type.Optional(StringEnum(["story", "change"] as const, { description: "Story kind; defaults to story on creation." })),
		outcome: Type.Optional(Type.String({ description: "Problem, actors, and desired observable result." })), scope: Type.Optional(Type.String({ description: "Included behavior, exclusions, constraints, and assumptions." })), behavior: Type.Optional(Type.String({ description: "Durable product rules, states, inputs, outcomes, and necessary domain language." })), acceptance: Type.Optional(Type.String({ description: "Observable success plus representative edge, failure, and recovery scenarios." })),
		approach: Type.Optional(Type.String({ description: "Chosen high-level technical direction and consequential decisions." })), boundariesAndFlow: Type.Optional(Type.String({ description: "Technical ownership, interfaces, state, and data/control flow." })), failureAndVerification: Type.Optional(Type.String({ description: "Failure and recovery behavior, material compatibility/security/migration risks, and proof seams." })),
		e2eScope: Type.Optional(Type.String({ description: "What the concise outside-in E2E case set establishes. Required when creating." })), e2eExclusions: Type.Optional(Type.String({ description: "Material deliberate E2E exclusions; omit when none or use an empty string to clear on edit." })), workingBranch: Type.Optional(Type.String({ description: "Creation only: explicit matching feature/fix branch when required." })), branchKind: Type.Optional(StringEnum(["feature", "fix"] as const, { description: "Creation only: branch kind, defaulting to feature." })),
	}, { additionalProperties: false }), async execute(id, params, signal, _update, ctx) {
		const ref = params.ref ?? (params.id ? `work-item:${params.id}` : undefined);
		try { return await mutate(ctx, id, async () => { const service = await serviceFor(ctx); const changed = await service.transaction(`harness: write ${ref ?? "story"}`, () => service.writeStory(params), signal); return result(`Wrote ${ref}.`, changed); }); } catch (error) { rethrowCapabilityError(error, signal, ref); }
	} });

	pi.registerTool({ name: "e2e_write", label: "Write E2E Case", description: "Create requires story, id, title, exercise, oracle, and proof. Edit requires ref plus changed fields. Global scope and exclusions belong to story_write.", parameters: Type.Object({
		ref: Type.Optional(Type.String({ description: "Canonical E2E case ref when editing, for example work-item:checkout/e2e:E2E-001." })), story: Type.Optional(Type.String({ description: "Parent work-item ref when creating a case." })), id: Type.Optional(Type.String({ description: "Stable new case id in E2E-NNN format." })), title: Type.Optional(Type.String({ description: "Short journey title." })), exercise: Type.Optional(Type.String({ description: "Actor, starting state, and external actions or events." })), oracle: Type.Optional(Type.String({ description: "User-visible outcomes and final state that determine success." })), proof: Type.Optional(Type.String({ description: "Safe setup, evidence to retain, and cleanup." })),
	}, { additionalProperties: false }), async execute(id, params, signal, _update, ctx) {
		const ref = params.ref ?? (params.story && params.id ? `${params.story}/e2e:${params.id}` : undefined);
		try { return await mutate(ctx, id, async () => { const service = await serviceFor(ctx); const changed = await service.transaction(`harness: write ${ref ?? "E2E case"}`, () => service.writeE2e(params), signal); return result(`Wrote ${ref}.`, changed); }); } catch (error) { rethrowCapabilityError(error, signal, ref ?? params.story); }
	} });

	pi.registerTool({ name: "task_write", label: "Write Workflow Task", description: "Create requires story, id, title, description, scope, and delivery. Edit requires ref plus changed fields. checks and dependsOn replace their complete arrays. Cross-resource completeness is checked by workflow_compile.", parameters: Type.Object({
		ref: Type.Optional(Type.String({ description: "Canonical task ref when editing." })), story: Type.Optional(Type.String({ description: "Parent work-item ref when creating." })), id: Type.Optional(Type.String({ description: "New task kebab-case id." })), title: Type.Optional(Type.String({ description: "Concise task title." })), dependsOn: Type.Optional(Type.Array(Type.String(), { description: "True predecessor task ids; replaces prior dependencies." })), description: Type.Optional(Type.String({ description: "Contribution and necessary technical context for one fresh worker." })), scope: Type.Optional(Type.String({ description: "Included ownership, exclusions, interfaces, dependencies, and integration boundary." })), delivery: Type.Optional(Type.String({ description: "Required implementation, observable result, focused proof, and expected repository state." })), checks: Type.Optional(CHECKS), agent: Type.Optional(Type.String({ description: "Generic configured agent name; defaults to implementer." })), tier: Type.Optional(StringEnum(["low", "medium", "high", "max", "local"] as const, { description: "Capability tier; defaults to medium." })), rationale: Type.Optional(Type.String({ description: "Why this agent/tier fits; local must record explicit current user permission." })), tierJustification: Type.Optional(Type.String({ description: "Substantive justification required for high or max." })),
	}, { additionalProperties: false }), async execute(id, params, signal, _update, ctx) {
		const ref = params.ref ?? (params.story && params.id ? `${params.story}/task:${params.id}` : undefined);
		try { return await mutate(ctx, id, async () => { const service = await serviceFor(ctx); const changed = await service.transaction(`harness: write ${ref ?? "task"}`, () => service.writeTask(params), signal); return result(`Wrote ${ref}.`, changed); }); } catch (error) { rethrowCapabilityError(error, signal, ref ?? params.story); }
	} });

	pi.registerTool({ name: "stage_write", label: "Write Workflow Stage", description: "Create requires story, id, and mode; tasks may be empty only while drafting. Edit requires ref plus changed fields. tasks and checks replace their complete arrays. workflow_compile requires coherent non-empty membership.", parameters: Type.Object({
		ref: Type.Optional(Type.String({ description: "Canonical stage ref when editing." })), story: Type.Optional(Type.String({ description: "Parent work-item ref when creating." })), id: Type.Optional(Type.String({ description: "New stage kebab-case id." })), mode: Type.Optional(StringEnum(["sequential", "concurrent"] as const, { description: "Whether stage tasks share an ordered workspace or fan out from one pinned base." })), tasks: Type.Optional(Type.Array(Type.String(), { description: "Ordered task ids owned by this stage; replaces prior membership." })), checks: Type.Optional(CHECKS), reviewMode: Type.Optional(StringEnum(["required", "skip", "none"] as const, { description: "Risk-based stage review policy; use none to remove an existing optional policy." })), reviewFocus: Type.Optional(Type.String({ description: "Concise material boundary for required review; use an empty string to clear existing focus." })),
	}, { additionalProperties: false }), async execute(id, params, signal, _update, ctx) {
		const ref = params.ref ?? (params.story && params.id ? `${params.story}/stage:${params.id}` : undefined);
		try { return await mutate(ctx, id, async () => { const service = await serviceFor(ctx); const changed = await service.transaction(`harness: write ${ref ?? "stage"}`, () => service.writeStage(params), signal); return result(`Wrote ${ref}.`, changed); }); } catch (error) { rethrowCapabilityError(error, signal, ref ?? params.story); }
	} });

	pi.registerTool({ name: "resource_delete", label: "Delete Workflow Resource", description: "Delete an undelivered task, stage, or E2E case. Draft references may remain incomplete until workflow_compile; stories and historical resources are retained.", parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }), async execute(id, params, signal, _update, ctx) {
		try { return await mutate(ctx, id, async () => { const service = await serviceFor(ctx); const changed = await service.transaction(`harness: delete ${params.ref}`, () => service.delete(params.ref), signal); return result(`Deleted ${params.ref}.`, changed); }); } catch (error) { rethrowCapabilityError(error, signal, params.ref); }
	} });

	pi.registerTool({ name: "workflow_compile", label: "Compile Workflow", description: "Validate the current-branch story, including at least one E2E case, and any authored task/stage plan with complete membership, dependency order, routes, and checks. Reports all deterministic issues; changes nothing and authorizes nothing.", parameters: Type.Object({ ref: Type.Optional(Type.String({ description: "Work-item ref only when the current branch is ambiguous; normally omit." })) }, { additionalProperties: false }), async execute(_id, params, _signal, _update, ctx) {
		try { const current = await runtimeFor(ctx); let storyId: string; if (params.ref) { const parsed = parseResourceRef(params.ref); if (parsed.type !== "work-item") throw new HarnessError("INVALID_ARTIFACT", "workflow_compile ref must identify a work item"); storyId = parsed.id; } else { const items = await current.workItems.listForCurrentBranch(); if (items.length !== 1) throw new HarnessError("INVALID_ARTIFACT", `workflow_compile requires ref because the current branch has ${items.length} target stories`); storyId = items[0]!.id; } const compiled = await (await serviceFor(ctx)).compile(storyId); return result(`Compiled work-item:${storyId} for ${compiled.phase} review. This does not start execution.`, compiled); } catch (error) { throw structuredCapabilityError(error, params.ref); }
	} });

	pi.registerTool({ name: "workflow_status", label: "Workflow Status", description: "Read authoritative target stage state from story-local state.yaml. Active legacy workflows are explicitly refused rather than replay-migrated.", parameters: Type.Object({ ref: Type.Optional(Type.String()) }, { additionalProperties: false }), async execute(_id, params, _signal, _update, ctx) {
		try {
			const current = await runtimeFor(ctx);
			if (params.ref) { const parsed = parseResourceRef(params.ref); await current.workItems.readStory(parsed.workItemId); const snapshot = await adapter.snapshot(`work-item:${parsed.workItemId}`, ctx); return result(formatState(snapshot.runtime), snapshot.runtime); }
			const rows = await Promise.all((await current.workItems.listForCurrentBranch()).map(async (item) => ({ ref: `work-item:${item.id}`, title: item.title, state: await new StoryRuntimeStore(current.identity.root, item.id).readState() })));
			return result(rows.length ? rows.map((row) => `${row.ref} · ${formatState(row.state)}`).join("\n") : `Workflow: no target stories on this branch\nRepository: ${current.identity.root}`, rows);
		} catch (error) { throw structuredCapabilityError(error, params.ref); }
	} });

	pi.registerTool({ name: "workflow_init", label: "Initialize Workflow Harness", description: "Initialize .pi/harness.yaml and required runtime ignores on develop.", parameters: Type.Object({ profile: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("economy")])), overwrite: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), async execute(_id, params, _signal, _update, ctx) {
		try { requireTrusted(ctx); const scaffold = await initializeHarnessRepository(ctx.cwd, params.profile ?? "standard", params.overwrite ?? false); runtime = undefined; return result(scaffold.created ? "Initialized target workflow policy." : "Target workflow policy is already valid.", scaffold); } catch (error) { throw structuredCapabilityError(error); }
	} });

	const command = async (args: string, ctx: ExtensionContext) => {
		const [action, target] = args.trim().split(/\s+/, 2);
		if (action === "init") { requireTrusted(ctx); const scaffold = await initializeHarnessRepository(ctx.cwd, target === "economy" ? "economy" : "standard"); runtime = undefined; ctx.ui.notify(scaffold.created ? "Initialized target workflow policy." : "Workflow policy already valid.", "info"); return; }
		if (action === "status" || !action) { const current = await runtimeFor(ctx); const rows = await Promise.all((await current.workItems.listForCurrentBranch()).map(async (item) => `${item.id} · ${formatState(await new StoryRuntimeStore(current.identity.root, item.id).readState())}`)); ctx.ui.notify(rows.join("\n") || "No target stories on this branch.", "info"); return; }
		ctx.ui.notify("Usage: /workflow [status] | /workflow init [standard|economy]", "warning");
	};
	pi.registerCommand("workflow", { description: "Inspect or initialize target workflows", handler: command });
	pi.registerCommand("harness", { description: "Alias for /workflow", handler: command });
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_CONTRACT}` }));
	pi.on("session_start", async (event, ctx) => {
		if (!registration) registration = registerWorkflowAdapter(adapter, { replace: true });
		if (event.reason !== "reload") await adapter.reconcileActivation?.(ctx);
	});
	pi.on("session_shutdown", async () => { registration?.unregister(); registration = undefined; runtime = undefined; runtimePromise = undefined; resetActiveFastModePolicy(); });
}
