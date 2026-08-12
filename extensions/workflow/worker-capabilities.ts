import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { stringify } from "yaml";
import { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import { describeHarnessError, HarnessError } from "./errors.js";
import { discoverRepository, runGit } from "./repository.js";
import { HarnessRunStore, type TaskHandoff } from "./run-store.js";
import { WorkItemStore } from "./work-items.js";

interface WorkerScope {
	runId: string;
	workItemId: string;
	taskId: string;
	credential: string;
}

function scopeFromEnvironment(): WorkerScope {
	const runId = process.env.PIBOX_HARNESS_RUN_ID;
	const workItemId = process.env.PIBOX_HARNESS_WORK_ITEM;
	const taskId = process.env.PIBOX_HARNESS_TASK;
	const credential = process.env.PIBOX_HARNESS_CREDENTIAL;
	if (!runId || !workItemId || !taskId || !credential) throw new HarnessError("CAPABILITY_DENIED", "Worker capability requires a supervised harness run");
	return { runId, workItemId, taskId, credential };
}

async function authorized(ctx: ExtensionContext) {
	const scope = scopeFromEnvironment();
	const identity = await discoverRepository(ctx.cwd);
	const runs = new HarnessRunStore(identity.privateRoot, scope.workItemId);
	const run = await runs.authorize(scope.runId, scope.credential);
	if (run.taskId !== scope.taskId || run.workItemId !== scope.workItemId || run.workspace !== ctx.cwd) {
		throw new HarnessError("CAPABILITY_DENIED", "Run scope does not match this task workspace");
	}
	return { scope, identity, runs, run, workItems: new WorkItemStore(identity.root) };
}

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

export function isWorkerProcess(): boolean {
	return Boolean(process.env.PIBOX_HARNESS_TASK);
}

export function registerWorkerCapabilities(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task_clarify",
		label: "Task Clarification",
		description: "Resolve a specific uncertainty about the assigned task by consulting additional canonical context from the current story or change. Use only when the persistent task context and repository are insufficient—for example, to understand broader product intent, inspect a related requirement or design decision, evaluate an alternative, or support a change request. Do not call at startup, during routine implementation, or to re-read context already provided. Identify the missing question first, then read only the relevant resource. List resources only when you do not know which one can answer it.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list", { description: "List additional resources only when a concrete uncertainty exists and the relevant resource is unknown." }),
				Type.Literal("read", { description: "Read one known resource needed to resolve the concrete uncertainty." }),
			]),
			ref: Type.Optional(Type.String({ description: "Specific canonical resource to read, such as artifact:checkout-design, task:api:acceptance, integration-unit:checkout, or evaluation:checkout-review." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const auth = await authorized(ctx);
				const item = await auth.workItems.read(auth.scope.workItemId);
				if (params.action === "list") {
					const refs = [
						...item.artifacts.map((artifact) => `artifact:${artifact.id} (${artifact.type})`),
						...item.tasks.flatMap((task) => [`task:${task.id}:manifest`, `task:${task.id}:brief`, `task:${task.id}:acceptance`]),
						...item.integrationUnits.map((unit) => `integration-unit:${unit.id}`),
						...item.evaluations.map((evaluation) => `evaluation:${evaluation.id}`),
					];
					return result(["Additional canonical context:", ...refs.map((ref) => `- ${ref}`)].join("\n"));
				}
				if (!params.ref) throw new HarnessError("INVALID_ARTIFACT", "ref is required for task_clarify read");
				const root = auth.workItems.workItemRoot(auth.scope.workItemId);
				let content: string;
				if (params.ref.startsWith("artifact:")) {
					const id = params.ref.slice("artifact:".length);
					content = (await auth.workItems.readArtifact(item.id, id)).content;
				} else if (params.ref.startsWith("task:")) {
					const match = /^task:([a-z0-9]+(?:-[a-z0-9]+)*):(manifest|brief|acceptance)$/.exec(params.ref);
					if (!match || !item.tasks.some((task) => task.id === match[1])) throw new HarnessError("INVALID_ARTIFACT", `Unknown task context: ${params.ref}`);
					content = await readFile(join(root, "tasks", match[1]!, match[2] === "manifest" ? "task.yaml" : `${match[2]}.md`), "utf8");
				} else if (params.ref.startsWith("integration-unit:")) {
					const id = params.ref.slice("integration-unit:".length);
					const unit = item.integrationUnits.find((candidate) => candidate.id === id);
					if (!unit) throw new HarnessError("INVALID_ARTIFACT", `Unknown integration unit: ${id}`);
					content = stringify(unit);
				} else if (params.ref.startsWith("evaluation:")) {
					const id = params.ref.slice("evaluation:".length);
					content = stringify(await auth.workItems.readEvaluation(item.id, id));
				} else throw new HarnessError("INVALID_ARTIFACT", `Unknown task clarification reference: ${params.ref}`);
				return result(content);
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	pi.registerTool({
		name: "task_checkpoint",
		label: "Task Checkpoint",
		description: "Persist a meaningful supervised task checkpoint for recovery or steering.",
		parameters: Type.Object({
			completed: Type.Array(Type.String()),
			nextSteps: Type.Array(Type.String()),
			risks: Type.Optional(Type.Array(Type.String())),
			commits: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const auth = await authorized(ctx);
				await auth.runs.writeCheckpoint(auth.scope.runId, { ...params, at: new Date().toISOString() });
				return result("Checkpoint persisted.");
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});

	for (const name of ["task_request_change", "task_report_decision", "task_blocked"] as const) {
		pi.registerTool({
			name,
			label: name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
			description: name === "task_report_decision" ? "Persist a non-blocking delegated decision for the orchestrator and final handoff." : "Persist a blocking request for the orchestrator, checkpoint safe work, and end this process attempt.",
			parameters: Type.Object({ summary: Type.String(), rationale: Type.String(), evidence: Type.Optional(Type.Array(Type.Object({ source: Type.String(), observation: Type.String() }))), options: Type.Optional(Type.Array(Type.String())), recommendation: Type.Optional(Type.String()) }),
			async execute(toolCallId, params, _signal, _update, ctx) {
				try {
					const auth = await authorized(ctx);
					await auth.runs.appendEvent(auth.scope.runId, name.replaceAll("_", "."), params);
					const privateRoot = process.env.PIBOX_SUBAGENT_STORE_ROOT;
					const sessionId = process.env.PIBOX_WORKFLOW_SESSION_ID;
					const agentId = process.env.PIBOX_SUBAGENT_ID;
					let message: unknown;
					if (privateRoot && sessionId && agentId) {
						const registry = new SessionAgentRegistry(privateRoot, sessionId);
						message = await registry.recordMessage(agentId, {
							operationId: toolCallId,
							type: name === "task_report_decision" ? "decision_report" : name === "task_request_change" ? "change_request" : "blocked",
							blocking: name !== "task_report_decision",
							summary: params.summary,
							rationale: params.rationale,
							evidence: params.evidence ?? [],
							...(params.options ? { options: params.options } : {}),
							...(params.recommendation ? { recommendation: params.recommendation } : {}),
						});
					}
					if (name === "task_blocked") await auth.runs.update(auth.scope.runId, { state: "interrupted", error: params.summary }, "run.blocked");
					return result(name === "task_report_decision" ? "Decision report persisted; continue within delegated scope." : "Blocking message persisted; checkpoint safe work and end this attempt.", message);
				} catch (error) {
					throw new Error(describeHarnessError(error));
				}
			},
		});
	}

	pi.registerTool({
		name: "task_complete",
		label: "Complete Task Contribution",
		description: "Submit the required terminal implementation handoff. Git state and artifact restrictions are validated deterministically.",
		parameters: Type.Object({
			summary: Type.String(),
			commits: Type.Array(Type.String()),
			checks: Type.Array(Type.Object({ command: Type.String(), result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]), output: Type.Optional(Type.String()) })),
			expectedFailures: Type.Optional(Type.Array(Type.String())),
			risks: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const auth = await authorized(ctx);
				const privateRoot = process.env.PIBOX_SUBAGENT_STORE_ROOT;
				const sessionId = process.env.PIBOX_WORKFLOW_SESSION_ID;
				const agentId = process.env.PIBOX_SUBAGENT_ID;
				if (privateRoot && sessionId && agentId) {
					const agent = await new SessionAgentRegistry(privateRoot, sessionId).get(agentId);
					if (agent.state !== "running") throw new HarnessError("INVALID_HANDOFF", `Task cannot complete while its logical agent is ${agent.state}`);
				}
				const item = await auth.workItems.read(auth.scope.workItemId);
				if (item.planning.status !== "approved") throw new HarnessError("CONTEXT_REFRESH_REQUIRED", "Task planning is no longer approved");
				const status = await runGit(ctx.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
				if (status) throw new HarnessError("INVALID_HANDOFF", "Task worktree must be clean before completion", { status });
				const head = await runGit(ctx.cwd, ["rev-parse", "HEAD"]);
				const actualCommits = (await runGit(ctx.cwd, ["rev-list", "--reverse", `${auth.run.baseCommit}..HEAD`])).split("\n").filter(Boolean);
				if (actualCommits.length === 0) throw new HarnessError("INVALID_HANDOFF", "Task contribution has no commits");
				if (!params.commits.includes(head) || params.commits.some((commit) => !actualCommits.includes(commit))) {
					throw new HarnessError("INVALID_HANDOFF", "Reported commits do not match the task branch", { head, actualCommits });
				}
				const artifactChanges = await runGit(ctx.cwd, ["diff", "--name-only", `${auth.run.baseCommit}..HEAD`, "--", "agent-artifacts"]);
				if (artifactChanges) throw new HarnessError("CAPABILITY_DENIED", "Workers cannot modify agent-artifacts", { artifactChanges });
				const handoff: TaskHandoff = {
					schemaVersion: 1,
					type: "task_complete",
					runId: auth.scope.runId,
					taskId: auth.scope.taskId,
					summary: params.summary,
					commits: params.commits,
					checks: params.checks,
					expectedFailures: params.expectedFailures ?? [],
					risks: params.risks ?? [],
					completedAt: new Date().toISOString(),
				};
				await auth.runs.writeHandoff(auth.scope.runId, handoff);
				return result("Terminal task handoff accepted.", handoff);
			} catch (error) {
				throw new Error(describeHarnessError(error));
			}
		},
	});
}
