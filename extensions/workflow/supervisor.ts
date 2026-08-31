import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LaunchCoordinator } from "../workflow-runtime/launch-coordinator.js";
import { classifyFailure } from "./failure-classifier.js";
import { HarnessError } from "./errors.js";
import type { RepositoryIdentity } from "./repository.js";
import { HarnessRunStore, runWorkflowControlFence, type RunRecord, type TaskHandoff } from "./run-store.js";
import { taskAgentName, type ModelTier, type TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { BUILT_IN_AGENT_ROOT, readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import { DEFAULT_SUBAGENT_TOOLS, PIBOX_LEDGER_TOOL_GROUP, PIBOX_TASK_TOOL_GROUP, resolveToolSelectors } from "./tool-groups.js";
import { mcpLaunchEnvironment } from "../subagent/mcp-capabilities.js";
import { finalizeTaskAgentAfterSettlement, settleManagedTaskHandoff } from "./task-settlement.js";
import { buildTaskAttemptContext } from "./implementation-context.js";
import { normalizeChecks } from "./verification-checks.js";
import { VerificationRunner, verificationFailureSummary } from "./verification-runner.js";

export interface LaunchModel {
	provider: string;
	model: string;
	effort: string;
	providerCandidates?: Array<{ provider: string; model: string; effort: string }>;
	requested: string;
	capabilityTier?: ModelTier;
}

export interface LaunchTaskOptions {
	identity: RepositoryIdentity;
	workItemId: string;
	task: TaskManifest;
	workspace: string;
	branch: string;
	baseCommit: string;
	executionMode: "repository" | "worktree";
	planningRevision: number;
	workflowGeneration?: number;
	workflowExecutionFence?: number;
	workflowOwnerProcessInstanceId?: string;
	workflowOwnerActivationId?: string;
	model: LaunchModel;
	agentPrompt?: string;
	persistentContext: string;
	tools?: string[];
	skillPaths?: string[];
	canonicalMutation?: <T>(owner: string, operation: () => Promise<T>) => Promise<T>;
	/** Exact runner ownership check used until a service child has spawned. */
	assertPrelaunchCurrent?: () => void | Promise<void>;
	signal?: AbortSignal;
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
	coordinator: LaunchCoordinator;
}

export interface LaunchTaskResult {
	run: RunRecord;
	handoff?: TaskHandoff;
	stderr: string;
	finalText: string;
}

function taskPrompt(options: LaunchTaskOptions, protocolNudge: boolean): string {
	const checks = options.task.verification.taskChecks.length ? options.task.verification.taskChecks.map((check) => `- ${check}`).join("\n") : "- None assigned at this boundary.";
	const prompt = renderBuiltInPrompt("managed-task", { taskId: options.task.id, taskTitle: options.task.title, checks });
	return `${prompt}${protocolNudge ? `\n\n${readBuiltInPrompt("task-protocol-nudge")}` : ""}`;
}

interface ManagedRunControl {
	workItemId: string;
	controller: AbortController;
	coordinator: LaunchCoordinator;
	agentId?: string;
	attemptId?: string;
	attemptGeneration?: number;
	runs: HarnessRunStore;
	settled: Promise<void>;
	confirmSettled: () => void;
}

export class SubagentSupervisor {
	#settling = new Set<string>();
	#termination = new Map<string, "cancelled">();
	#managed = new Map<string, ManagedRunControl>();

	async launchTask(options: LaunchTaskOptions): Promise<LaunchTaskResult> {
		await options.assertPrelaunchCurrent?.();
		const runs = new HarnessRunStore(options.identity, options.workItemId);
		const workItems = new WorkItemStore(options.identity.root);
		const updateTask = <T>(owner: string, operation: () => Promise<T>) =>
			options.canonicalMutation ? options.canonicalMutation(owner, operation) : operation();
		const created = await runs.create({
			repositoryId: options.identity.id,
			workItemId: options.workItemId,
			taskId: options.task.id,
			role: taskAgentName(options.task),
			attempt: 1,
			state: "launching",
			workspace: options.workspace,
			baseCommit: options.baseCommit,
			planningRevision: options.planningRevision,
			...(options.workflowGeneration !== undefined ? { workflowGeneration: options.workflowGeneration } : {}),
			...(options.workflowExecutionFence !== undefined ? { workflowExecutionFence: options.workflowExecutionFence } : {}),
			...(options.workflowOwnerProcessInstanceId ? { workflowOwnerProcessInstanceId: options.workflowOwnerProcessInstanceId } : {}),
			...(options.workflowOwnerActivationId ? { workflowOwnerActivationId: options.workflowOwnerActivationId } : {}),
			requestedModel: options.model.requested,
			resolvedProvider: options.model.provider,
			resolvedModel: options.model.model,
			resolvedEffort: options.model.effort,
		});
		const expectedWorkflowFence = runWorkflowControlFence(created.record);
		this.#settling.add(created.record.id);
		const managedController = new AbortController();
		let confirmSettled!: () => void;
		const settled = new Promise<void>((resolve) => { confirmSettled = resolve; });
		const managed: ManagedRunControl = { workItemId: options.workItemId, controller: managedController, coordinator: options.coordinator, runs, settled, confirmSettled };
		this.#managed.set(created.record.id, managed);
		const stopFromUpstream = () => { void this.stop(created.record.id).catch(() => undefined); };
		if (options.signal?.aborted) stopFromUpstream();
		else options.signal?.addEventListener("abort", stopFromUpstream, { once: true });
		const launchSignal = options.signal ? AbortSignal.any([options.signal, managedController.signal]) : managedController.signal;
		try {
		await options.assertPrelaunchCurrent?.();
		await updateTask(`run-start:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, {
			status: "running",
			runtime: { executionMode: options.executionMode, branch: options.branch, worktree: options.workspace, baseCommit: options.baseCommit, lastRunId: created.record.id },
		}));
		let contributionBase = options.baseCommit;
		if (options.executionMode === "repository") {
			const { runGit } = await import("./repository.js");
			contributionBase = await runGit(options.workspace, ["rev-parse", "HEAD"]);
			await runs.update(created.record.id, { baseCommit: contributionBase }, "run.repository_base_prepared");
		}

		let stderr = "";
		let finalText = "";
		let logicalAgentId = (await options.coordinator.registry.list()).find((agent) => agent.workItemId === options.workItemId && agent.taskId === options.task.id && !["completed", "failed", "protocol_failed", "cancelled"].includes(agent.state))?.id;
		const settleCancellation = async (exitCode: number): Promise<LaunchTaskResult> => {
			const run = await runs.update(created.record.id, { state: "cancelled", exitCode, error: "Run cancelled by orchestrator" }, "run.cancelled");
			await updateTask(`run-terminated:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "cancelled" }));
			if (logicalAgentId) await options.coordinator.registry.transition(logicalAgentId, "cancelled", { error: "Run cancelled by orchestrator" }).catch(() => undefined);
			return { run, stderr, finalText };
		};
		const answeredMessages = logicalAgentId ? (await options.coordinator.registry.listMessages(logicalAgentId)).filter((message) => message.status === "answered") : [];
		const responseContext = answeredMessages.length ? `\n\n${renderBuiltInPrompt("orchestrator-responses", { responses: answeredMessages.map((message) => `- ${message.summary}: ${message.response}`).join("\n") })}` : "";
		for (let protocolAttempt = 0; protocolAttempt < 2; protocolAttempt++) {
			await options.assertPrelaunchCurrent?.();
			let execution: { exitCode: number; stderr: string; finalText: string; terminalReason: "completed" | "failure" | "explicit_stop" | "owner_lost" } = {
				exitCode: 1, stderr: "Managed launch did not settle", finalText: "", terminalReason: "failure",
			};
			let coordinated: Awaited<ReturnType<LaunchCoordinator["launch"]>> | undefined;
			try {
				coordinated = await options.coordinator.launch({
					operationId: created.record.id,
					...(logicalAgentId ? { existingAgentId: logicalAgentId } : {}),
					role: taskAgentName(options.task),
					task: [taskPrompt(options, protocolAttempt === 1), buildTaskAttemptContext(options.task), responseContext.trim()].filter(Boolean).join("\n\n"),
					assignment: { schemaVersion: 1, workItemId: options.workItemId, taskId: options.task.id, planningRevision: options.planningRevision },
					cwd: options.workspace,
					provider: options.model.provider,
					model: options.model.model,
					effort: options.model.effort,
					...(options.model.capabilityTier ? { capabilityTier: options.model.capabilityTier } : {}),
					...(options.model.providerCandidates ? { providerCandidates: options.model.providerCandidates } : {}),
					tools: resolveToolSelectors(options.tools ?? DEFAULT_SUBAGENT_TOOLS, [PIBOX_TASK_TOOL_GROUP, PIBOX_LEDGER_TOOL_GROUP]),
					...(options.agentPrompt ? { agentPrompt: options.agentPrompt } : { promptPath: join(BUILT_IN_AGENT_ROOT, `${taskAgentName(options.task)}.md`) }),
					additionalPrompt: readBuiltInPrompt("workflow-task-agent"),
					persistentContext: options.persistentContext,
					...(options.skillPaths ? { skillPaths: options.skillPaths } : {}),
					deferCompletion: true,
					workItemId: options.workItemId,
					taskId: options.task.id,
					runId: created.record.id,
					workspace: options.workspace,
					env: {
						...mcpLaunchEnvironment(options.tools ?? DEFAULT_SUBAGENT_TOOLS),
						PIBOX_HARNESS_RUN_ID: created.record.id,
						PIBOX_HARNESS_WORK_ITEM: options.workItemId,
						PIBOX_HARNESS_TASK: options.task.id,
						PIBOX_HARNESS_CREDENTIAL: created.credential,
						PIBOX_HARNESS_PRIVATE_ROOT: options.identity.privateRoot,
						PIBOX_HARNESS_REPOSITORY_ID: options.identity.id,
						PIBOX_WORKFLOW_LEDGER_ATTEMPT: protocolAttempt === 1 ? "2" : "1",
					},
					signal: launchSignal,
					onAttemptReady: async (agent, attempt) => {
						logicalAgentId = agent.id;
						managed.agentId = agent.id;
						await options.assertPrelaunchCurrent?.();
						if (managed.attemptId && managed.attemptId !== attempt.id) {
							if (!managed.attemptGeneration) throw new HarnessError("CAPABILITY_DENIED", "Prior workflow agent attempt is missing its generation fence");
							await runs.releaseAgentAttempt(created.record.id, managed.attemptId, managed.attemptGeneration, expectedWorkflowFence);
						}
						managed.attemptId = attempt.id;
						managed.attemptGeneration = attempt.sequence;
						await runs.bindAgentAttempt(created.record.id, attempt.id, attempt.sequence, expectedWorkflowFence);
						// stop() may have arrived before the attempt existed or while bind was pending.
						// Re-check after bind so a late bind can never restore a revoked credential fence.
						if (managedController.signal.aborted || this.#termination.has(created.record.id)) {
							await runs.revokeAgentAttempt(created.record.id, attempt.id, { state: "cancelled", error: "Run cancelled by orchestrator" }, "run.stop_requested");
						}
					},
					beforeServiceLaunch: async (_agent, attempt) => {
						await options.assertPrelaunchCurrent?.();
						await runs.assertAgentAttemptLaunchable(created.record.id, attempt.id, attempt.sequence, expectedWorkflowFence);
					},
					onSpawn: async () => {
						const attemptId = managed.attemptId;
						if (!attemptId || this.#termination.has(created.record.id)) throw new HarnessError("CAPABILITY_DENIED", "Run was fenced before process startup completed");
						const current = await options.coordinator.registry.get(managed.agentId!);
						const attempt = current.attempts.find((candidate) => candidate.id === attemptId);
						if (!attempt) throw new HarnessError("CAPABILITY_DENIED", "Run process attempt disappeared during startup");
						const marked = await runs.updateForAgentAttempt(created.record.id, attemptId, attempt.sequence, { state: "running" }, "run.started", expectedWorkflowFence);
						if (!marked.updated) throw new HarnessError("CAPABILITY_DENIED", "Run was fenced before process startup completed");
					},
					...(options.onUpdate ? { onText: (text: string) => options.onUpdate?.({ content: [{ type: "text", text }], details: { runId: created.record.id, state: "running" } }) } : {}),
				});
			} catch (error) {
				if (!this.#termination.has(created.record.id)) throw error;
				execution = { exitCode: 1, stderr: error instanceof Error ? error.message : String(error), finalText: "", terminalReason: "explicit_stop" };
			}
			if (coordinated) {
				logicalAgentId = coordinated.agent.id;
				managed.agentId = coordinated.agent.id;
				if (coordinated.result.provider !== options.model.provider || coordinated.result.model !== options.model.model || coordinated.result.effort !== options.model.effort) {
					await runs.update(created.record.id, {
						resolvedProvider: coordinated.result.provider,
						resolvedModel: coordinated.result.model,
						resolvedEffort: coordinated.result.effort,
					}, "run.provider_fallback");
				}
				execution = { exitCode: coordinated.result.exitCode, stderr: coordinated.result.stderr, finalText: coordinated.result.text, terminalReason: coordinated.result.terminalReason };
			}
			stderr += execution.stderr;
			finalText = execution.finalText || finalText;
			const currentRun = await runs.read(created.record.id);
			const terminated = this.#termination.get(created.record.id);
			const handoff = !terminated && currentRun.currentAgentAttemptId === managed.attemptId && execution.terminalReason === "completed"
				? await runs.readHandoff(created.record.id)
				: undefined;
			if (handoff) {
				if (this.#termination.has(created.record.id)) return settleCancellation(execution.exitCode);
				if (!managed.attemptId || !managed.attemptGeneration) throw new HarnessError("CAPABILITY_DENIED", "Task handoff has no bound process-attempt fence");
				await runs.releaseAgentAttempt(created.record.id, managed.attemptId, managed.attemptGeneration, expectedWorkflowFence, { allowGenerationAdvance: true });
				await runs.assertCanonicalMutationAllowed(created.record.id);
				const currentItem = await workItems.read(options.workItemId);
				if (currentItem.planning.revision !== options.planningRevision) {
					const run = await runs.update(created.record.id, { state: "interrupted", error: `Planning advanced from revision ${options.planningRevision} to ${currentItem.planning.revision}` }, "run.context_stale");
					await updateTask(`context-stale:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "paused" }));
					if (logicalAgentId) await options.coordinator?.registry.transition(logicalAgentId, "interrupted", { error: "Canonical planning changed" }).catch(() => undefined);
					return { run, stderr, finalText };
				}
				const { runGit } = await import("./repository.js");
				const head = await runGit(options.workspace, ["rev-parse", "HEAD"]);
				const status = await runGit(options.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
				const actualCommits = (await runGit(options.workspace, ["rev-list", "--reverse", `${contributionBase}..HEAD`])).split("\n").filter(Boolean);
				const artifactChanges = await runGit(options.workspace, ["diff", "--name-only", `${contributionBase}..HEAD`, "--", "agent-artifacts"]);
				if (handoff.runId !== created.record.id || handoff.taskId !== options.task.id || status || artifactChanges || !handoff.commits.includes(head) || handoff.commits.some((commit) => !actualCommits.includes(commit))) {
					await runs.update(created.record.id, { state: "protocol_failed", error: "Terminal handoff failed supervisor Git/scope validation" }, "run.invalid_handoff");
					await updateTask(`invalid-handoff:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "protocol_failed" }));
					if (logicalAgentId) await options.coordinator?.registry.transition(logicalAgentId, "protocol_failed", { error: "Terminal handoff failed validation" }).catch(() => undefined);
					return { run: await runs.read(created.record.id), stderr, finalText };
				}
				if (this.#termination.has(created.record.id)) return settleCancellation(execution.exitCode);
				await runs.update(created.record.id, { state: "submitted", exitCode: execution.exitCode }, "run.submitted");
				await updateTask(`run-submitted:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, {
					status: "submitted",
					runtime: { completedCommit: head },
				}));
				await runs.update(created.record.id, { state: "awaiting_ci" }, "run.awaiting_ci");
				await updateTask(`run-awaiting-ci:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "awaiting_ci" }));

				const checks = normalizeChecks(options.task.verification.taskChecks, `Task ${options.task.id} checks`);
				const verifier = new VerificationRunner(options.identity);
				for (const check of checks) {
					const result = await verifier.run(options.workItemId, `task-${options.task.id}`, check, options.workspace, head);
					if (this.#termination.has(created.record.id)) return settleCancellation(result.code);
					if (result.code === 0) continue;
					const priorTask = await workItems.readTask(options.workItemId, options.task.id);
					const summary = verificationFailureSummary(result);
					const signature = createHash("sha256").update(JSON.stringify({ checkId: check.id, command: check.command, code: result.code, stdout: result.stdout.slice(-4_000), stderr: result.stderr.slice(-4_000) })).digest("hex");
					const previousFailure = priorTask.runtime?.deterministicFailure;
					const generation = previousFailure?.signature === signature ? (priorTask.runtime?.ciRepairGeneration ?? previousFailure.generation) + 1 : 1;
					const exhausted = generation >= 3;
					await updateTask(`run-ci-red:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, {
						status: exhausted ? "failed" : "changes_requested",
						runtime: {
							completedCommit: head,
							ciRepairGeneration: generation,
							deterministicFailure: {
								schemaVersion: 1,
								kind: "task_check",
								generation,
								...(logicalAgentId ? { ownerAgentId: logicalAgentId } : {}),
								...((options.task.assembly.stageId ?? options.task.assembly.integrationUnit) ? { stageId: options.task.assembly.stageId ?? options.task.assembly.integrationUnit } : {}),
								baseCommit: contributionBase,
								candidateCommit: head,
								contributionCommits: handoff.commits,
								checkId: check.id,
								command: check.command,
								attemptPath: result.attemptPath,
								summary,
								signature,
								recordedAt: new Date().toISOString(),
							},
						},
					}));
					const run = await runs.update(created.record.id, { state: exhausted ? "failed" : "changes_requested", exitCode: result.code, error: summary }, exhausted ? "run.ci_exhausted" : "run.changes_requested");
					if (this.#termination.has(created.record.id)) return settleCancellation(result.code);
					if (exhausted && logicalAgentId) await options.coordinator?.registry.transition(logicalAgentId, "failed", { error: `Task CI exhausted after ${generation} attempts: ${summary}` }).catch(() => undefined);
					return { run, handoff, stderr, finalText };
				}

				if (this.#termination.has(created.record.id)) return settleCancellation(execution.exitCode);
				let settlement;
				try {
					settlement = await updateTask(`run-complete:${created.record.id}`, () => settleManagedTaskHandoff({
						workItems,
						runs,
						workItemId: options.workItemId,
						taskId: options.task.id,
						runId: created.record.id,
						handoff,
						completedCommit: head,
						exitCode: execution.exitCode,
						completionEvent: "run.completed",
						assertActive: () => { if (this.#termination.has(created.record.id)) throw new HarnessError("CAPABILITY_DENIED", "Task settlement belongs to a stopped workflow attempt"); },
					}));
				} catch (error) {
					if (this.#termination.has(created.record.id)) return settleCancellation(execution.exitCode);
					throw error;
				}
				await updateTask(`run-ci-green:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { runtime: { deterministicFailure: undefined, ciRepairGeneration: undefined } }));
				if (logicalAgentId && options.coordinator) {
					await finalizeTaskAgentAfterSettlement(options.coordinator.registry, logicalAgentId, handoff.summary);
					await options.coordinator.release(logicalAgentId).catch(() => false);
				}
				return { run: settlement.run, handoff, stderr, finalText };
			}
			if (terminated) return settleCancellation(execution.exitCode);
			if (logicalAgentId) {
				const logical = await options.coordinator?.registry.get(logicalAgentId);
				if (logical && (logical.state === "waiting_decision" || logical.state === "blocked")) {
					const run = await runs.update(created.record.id, { state: "interrupted", error: logical.summary ?? `Agent is ${logical.state}` }, `run.${logical.state}`);
					await updateTask(`run-${logical.state}:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "blocked" }));
					return { run, stderr, finalText };
				}
				if (logical?.state === "waiting_capacity") {
					const run = await runs.update(created.record.id, { state: "waiting_capacity", exitCode: execution.exitCode, error: logical.error ?? "Every configured provider route is temporarily unavailable" }, "run.waiting_capacity");
					await updateTask(`run-waiting-capacity:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "ready" }));
					return { run, stderr, finalText };
				}
				if (logical && (logical.state === "paused" || logical.state === "cancelled" || logical.state === "interrupted")) {
					const taskStatus = logical.state;
					const runState = taskStatus === "cancelled" ? "cancelled" : "interrupted";
					const run = await runs.update(created.record.id, { state: runState, exitCode: execution.exitCode, error: logical.error ?? logical.summary ?? `Agent is ${taskStatus}` }, `run.${runState}`);
					await updateTask(`run-${taskStatus}:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: taskStatus === "cancelled" ? "cancelled" : "paused" }));
					return { run, stderr, finalText };
				}
			}
			if (execution.exitCode !== 0) {
				const failure = classifyFailure({ message: `${execution.stderr}\n${execution.finalText}`, exitCode: execution.exitCode });
				const state = failure.capacityRelated ? "waiting_capacity" : "failed";
				const run = await runs.update(created.record.id, { state, exitCode: execution.exitCode, error: `${failure.class}: ${execution.stderr || execution.finalText}` }, `run.${state}`);
				await updateTask(`run-failed:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: state === "waiting_capacity" ? "ready" : "failed" }));
				return { run, stderr, finalText };
			}
		}
		const run = await runs.update(created.record.id, { state: "protocol_failed", error: "Missing task_complete handoff after one protocol nudge" }, "run.protocol_failed");
		await updateTask(`protocol-failed:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "protocol_failed" }));
		if (logicalAgentId) await options.coordinator?.registry.transition(logicalAgentId, "protocol_failed", { error: "Missing task_complete handoff after one protocol nudge" }).catch(() => undefined);
		return { run, stderr, finalText };
		} finally {
			options.signal?.removeEventListener("abort", stopFromUpstream);
			this.#settling.delete(created.record.id);
			this.#managed.delete(created.record.id);
			this.#termination.delete(created.record.id);
			managed.confirmSettled();
		}
	}

	/** Workflow pause is scheduler-only and never signals a managed process. */
	pause(_runId: string): boolean {
		return false;
	}

	/** Stop is service-owned and resolves only after the child and supervisor settle. */
	async stop(runId: string): Promise<boolean> {
		const managed = this.#managed.get(runId);
		if (!managed) return false;
		this.#termination.set(runId, "cancelled");
		// Abort synchronously: onAttemptReady re-checks this after binding, while the
		// coordinator uses it to stop a handle that appears after this call.
		managed.controller.abort(new DOMException("Run cancelled by orchestrator", "AbortError"));
		if (managed.attemptId) {
			await managed.runs.revokeAgentAttempt(runId, managed.attemptId, { state: "cancelled", error: "Run cancelled by orchestrator" }, "run.stop_requested");
		}
		if (managed.agentId) await managed.coordinator.stop(managed.agentId).catch(() => false);
		await managed.settled;
		return true;
	}

	async stopWorkItem(workItemId: string): Promise<number> {
		const runIds = [...this.#managed.entries()].filter(([, managed]) => managed.workItemId === workItemId).map(([runId]) => runId);
		await Promise.all(runIds.map((runId) => this.stop(runId)));
		return runIds.length;
	}

	activeRunIds(): string[] {
		return [...this.#settling];
	}
}
