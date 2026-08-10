import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHarnessConfig } from "./config.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { RepositoryEventStore } from "./event-store.js";
import { discoverRepository, type RepositoryIdentity } from "./repository.js";
import type { HarnessStatusSnapshot, WorkItemKind } from "./types.js";
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
