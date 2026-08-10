import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHarnessConfig } from "./config.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { RepositoryEventStore } from "./event-store.js";
import { discoverRepository, type RepositoryIdentity } from "./repository.js";
import type { EvaluationManifest, HarnessEffort, HarnessStatusSnapshot, TaskManifest, WorkItemKind } from "./types.js";
import { WorkItemStore } from "./work-items.js";

interface HarnessRuntime {
	identity: RepositoryIdentity;
	events: RepositoryEventStore;
	workItems: WorkItemStore;
	configDigest: string;
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
	return { identity, events, workItems: new WorkItemStore(identity.root), configDigest: loaded.digest };
}

function requireTrusted(ctx: ExtensionContext): void {
	if (!ctx.isProjectTrusted()) throw new HarnessError("CAPABILITY_DENIED", "Harness mutations require a trusted repository");
}

async function snapshot(runtime: HarnessRuntime): Promise<HarnessStatusSnapshot> {
	return {
		repositoryRoot: runtime.identity.root,
		repositoryId: runtime.identity.id,
		configDigest: runtime.configDigest,
		workItems: await runtime.workItems.list(),
	};
}

function formatStatus(status: HarnessStatusSnapshot): string {
	if (status.workItems.length === 0) return `Harness: no managed work items\nRepository: ${status.repositoryRoot}`;
	const lines = status.workItems.map(
		(item) => `${item.id} · ${item.kind} · ${item.phase}/${item.state} · planning ${item.planning.status} r${item.planning.revision}`,
	);
	return [`Harness: ${status.workItems.length} managed work item${status.workItems.length === 1 ? "" : "s"}`, ...lines].join("\n");
}

export default function harness(pi: ExtensionAPI): void {
	let sessionRuntime: HarnessRuntime | undefined;

	const runtimeFor = async (ctx: ExtensionContext): Promise<HarnessRuntime> => {
		if (sessionRuntime?.identity.root === ctx.cwd || sessionRuntime?.identity.root === (await discoverRepository(ctx.cwd)).root) {
			return sessionRuntime;
		}
		return createRuntime(ctx);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				const item = await runtime.workItems.create({ ...params, kind: params.kind as WorkItemKind });
				await runtime.events.append("work_item.created", { id: item.id, revision: item.planning.revision });
				return textResult(`Created and committed ${item.kind} ${item.id} at planning revision ${item.planning.revision}.`, item);
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
			async execute(_id, params, _signal, _onUpdate, ctx) {
				try {
					requireTrusted(ctx);
					const runtime = await runtimeFor(ctx);
					const item = await runtime.workItems.putArtifact({ ...params, operation });
					await runtime.events.append(`artifact.${operation}d`, {
						workItemId: item.id,
						artifactId: params.id,
						revision: item.planning.revision,
					});
					return textResult(`${operation === "create" ? "Created" : "Updated"} ${params.type} ${params.id}; planning is ${item.planning.status} at r${item.planning.revision}.`, item);
				} catch (error) {
					return textResult(describeHarnessError(error), { error: true });
				}
			},
		});
	}

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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				requireTrusted(ctx);
				const runtime = await runtimeFor(ctx);
				const item = await runtime.workItems.submitPlanning(params.workItemId);
				await runtime.events.append("planning.submitted", { id: item.id, revision: item.planning.revision });
				return textResult(`Planning for ${item.id} r${item.planning.revision} is awaiting user approval.`, item);
			} catch (error) {
				return textResult(describeHarnessError(error), { error: true });
			}
		},
	});

	pi.registerCommand("harness", {
		description: "Control the PiBox harness: status | approve <work-item-id>",
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
					const item = await runtime.workItems.approve(target);
					await runtime.events.append("planning.approved", {
						id: item.id,
						revision: item.planning.approvedRevision,
					});
					ctx.ui.notify(`Approved ${item.id} planning revision ${item.planning.approvedRevision}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /harness status | /harness approve <work-item-id>", "warning");
			} catch (error) {
				ctx.ui.notify(describeHarnessError(error), "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		try {
			sessionRuntime = await createRuntime(ctx);
			await sessionRuntime.events.append("session.started", {
				reason: event.reason,
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			});
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
