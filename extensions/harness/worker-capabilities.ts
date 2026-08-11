import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { SessionAgentRegistry } from "./agent-registry.js";
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
		name: "task_context",
		label: "Task Context",
		description: "Read current canonical task artifacts from the orchestrator branch, with revision and digest metadata.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("refresh")]),
			artifactId: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const auth = await authorized(ctx);
				const item = await auth.workItems.read(auth.scope.workItemId);
				const task = await auth.workItems.readTask(auth.scope.workItemId, auth.scope.taskId);
				if (params.action === "list" || params.action === "refresh") {
					await auth.runs.appendEvent(auth.scope.runId, "context.refreshed", { revision: item.planning.revision, digest: item.planning.contractDigest });
					return result(
						[`Planning revision: ${item.planning.revision}`, `Contract digest: ${item.planning.contractDigest}`, "Artifacts:", ...item.artifacts.map((artifact) => `- ${artifact.id} (${artifact.type})`), `- task:${task.id} (task contract)`].join("\n"),
						{ revision: item.planning.revision, digest: item.planning.contractDigest, artifacts: item.artifacts, task, taskContextIds: [`task:${task.id}:manifest`, `task:${task.id}:brief`, `task:${task.id}:acceptance`] },
					);
				}
				if (!params.artifactId) throw new HarnessError("INVALID_ARTIFACT", "artifactId is required for read");
				const root = auth.workItems.workItemRoot(auth.scope.workItemId);
				let path: string;
				if (params.artifactId === `task:${task.id}` || params.artifactId === `task:${task.id}:brief`) path = join(root, "tasks", task.id, "brief.md");
				else if (params.artifactId === `task:${task.id}:acceptance`) path = join(root, "tasks", task.id, "acceptance.md");
				else if (params.artifactId === `task:${task.id}:manifest`) path = join(root, "tasks", task.id, "task.yaml");
				else {
					const artifact = item.artifacts.find((candidate) => candidate.id === params.artifactId);
					if (!artifact) throw new HarnessError("INVALID_ARTIFACT", `Unknown artifact: ${params.artifactId}`);
					path = join(root, artifact.path);
				}
				const content = await readFile(path, "utf8");
				const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
				return result(content, { revision: item.planning.revision, contractDigest: item.planning.contractDigest, contentDigest: digest });
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
			async execute(_id, params, _signal, _update, ctx) {
				try {
					const auth = await authorized(ctx);
					await auth.runs.appendEvent(auth.scope.runId, name.replaceAll("_", "."), params);
					const privateRoot = process.env.PIBOX_HARNESS_REPOSITORY_PRIVATE_ROOT;
					const sessionId = process.env.PIBOX_HARNESS_ROOT_SESSION_ID;
					const agentId = process.env.PIBOX_HARNESS_AGENT_ID;
					let message: unknown;
					if (privateRoot && sessionId && agentId) {
						const registry = new SessionAgentRegistry(privateRoot, sessionId);
						message = await registry.recordMessage(agentId, {
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
				const item = await auth.workItems.read(auth.scope.workItemId);
				if (item.planning.status !== "approved" || item.planning.revision !== auth.run.planningRevision) {
					throw new HarnessError("CONTEXT_REFRESH_REQUIRED", `Task run is bound to planning r${auth.run.planningRevision}; canonical planning is ${item.planning.status} r${item.planning.revision}`);
				}
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
