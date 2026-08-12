import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { WorkflowAdapter, WorkflowRunResult, WorkflowSnapshot, WorkflowStep, WorkflowStepStatus } from "../workflows/api.js";
import type { SessionAgentRegistry } from "../workflows/agent-registry.js";
import type { RepositoryIdentity } from "./repository.js";
import { readTextIfExists } from "./repository.js";
import type { WorkItemStore } from "./work-items.js";
import { WorktreeManager } from "./worktrees.js";
import type { RepositoryMutex } from "./idempotency.js";

export interface HarnessWorkflowRuntime {
	identity: RepositoryIdentity;
	workItems: WorkItemStore;
	mutex: RepositoryMutex;
	agents: SessionAgentRegistry;
}

export interface HarnessWorkflowAdapterOptions {
	runtimeFor(ctx: ExtensionContext): Promise<HarnessWorkflowRuntime>;
	launchTask(ctx: ExtensionContext, workItemId: string, taskId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	launchEvaluation(ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
}

const WORK_ITEM = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const STEP = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)\/(task|integration-unit|evaluation):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const terminalAgent = new Set(["completed", "failed", "protocol_failed", "cancelled"]);
const taskDone = new Set(["contribution_complete", "staged", "integrating", "integrated"]);

function taskStatus(status: string, dependenciesDone: boolean): { status: WorkflowStepStatus; detail?: string } {
	if (taskDone.has(status)) return { status: "done" };
	if (status === "running" || status === "reviewing") return { status: "running" };
	if (status === "ready") return dependenciesDone ? { status: "ready" } : { status: "pending" };
	if (status === "cancelled") return { status: "cancelled" };
	if (status === "failed" || status === "protocol_failed") return { status: "attention", detail: "failed" };
	if ((status === "blocked" || status === "paused" || status === "changes_requested") && dependenciesDone) return { status: "attention", detail: status.replaceAll("_", " ") };
	return { status: "pending" };
}

export function createHarnessWorkflowAdapter(options: HarnessWorkflowAdapterOptions): WorkflowAdapter {
	return {
		id: "harness",
		canHandle(ref) { return WORK_ITEM.test(ref) || STEP.test(ref); },
		async snapshot(ref, ctx): Promise<WorkflowSnapshot> {
			const match = WORK_ITEM.exec(ref);
			if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const item = await runtime.workItems.read(match[1]!);
			if (item.planning.status !== "approved") throw new Error(`Workflow plan ${item.id} is not approved. Use /harness approve ${item.id} to approve the workflow plan first.`);
			await runtime.workItems.activateDraftTasks(item.id);
			const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
			const taskById = new Map(tasks.map((task) => [task.id, task]));
			const steps: WorkflowStep[] = tasks.map((task) => {
				const dependenciesDone = task.dependsOn.every((id) => taskById.get(id)?.status === "integrated");
				return { ref: `work-item:${item.id}/task:${task.id}`, title: task.title, kind: "task", ...taskStatus(task.status, dependenciesDone), dependsOn: task.dependsOn.map((id) => `work-item:${item.id}/task:${id}`), parallelism: task.execution.parallelism, resourceClaims: task.execution.resourceClaims };
			});
			for (const unit of item.integrationUnits) {
				const members = unit.tasks.map((id) => taskById.get(id)).filter(Boolean);
				let status: WorkflowStepStatus = "pending"; let detail: string | undefined;
				if (members.length > 0 && members.every((task) => task?.status === "integrated")) status = "done";
				else if (members.length > 0 && members.every((task) => task && ["contribution_complete", "staged"].includes(task.status))) status = "ready";
				else if (members.some((task) => task && (["failed", "protocol_failed", "paused", "changes_requested"].includes(task.status) || (task.status === "blocked" && task.dependsOn.every((id) => taskById.get(id)?.status === "integrated"))))) { status = "attention"; detail = "blocked"; }
				steps.push({ ref: `work-item:${item.id}/integration-unit:${unit.id}`, title: `Integrate ${unit.id}`, kind: "integration", status, ...(detail ? { detail } : {}), dependsOn: unit.tasks.map((id) => `work-item:${item.id}/task:${id}`), parallelism: "serial", resourceClaims: ["canonical-repository"] });
			}
			const evaluations = await Promise.all(item.evaluations.map((entry) => runtime.workItems.readEvaluation(item.id, entry.id)));
			const activeEvaluations = new Set((await runtime.agents.list()).filter((agent) => agent.workItemId === item.id && agent.evaluationId && !terminalAgent.has(agent.state)).map((agent) => agent.evaluationId!));
			for (const evaluation of evaluations) {
				const dependencies = evaluation.scope.task ? [`work-item:${item.id}/task:${evaluation.scope.task}`]
					: evaluation.scope.integrationUnit ? [`work-item:${item.id}/integration-unit:${evaluation.scope.integrationUnit}`]
					: item.integrationUnits.map((unit) => `work-item:${item.id}/integration-unit:${unit.id}`);
				const dependenciesDone = dependencies.every((dependency) => steps.find((step) => step.ref === dependency)?.status === "done");
				let status: WorkflowStepStatus = "pending"; let detail: string | undefined;
				if (["passed", "not_applicable"].includes(evaluation.status)) status = "done";
				else if (evaluation.status === "running" || activeEvaluations.has(evaluation.id)) status = "running";
				else if (["failed", "blocked"].includes(evaluation.status)) { status = "attention"; detail = evaluation.status; }
				else if (dependenciesDone) status = "ready";
				steps.push({ ref: `work-item:${item.id}/evaluation:${evaluation.id}`, title: `Evaluate ${evaluation.id}`, kind: "evaluation", status, ...(detail ? { detail } : {}), dependsOn: dependencies, parallelism: "allowed", resourceClaims: [] });
			}
			const status = steps.some((step) => step.status === "attention" || step.status === "cancelled") ? "attention" : steps.length > 0 && steps.every((step) => step.status === "done") ? "done" : steps.some((step) => step.status === "running") ? "running" : "ready";
			return { ref, title: item.title || item.id, status, steps };
		},
		async runStep(ref, ctx, signal): Promise<WorkflowRunResult> {
			const match = STEP.exec(ref); if (!match) throw new Error(`Invalid harness workflow step: ${ref}`);
			const [, workItemId, kind, id] = match;
			if (kind === "task") {
				const launched = await options.launchTask(ctx, workItemId!, id!, signal);
				const run = launched.details?.run; const state = run?.state === "completed" ? "completed" : run?.state === "cancelled" ? "cancelled" : ["interrupted", "waiting_capacity"].includes(run?.state) ? "blocked" : "failed";
				return { ref, state, summary: launched.content[0]?.text ?? `Task ${id} settled.`, ...(launched.details?.agentId ? { agentId: launched.details.agentId } : {}), attention: state === "blocked" || state === "failed" };
			}
			if (kind === "integration-unit") {
				const runtime = await options.runtimeFor(ctx); const integrated = await new WorktreeManager(runtime.identity).integrateUnit(workItemId!, id!);
				return { ref, state: "completed", summary: `Integrated ${id} as ${integrated.commit.slice(0, 12)}.` };
			}
			const launched = await options.launchEvaluation(ctx, workItemId!, id!, signal);
			const verdict = launched.details?.handoff?.verdict ?? launched.details?.evaluation?.status;
			return { ref, state: verdict === "pass" || verdict === "passed" || verdict === "not_applicable" ? "completed" : "failed", summary: launched.content[0]?.text ?? `Evaluation ${id} settled.`, ...(launched.details?.agentId ? { agentId: launched.details.agentId } : {}), attention: verdict !== "pass" && verdict !== "passed" && verdict !== "not_applicable" };
		},
		async controlWorkflow(ref, action, ctx) {
			const workflow = WORK_ITEM.exec(ref); if (!workflow) throw new Error(`Invalid harness workflow: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const workItemId = workflow[1]!;
			if (action === "resume") {
				const item = await runtime.workItems.read(workItemId);
				if (item.planning.status !== "approved") throw new Error(`Workflow plan ${item.id} is not approved. Use /harness approve ${item.id} to approve the workflow plan first.`);
				const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
				const taskById = new Map(tasks.map((task) => [task.id, task]));
				for (const task of tasks) {
					if (!["cancelled", "paused", "failed", "protocol_failed"].includes(task.status)) continue;
					const dependenciesDone = task.dependsOn.every((id) => taskById.get(id)?.status === "integrated");
					await runtime.mutex.run(`workflow-resume:${item.id}:${task.id}`, () => runtime.workItems.updateTask(item.id, task.id, { status: dependenciesDone ? "ready" : "blocked" }));
				}
				return;
			}
			if (action === "pause") return;
			for (const agent of await runtime.agents.list()) if (agent.workItemId === workItemId && !terminalAgent.has(agent.state)) await this.controlSubagent(agent.id, "stop", ctx);
		},
		async listSubagents(ctx) { return (await options.runtimeFor(ctx)).agents.list(); },
		async listMessages(ctx) { return (await options.runtimeFor(ctx)).agents.listMessages().then((messages) => messages.filter((message) => message.status === "open")); },
		async controlSubagent(agentId, action, ctx) {
			const runtime = await options.runtimeFor(ctx); const agent = await runtime.agents.get(agentId); const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
			if (!attempt) throw new Error(`Agent ${agent.id} has no current process attempt.`);
			const heartbeatText = await readTextIfExists(join(runtime.agents.root, "agents", agent.id, "attempts", attempt.id, "heartbeat.json"));
			const heartbeat = heartbeatText ? JSON.parse(heartbeatText) as { attemptId?: string; pid?: number; at?: string } : undefined;
			const fresh = heartbeat?.attemptId === attempt.id && heartbeat.at && Date.now() - Date.parse(heartbeat.at) < 15_000;
			if (!fresh || !heartbeat?.pid) throw new Error("Refusing to signal a process without a fresh matching heartbeat.");
			try { process.kill(-heartbeat.pid, "SIGTERM"); } catch { process.kill(heartbeat.pid, "SIGTERM"); }
			return runtime.agents.transition(agent.id, action === "pause" ? "paused" : "cancelled", { summary: `${action} requested by orchestrator` });
		},
		async respondSubagent(agentId, messageId, response, ctx) {
			const runtime = await options.runtimeFor(ctx); const message = await runtime.agents.respondMessage(agentId, messageId, response); const agent = await runtime.agents.get(agentId);
			if (agent.workItemId && agent.taskId) { const task = await runtime.workItems.readTask(agent.workItemId, agent.taskId); if (task.status === "blocked") await runtime.mutex.run(`agent-response:${messageId}`, () => runtime.workItems.updateTask(agent.workItemId!, agent.taskId!, { status: "ready" })); }
			return { message, ...(agent.workItemId ? { workflowRef: `work-item:${agent.workItemId}` } : {}) };
		},
	};
}
