import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { loadHarnessConfig } from "./config.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { RepositoryEventStore } from "./event-store.js";
import { isEvaluatorProcess, registerEvaluatorCapabilities } from "./evaluator-capabilities.js";
import { runDirectAgent } from "./direct-agent.js";
import { HarnessRunStore } from "./run-store.js";
import { resolveHarnessModel } from "./model-resolver.js";
import { IdempotencyStore, RepositoryMutex } from "./idempotency.js";
import { assertCleanRepository, discoverRepository, runGit, type RepositoryIdentity } from "./repository.js";
import type { EvaluationManifest, HarnessEffort, HarnessStatusSnapshot, TaskManifest, WorkItemKind } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { isWorkerProcess, registerWorkerCapabilities } from "./worker-capabilities.js";
import { SubagentSupervisor } from "./supervisor.js";
import { ResourceLockSet, WorktreeManager } from "./worktrees.js";

const WORKER_TOOL_NAMES = new Set([
	"task_context",
	"task_checkpoint",
	"task_request_change",
	"task_report_decision",
	"task_blocked",
	"task_complete",
]);
const EVALUATOR_TOOL_NAMES = new Set(["evaluation_context", "evidence_record", "finding_report", "evaluation_checkpoint", "evaluation_complete"]);
const ORCHESTRATOR_TOOL_NAMES = new Set([
	"harness_status",
	"work_item_create",
	"work_item_status",
	"artifact_create",
	"artifact_update",
	"artifact_link",
	"artifact_reconcile",
	"task_define",
	"task_update",
	"evaluation_define",
	"agent_run",
	"evaluation_launch",
	"task_launch",
	"task_integrate",
	"agent_status",
	"agent_control",
	"evaluation_record",
	"work_item_complete",
	"planning_submit",
]);

interface HarnessRuntime {
	identity: RepositoryIdentity;
	events: RepositoryEventStore;
	workItems: WorkItemStore;
	configDigest: string;
	config: ReturnType<typeof loadHarnessConfig>["config"];
	operations: IdempotencyStore;
	mutex: RepositoryMutex;
}

const textResult = (text: string, details: unknown = null) => ({
	content: [{ type: "text" as const, text }],
	details,
});

async function createRuntime(ctx: Pick<ExtensionContext, "cwd">): Promise<HarnessRuntime> {
	const identity = await discoverRepository(ctx.cwd);
	const loaded = loadHarnessConfig(identity.root);
	const events = new RepositoryEventStore(identity);
	await events.initialize();
	return {
		identity,
		events,
		workItems: new WorkItemStore(identity.root),
		configDigest: loaded.digest,
		config: loaded.config,
		operations: new IdempotencyStore(identity.privateRoot),
		mutex: new RepositoryMutex(identity.privateRoot),
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
	if (!ctx.isProjectTrusted()) throw new HarnessError("CAPABILITY_DENIED", "Harness mutations require a trusted repository");
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
	return { repositoryRoot: runtime.identity.root, repositoryId: runtime.identity.id, configDigest: runtime.configDigest, workItems, taskCounts, runs };
}

function formatStatus(status: HarnessStatusSnapshot): string {
	if (status.workItems.length === 0) return `Harness: no managed work items\nRepository: ${status.repositoryRoot}`;
	const lines = status.workItems.map((item) => {
		const counts = status.taskCounts[item.id] ?? {};
		const tasks = Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(" · ");
		return `${item.id} · ${item.kind} · ${item.phase}/${item.state} · planning ${item.planning.status} r${item.planning.revision}${tasks ? ` · ${tasks}` : ""}`;
	});
	const active = status.runs.filter((run) => run.state === "running" || run.state.startsWith("waiting_"));
	return [`Harness: ${status.workItems.length} managed work item${status.workItems.length === 1 ? "" : "s"}`, ...lines, ...(active.length ? [`Runs: ${active.map((run) => `${run.taskId ?? run.id}=${run.state}`).join(" · ")}`] : [])].join("\n");
}

export default function harness(pi: ExtensionAPI): void {
	let sessionRuntime: HarnessRuntime | undefined;
	const supervisor = new SubagentSupervisor();
	registerWorkerCapabilities(pi);
	registerEvaluatorCapabilities(pi);

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
			if (item.planning.status !== "approved" || item.planning.approvedRevision !== item.planning.revision) {
				throw new HarnessError("STALE_PLANNING_REVISION", "Task launch requires current direct user approval");
			}
			const task = await runtime.workItems.readTask(workItemId, taskId);
			if (task.status !== "ready" && task.status !== "failed" && task.status !== "protocol_failed" && task.status !== "running" && task.status !== "paused") {
				throw new HarnessError("INVALID_HANDOFF", `Task ${task.id} is not launchable from status ${task.status}`);
			}
			const rolePolicy = runtime.config.roles[task.execution.assignment.role];
			if (!rolePolicy) throw new HarnessError("INVALID_ARTIFACT", `Unknown task role: ${task.execution.assignment.role}`);
			const roleCandidates = rolePolicy.models ?? [];
			const plannedCandidate = { model: task.execution.assignment.model, effort: task.execution.assignment.effort };
			const candidates = [plannedCandidate, ...roleCandidates.filter((candidate) => candidate.model !== plannedCandidate.model || candidate.effort !== plannedCandidate.effort)];
			const allAvailable = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
			const resolution = resolveHarnessModel(runtime.config, allAvailable, {
				candidates,
				minimumCapabilityRank: task.execution.assignment.minimumCapabilityRank,
				strict: !task.execution.assignment.allowFallback,
			});
			if (resolution.status === "waiting_model") {
				await runtime.events.append("task.waiting_model", { workItemId: item.id, taskId: task.id, attempts: resolution.attempts });
				return textResult(`MODEL_UNAVAILABLE: No acceptable model is currently available for ${task.id}.`, resolution);
			}
			const manager = new WorktreeManager(runtime.identity);
			locks = new ResourceLockSet(runtime.identity.privateRoot);
			await locks.acquire(task.execution.resourceClaims, `${item.id}/${task.id}`);
			const allocation = await runtime.mutex.run(`allocate:${item.id}:${task.id}`, () => manager.allocate(item.id, task));
			const launched = await supervisor.launchTask({
				identity: runtime.identity,
				workItemId: item.id,
				task,
				workspace: allocation.path,
				branch: allocation.branch,
				baseCommit: allocation.baseCommit,
				planningRevision: item.planning.revision,
				model: { provider: resolution.model.provider, model: resolution.model.id, effort: resolution.effort, requested: `${plannedCandidate.model}:${plannedCandidate.effort}` },
				...(rolePolicy.prompt && resolveConfiguredPath(runtime.identity.root, rolePolicy.prompt)
					? { rolePrompt: readFileSync(resolveConfiguredPath(runtime.identity.root, rolePolicy.prompt) as string, "utf8") }
					: {}),
				...(rolePolicy.tools ? { tools: rolePolicy.tools } : {}),
				...(rolePolicy.skills
					? { skillPaths: rolePolicy.skills.map((skill) => resolveConfiguredPath(runtime.identity.root, skill)).filter((path): path is string => Boolean(path)) }
					: {}),
				canonicalMutation: (owner, operation) => runtime.mutex.run(owner, operation),
				...(signal ? { signal } : {}),
				...(onUpdate ? { onUpdate } : {}),
			});
			await runtime.events.append("task.run_settled", { workItemId: item.id, taskId: task.id, runId: launched.run.id, state: launched.run.state });
			return textResult(
				`Task ${task.id} settled as ${launched.run.state} on ${resolution.model.provider}/${resolution.model.id}:${resolution.effort}${resolution.fallbackUsed ? " (visible fallback)" : ""}.${launched.handoff ? `\n${launched.handoff.summary}` : launched.finalText ? `\n${launched.finalText}` : ""}`,
				launched,
			);
		} catch (error) {
			return textResult(describeHarnessError(error), { error: true });
		} finally {
			await locks?.release();
		}
	};

	pi.registerTool({
		name: "harness_status",
		label: "Harness Status",
		description: "Inspect managed PiBox harness work items and planning state for the current repository.",
		promptSnippet: "Inspect managed work-item, planning, and execution status",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			try {
				const status = await snapshot(await runtimeFor(ctx));
				return textResult(formatStatus(status), status);
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "work_item_create",
		label: "Create Work Item",
		description: "Create and atomically commit a managed change or story with its initial intent. Requires a clean trusted repository.",
		promptSnippet: "Create a committed managed change or story after deciding harness ceremony is warranted",
		parameters: Type.Object({
			id: Type.String({ description: "Stable kebab-case work-item id" }),
			title: Type.String({ description: "Human-readable title" }),
			kind: Type.Union([Type.Literal("change"), Type.Literal("story")]),
			intent: Type.String({ description: "Initial Markdown intent and desired outcome" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = await runtime.workItems.create({ ...params, kind: params.kind as WorkItemKind });
					await runtime.events.append("work_item.created", { id: item.id, revision: item.planning.revision });
					return textResult(`Created and committed ${item.kind} ${item.id} at planning revision ${item.planning.revision}.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "work_item_status",
		label: "Work Item Status",
		description: "Inspect one managed work item with task, integration-unit, and evaluation catalogs.",
		parameters: Type.Object({ workItemId: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const runtime = await runtimeFor(ctx);
				const item = await runtime.workItems.read(params.workItemId);
				const tasks = await Promise.all(item.tasks.map((task) => runtime.workItems.readTask(item.id, task.id)));
				const evaluations = await Promise.all(item.evaluations.map((evaluation) => runtime.workItems.readEvaluation(item.id, evaluation.id)));
				return textResult(`${item.id}: ${item.phase}/${item.state}, planning ${item.planning.status} r${item.planning.revision}\n${tasks.map((task) => `- ${task.id}: ${task.status}`).join("\n")}`, { item, tasks, evaluations });
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	for (const operation of ["create", "update"] as const) {
		pi.registerTool({
			name: `artifact_${operation}`,
			label: `${operation === "create" ? "Create" : "Update"} Harness Artifact`,
			description: `${operation === "create" ? "Create" : "Update"} and atomically commit a canonical spec, design, or decision artifact. Material changes advance the planning revision.`,
			parameters: Type.Object({
				workItemId: Type.String({ description: "Managed work-item id" }),
				id: Type.String({ description: "Stable kebab-case artifact id" }),
				type: Type.Union([Type.Literal("spec"), Type.Literal("design"), Type.Literal("decision")]),
				content: Type.String({ description: "Complete Markdown artifact content" }),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					requireTrusted(ctx);
					const runtime = await runtimeFor(ctx);
					return idempotentMutation(runtime, toolCallId, params, async () => {
						const item = await runtime.workItems.putArtifact({ ...params, operation });
						await runtime.events.append(`artifact.${operation}d`, {
							workItemId: item.id,
							artifactId: params.id,
							revision: item.planning.revision,
						});
						return textResult(`${operation === "create" ? "Created" : "Updated"} ${params.type} ${params.id}; planning is ${item.planning.status} at r${item.planning.revision}.`, item);
					});
				} catch (error) {
					return textResult(describeHarnessError(error), { error: true });
				}
			},
		});
	}

	pi.registerTool({
		name: "artifact_link",
		label: "Link Harness Artifact",
		description: "Add validated artifact-id relationships to the canonical work-item index.",
		parameters: Type.Object({ workItemId: Type.String(), artifactId: Type.String(), links: Type.Array(Type.String()) }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = await runtime.workItems.linkArtifact(params.workItemId, params.artifactId, params.links);
					return textResult(`Linked ${params.artifactId} to ${params.links.join(", ")}.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "artifact_reconcile",
		label: "Reconcile Harness Artifacts",
		description: "Recompute the deliverable-contract digest after clean out-of-band committed edits and mark changed approval stale.",
		parameters: Type.Object({ workItemId: Type.String() }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = await runtime.workItems.reconcile(params.workItemId);
					return textResult(`Reconciled ${item.id}: planning ${item.planning.status} r${item.planning.revision}.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "task_define",
		label: "Define Harness Task",
		description: "Define and atomically commit an executable task contribution, its brief, acceptance contract, assembly unit, and proportionate verification policy.",
		parameters: Type.Object({
			workItemId: Type.String(),
			id: Type.String(),
			title: Type.String(),
			brief: Type.String(),
			acceptance: Type.String(),
			dependsOn: Type.Optional(Type.Array(Type.String())),
			specs: Type.Optional(Type.Array(Type.String())),
			designs: Type.Optional(Type.Array(Type.String())),
			decisions: Type.Optional(Type.Array(Type.String())),
			isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("repository")])),
			parallelism: Type.Optional(Type.Union([Type.Literal("allowed"), Type.Literal("serial")])),
			resourceClaims: Type.Optional(Type.Array(Type.String())),
			complexity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
			role: Type.Optional(Type.String()),
			model: Type.String(),
			effort: Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]),
			minimumCapabilityRank: Type.Optional(Type.Integer({ minimum: 0 })),
			allowFallback: Type.Optional(Type.Boolean()),
			assignmentRationale: Type.String(),
			integrationUnit: Type.String(),
			intermediateState: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
			verificationTiming: Type.Union([Type.Literal("task"), Type.Literal("integration-unit"), Type.Literal("work-item"), Type.Literal("skipped")]),
			verificationMethods: Type.Optional(Type.Array(Type.String())),
			taskChecks: Type.Optional(Type.Array(Type.String())),
			verificationRationale: Type.String(),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
				const manifest: TaskManifest = {
					schemaVersion: 1,
					id: params.id,
					title: params.title,
					status: (params.dependsOn?.length ?? 0) > 0 ? "blocked" : "ready",
					dependsOn: params.dependsOn ?? [],
					references: { specs: params.specs ?? [], designs: params.designs ?? [], decisions: params.decisions ?? [] },
					execution: {
						isolation: params.isolation ?? "worktree",
						parallelism: params.parallelism ?? "allowed",
						resourceClaims: params.resourceClaims ?? [],
						complexity: params.complexity,
						assignment: {
							role: params.role ?? "implementer",
							model: params.model,
							effort: params.effort as HarnessEffort,
							minimumCapabilityRank: params.minimumCapabilityRank ?? 0,
							allowFallback: params.allowFallback ?? true,
							rationale: params.assignmentRationale,
						},
					},
					assembly: { integrationUnit: params.integrationUnit, intermediateState: params.intermediateState },
					verification: {
						timing: params.verificationTiming,
						methods: params.verificationMethods ?? [],
						taskChecks: params.taskChecks ?? [],
						rationale: params.verificationRationale,
					},
				};
				const item = await runtime.workItems.defineTask({ workItemId: params.workItemId, manifest, brief: params.brief, acceptance: params.acceptance });
				await runtime.events.append("task.defined", { workItemId: item.id, taskId: manifest.id, revision: item.planning.revision });
				return textResult(`Defined task ${manifest.id} in integration unit ${manifest.assembly.integrationUnit}; planning r${item.planning.revision}.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update Harness Task",
		description: "Apply an orchestrator-owned non-delivery task lifecycle transition. Completion and integration states require their dedicated capabilities.",
		parameters: Type.Object({
			workItemId: Type.String(),
			taskId: Type.String(),
			status: Type.Union([Type.Literal("blocked"), Type.Literal("ready"), Type.Literal("reviewing"), Type.Literal("changes_requested"), Type.Literal("paused"), Type.Literal("cancelled")]),
		}),
		async execute(toolCallId, params, _signal, _update, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const task = await runtime.workItems.updateTask(params.workItemId, params.taskId, { status: params.status });
					return textResult(`Task ${task.id} is now ${task.status}.`, task);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "evaluation_define",
		label: "Define Harness Evaluation",
		description: "Define and atomically commit a proportionate evaluation at a task, integration-unit, or work-item boundary.",
		parameters: Type.Object({
			workItemId: Type.String(),
			id: Type.String(),
			type: Type.Union([Type.Literal("deterministic"), Type.Literal("spec-review"), Type.Literal("quality-review"), Type.Literal("combined-review"), Type.Literal("regression"), Type.Literal("e2e")]),
			scopeType: Type.Union([Type.Literal("task"), Type.Literal("integrationUnit"), Type.Literal("workItem")]),
			scopeId: Type.String(),
			required: Type.Boolean(),
			methods: Type.Array(Type.String()),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
				const manifest: EvaluationManifest = {
					schemaVersion: 1,
					id: params.id,
					type: params.type,
					scope: { [params.scopeType]: params.scopeId },
					status: "planned",
					required: params.required,
					attempt: 0,
					methods: params.methods,
				};
				const item = await runtime.workItems.defineEvaluation(params.workItemId, manifest);
				await runtime.events.append("evaluation.defined", { workItemId: item.id, evaluationId: manifest.id });
				return textResult(`Defined ${manifest.type} evaluation ${manifest.id}.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "agent_run",
		label: "Run Harness Specialist",
		description: "Directly invoke a configurable specialist role without requiring a managed work item.",
		parameters: Type.Object({
			role: Type.String(),
			task: Type.String(),
			model: Type.Optional(Type.String()),
			effort: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")])),
			strict: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				const role = runtime.config.roles[params.role];
				if (!role) throw new HarnessError("INVALID_ARTIFACT", `Unknown harness role: ${params.role}`);
				const roleCandidates = role.models ?? [];
				const requested = params.model ? [{ model: params.model, effort: (params.effort ?? "high") as HarnessEffort }] : roleCandidates;
				const candidates = [...requested, ...roleCandidates.filter((candidate) => !requested.some((item) => item.model === candidate.model && item.effort === candidate.effort))];
				const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
				const resolution = resolveHarnessModel(runtime.config, available, { candidates, strict: params.strict ?? false });
				if (resolution.status === "waiting_model") return textResult("MODEL_UNAVAILABLE: No configured candidate is available.", resolution);
				await assertCleanRepository(runtime.identity.root);
				const defaultTools: Record<string, string[]> = {
					researcher: ["web_search", "source_check", "fetch_content", "get_search_content"],
					explorer: ["read", "grep", "find", "bash"],
					"plan-critic": ["read", "grep", "find"],
					"spec-reviewer": ["read", "grep", "find", "bash"],
					"quality-reviewer": ["read", "grep", "find", "bash"],
					"e2e-tester": ["read", "grep", "find", "bash"],
				};
				const direct = await runDirectAgent({
					role: params.role,
					task: params.task,
					cwd: runtime.identity.root,
					provider: resolution.model.provider,
					model: resolution.model.id,
					effort: resolution.effort,
					tools: role.tools ?? defaultTools[params.role] ?? ["read", "grep", "find"],
					...(role.prompt && resolveConfiguredPath(runtime.identity.root, role.prompt) ? { promptPath: resolveConfiguredPath(runtime.identity.root, role.prompt) as string } : {}),
					...(signal ? { signal } : {}),
					...(onUpdate ? { onText: (text: string) => onUpdate(textResult(text, { role: params.role, state: "running" })) } : {}),
				});
				await assertCleanRepository(runtime.identity.root);
				await runtime.events.append("agent.direct_completed", { role: params.role, exitCode: direct.exitCode, model: `${direct.provider}/${direct.model}`, effort: direct.effort });
				return textResult(direct.text || direct.stderr || `Specialist exited ${direct.exitCode}.`, direct);
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "evaluation_launch",
		label: "Launch Harness Evaluation",
		description: "Run a planned evaluation in a fresh specialist session and atomically record its structured verdict and evidence.",
		parameters: Type.Object({
			workItemId: Type.String(),
			evaluationId: Type.String(),
			model: Type.Optional(Type.String()),
			effort: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")])),
			strict: Type.Optional(Type.Boolean()),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return runtime.operations.execute(toolCallId, params, async () => {
					const item = await runtime.workItems.read(params.workItemId);
					if (item.planning.status !== "approved" || item.planning.approvedRevision !== item.planning.revision) throw new HarnessError("STALE_PLANNING_REVISION", "Evaluation requires current approved planning");
					const evaluation = await runtime.workItems.readEvaluation(item.id, params.evaluationId);
					if (evaluation.attempt >= runtime.config.limits.repairRounds + 1) throw new HarnessError("INVALID_HANDOFF", `Evaluation repair budget exhausted for ${evaluation.id}`);
					const roleName = evaluation.type === "spec-review" ? "spec-reviewer" : evaluation.type === "quality-review" ? "quality-reviewer" : evaluation.type === "e2e" ? "e2e-tester" : "quality-reviewer";
					const role = runtime.config.roles[roleName];
					if (!role) throw new HarnessError("CONFIG_INVALID", `Missing evaluator role: ${roleName}`);
					const roleCandidates = role.models ?? [];
					const requested = params.model ? [{ model: params.model, effort: (params.effort ?? "high") as HarnessEffort }] : roleCandidates;
					const candidates = [...requested, ...roleCandidates.filter((candidate) => !requested.some((itemCandidate) => itemCandidate.model === candidate.model && itemCandidate.effort === candidate.effort))];
					const available = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
					const resolution = resolveHarnessModel(runtime.config, available, { candidates, strict: params.strict ?? false });
					if (resolution.status === "waiting_model") return textResult("MODEL_UNAVAILABLE: No evaluator candidate is available.", resolution);
					await assertCleanRepository(runtime.identity.root);
					const runs = new HarnessRunStore(runtime.identity.privateRoot, item.id);
					const requestedModel = params.model ?? roleCandidates[0]?.model;
					const created = await runs.create({
						repositoryId: runtime.identity.id,
						workItemId: item.id,
						evaluationId: evaluation.id,
						role: roleName,
						attempt: evaluation.attempt + 1,
						state: "running",
						workspace: runtime.identity.root,
						baseCommit: await runGit(runtime.identity.root, ["rev-parse", "HEAD"]),
						planningRevision: item.planning.revision,
						...(requestedModel ? { requestedModel } : {}),
						resolvedProvider: resolution.model.provider,
						resolvedModel: resolution.model.id,
						resolvedEffort: resolution.effort,
					});
					const prompt = [
						`Evaluate planned boundary ${evaluation.id} (${evaluation.type}) for work item ${item.id}.`,
						"Call evaluation_context before judging. Use fresh evidence and do not modify product or canonical artifact files.",
						"If runtime evidence files are needed, place them outside the repository and reference their absolute paths.",
						"Finish by calling evaluation_complete. A prose-only response is invalid.",
					].join("\n");
					const runEvaluator = (taskPrompt: string) => runDirectAgent({
						role: roleName,
						task: taskPrompt,
						cwd: runtime.identity.root,
						provider: resolution.model.provider,
						model: resolution.model.id,
						effort: resolution.effort,
						tools: [...new Set([
							...(role.tools ?? ["read", "grep", "find", ...(evaluation.type === "e2e" || evaluation.type === "deterministic" || evaluation.type === "regression" ? ["bash"] : [])]),
							"evaluation_context", "evidence_record", "finding_report", "evaluation_checkpoint", "evaluation_complete",
						])],
						env: {
							PIBOX_HARNESS_RUN_ID: created.record.id,
							PIBOX_HARNESS_WORK_ITEM: item.id,
							PIBOX_HARNESS_EVALUATION: evaluation.id,
							PIBOX_HARNESS_CREDENTIAL: created.credential,
						},
						...(role.prompt && resolveConfiguredPath(runtime.identity.root, role.prompt) ? { promptPath: resolveConfiguredPath(runtime.identity.root, role.prompt) as string } : {}),
						onSpawn: (pid) => void runs.update(created.record.id, { ...(pid === undefined ? {} : { pid }) }, "run.process_started"),
						...(signal ? { signal } : {}),
						...(onUpdate ? { onText: (text: string) => onUpdate(textResult(text, { runId: created.record.id, state: "running" })) } : {}),
					});
					let direct = await runEvaluator(prompt);
					await assertCleanRepository(runtime.identity.root);
					let handoff = await runs.readEvaluationHandoff(created.record.id);
					if (!handoff && direct.exitCode === 0) {
						await runs.appendEvent(created.record.id, "run.protocol_nudge", { evaluationId: evaluation.id });
						direct = await runEvaluator(`PROTOCOL NUDGE: The previous evaluator settled without evaluation_complete. Reinspect the assigned boundary as needed and call evaluation_complete now.\n\n${prompt}`);
						await assertCleanRepository(runtime.identity.root);
						handoff = await runs.readEvaluationHandoff(created.record.id);
					}
					if (!handoff || handoff.runId !== created.record.id || handoff.evaluationId !== evaluation.id) {
						await runs.update(created.record.id, { state: "protocol_failed", exitCode: direct.exitCode, error: "Missing or invalid evaluation_complete handoff" }, "run.protocol_failed");
						return textResult(`PROTOCOL_FAILED: Evaluator ${evaluation.id} omitted its structured handoff.`, { runId: created.record.id, direct });
					}
					const recorded = await runtime.mutex.run(`evaluation:${evaluation.id}:${created.record.id}`, () =>
						runtime.workItems.recordEvaluation({ workItemId: item.id, evaluationId: evaluation.id, verdict: handoff.verdict, report: handoff.report, evidence: handoff.evidence, findings: handoff.findings }),
					);
					await runs.update(created.record.id, { state: "completed", exitCode: direct.exitCode }, "run.completed");
					await runtime.events.append("evaluation.run_completed", { workItemId: item.id, evaluationId: evaluation.id, runId: created.record.id, verdict: handoff.verdict });
					return textResult(`Evaluation ${evaluation.id} recorded ${handoff.verdict} on attempt ${recorded.attempt}.`, { runId: created.record.id, evaluation: recorded, handoff });
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "task_launch",
		label: "Launch Harness Task",
		description: "Resolve the planned model, allocate an isolated worktree, and supervise an approved implementation task through its structured handoff.",
		parameters: Type.Object({ workItemId: Type.String(), taskId: Type.String() }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const runtime = await runtimeFor(ctx);
				return runtime.operations.execute(toolCallId, params, () => launchManagedTask(ctx, params.workItemId, params.taskId, signal, onUpdate));
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "task_integrate",
		label: "Integrate Harness Unit",
		description: "Assemble all contribution-complete tasks in an integration unit, run its declared checks, and atomically fast-forward the canonical branch.",
		parameters: Type.Object({ workItemId: Type.String(), integrationUnit: Type.String(), checks: Type.Optional(Type.Array(Type.String())) }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const manager = new WorktreeManager(runtime.identity);
					const integrated = await manager.integrateUnit(params.workItemId, params.integrationUnit, params.checks ?? []);
					await runtime.events.append("integration.completed", integrated);
					return textResult(`Integrated ${params.integrationUnit} as ${integrated.commit.slice(0, 12)} with ${integrated.tasks.length} task contribution(s).`, integrated);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "agent_status",
		label: "Harness Agent Status",
		description: "List active supervised harness run ids in this Pi process.",
		parameters: Type.Object({}),
		async execute() {
			const active = supervisor.activeRunIds();
			return textResult(active.length ? `Active runs:\n${active.map((id) => `- ${id}`).join("\n")}` : "No active supervised runs.", { active });
		},
	});

	pi.registerTool({
		name: "agent_control",
		label: "Control Harness Agent",
		description: "Pause or stop an active supervised harness run. Resume uses the retained task identity through /harness resume <task>.",
		parameters: Type.Object({ runId: Type.String(), action: Type.Union([Type.Literal("pause"), Type.Literal("stop")]) }),
		async execute(_id, params) {
			const stopped = params.action === "pause" ? supervisor.pause(params.runId) : supervisor.stop(params.runId);
			return textResult(stopped ? `${params.action === "pause" ? "Pause" : "Stop"} requested for ${params.runId}.` : `Run is not active in this process: ${params.runId}`, { stopped });
		},
	});

	pi.registerTool({
		name: "evaluation_record",
		label: "Record Harness Evaluation",
		description: "Atomically record a completed planned evaluation, curated report, and checksummed evidence manifest.",
		parameters: Type.Object({
			workItemId: Type.String(),
			evaluationId: Type.String(),
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked"), Type.Literal("not_applicable")]),
			report: Type.String(),
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
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "work_item_complete",
		label: "Complete Harness Work Item",
		description: "Apply the deterministic completion gate and atomically commit the final outcome.",
		parameters: Type.Object({ workItemId: Type.String(), outcome: Type.String() }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = await runtime.workItems.completeWorkItem(params.workItemId, params.outcome);
					await runtime.events.append("work_item.completed", { workItemId: item.id });
					return textResult(`Completed ${item.id}.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerTool({
		name: "planning_submit",
		label: "Submit Harness Planning",
		description: "Freeze the current deliverable-contract digest and mark a managed work item as awaiting direct user approval.",
		parameters: Type.Object({ workItemId: Type.String({ description: "Managed work-item id" }) }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				return idempotentMutation(runtime, toolCallId, params, async () => {
					const item = await runtime.workItems.submitPlanning(params.workItemId);
					await runtime.events.append("planning.submitted", { id: item.id, revision: item.planning.revision });
					return textResult(`Planning for ${item.id} r${item.planning.revision} is awaiting user approval.`, item);
				});
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerCommand("harness", {
		description: "Control the PiBox harness: status | approve | pause | resume | stop | recover",
		handler: async (args, ctx) => {
			const [command = "status", target, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			try {
				const runtime = await runtimeFor(ctx);
				if (command === "status" && !target) {
					ctx.ui.notify(formatStatus(await snapshot(runtime)), "info");
					return;
				}
				if (command === "approve" && target && extra.length === 0) {
					requireTrusted(ctx);
					const item = await runtime.mutex.run(`approve:${target}`, () => runtime.workItems.approve(target));
					await runtime.events.append("planning.approved", { id: item.id, revision: item.planning.approvedRevision });
					ctx.ui.notify(`Approved ${item.id} planning revision ${item.planning.approvedRevision}.`, "info");
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
				ctx.ui.notify("Usage: /harness status | approve <work-item> | pause <task> | resume <task> | stop <task> | recover", "warning");
			} catch (error) {
				ctx.ui.notify(describeHarnessError(error), "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const disallowed = new Set<string>();
		if (isWorkerProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES].forEach((name) => disallowed.add(name));
		else if (isEvaluatorProcess()) [...ORCHESTRATOR_TOOL_NAMES, ...WORKER_TOOL_NAMES].forEach((name) => disallowed.add(name));
		else [...WORKER_TOOL_NAMES, ...EVALUATOR_TOOL_NAMES].forEach((name) => disallowed.add(name));
		pi.setActiveTools(pi.getActiveTools().filter((name) => !disallowed.has(name)));
		try {
			sessionRuntime = await createRuntime(ctx);
			const staleLockRecovered = await sessionRuntime.mutex.recoverStale();
			await sessionRuntime.events.append("session.started", {
				reason: event.reason,
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				staleLockRecovered,
			});
			if (!isWorkerProcess() && !isEvaluatorProcess()) {
				const recovered = [];
				for (const item of await sessionRuntime.workItems.list()) {
					recovered.push(...(await new HarnessRunStore(sessionRuntime.identity.privateRoot, item.id).recoverInterrupted()));
				}
				if (recovered.length > 0) ctx.ui.notify(`Harness recovered ${recovered.length} interrupted run(s). Use /harness recover or /harness resume <task>.`, "warning");
			}
		} catch (error) {
			sessionRuntime = undefined;
			if (error instanceof HarnessError && error.code === "NOT_A_GIT_REPOSITORY") return;
			ctx.ui.notify(`Harness initialization failed: ${describeHarnessError(error)}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!sessionRuntime) return;
		await sessionRuntime.events.append("orchestrator.settled", { idle: ctx.isIdle() });
	});

	pi.on("session_shutdown", async (event) => {
		if (!sessionRuntime) return;
		await sessionRuntime.events.append("session.shutdown", { reason: event.reason });
		await sessionRuntime.events.flush();
		sessionRuntime = undefined;
	});
}
