import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "./errors.js";
import type { LaunchCoordinator } from "../workflow-runtime/launch-coordinator.js";
import { classifyFailure } from "./failure-classifier.js";
import type { RepositoryIdentity } from "./repository.js";
import { HarnessRunStore, type RunRecord, type TaskHandoff } from "./run-store.js";
import { taskAgentName, type ModelTier, type TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { BUILT_IN_AGENT_ROOT, readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import { DEFAULT_SUBAGENT_TOOLS, PIBOX_LEDGER_TOOL_GROUP, PIBOX_TASK_TOOL_GROUP, resolveToolSelectors } from "./tool-groups.js";
import { mcpLaunchEnvironment } from "./mcp-capabilities.js";
import { FAST_MODE_EXTENSION_PATH } from "../fast-mode/index.js";
import { fastModeChildEnvironment } from "../fast-mode/runtime.js";
import { finalizeTaskAgentAfterSettlement, settleManagedTaskHandoff } from "./task-settlement.js";
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

const HARNESS_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

export interface LaunchTaskOptions {
	identity: RepositoryIdentity;
	workItemId: string;
	task: TaskManifest;
	workspace: string;
	branch: string;
	baseCommit: string;
	executionMode: "repository" | "worktree";
	planningRevision: number;
	model: LaunchModel;
	agentPrompt?: string;
	persistentContext: string;
	tools?: string[];
	skillPaths?: string[];
	canonicalMutation?: <T>(owner: string, operation: () => Promise<T>) => Promise<T>;
	signal?: AbortSignal;
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
	coordinator?: LaunchCoordinator;
}

export interface LaunchTaskResult {
	run: RunRecord;
	handoff?: TaskHandoff;
	stderr: string;
	finalText: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/")) return { command: process.execPath, args: [currentScript, ...args] };
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function finalAssistantText(events: unknown[]): string {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index] as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		return event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
	}
	return "";
}

function taskPrompt(options: LaunchTaskOptions, protocolNudge: boolean): string {
	const checks = options.task.verification.taskChecks.length ? options.task.verification.taskChecks.map((check) => `- ${check}`).join("\n") : "- None assigned at this boundary.";
	const prompt = renderBuiltInPrompt("managed-task", { taskId: options.task.id, taskTitle: options.task.title, checks });
	return `${prompt}${protocolNudge ? `\n\n${readBuiltInPrompt("task-protocol-nudge")}` : ""}`;
}

export class SubagentSupervisor {
	#active = new Map<string, ChildProcess>();
	#settling = new Set<string>();
	#termination = new Map<string, "paused" | "cancelled">();
	readonly invocationResolver: (args: string[]) => { command: string; args: string[] };

	constructor(invocationResolver = getPiInvocation) {
		this.invocationResolver = invocationResolver;
	}

	async launchTask(options: LaunchTaskOptions): Promise<LaunchTaskResult> {
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
			requestedModel: options.model.requested,
			resolvedProvider: options.model.provider,
			resolvedModel: options.model.model,
			resolvedEffort: options.model.effort,
		});
		this.#settling.add(created.record.id);
		try {
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
		let logicalAgentId = options.coordinator
			? (await options.coordinator.registry.list()).find((agent) => agent.workItemId === options.workItemId && agent.taskId === options.task.id && !["completed", "failed", "protocol_failed", "cancelled"].includes(agent.state))?.id
			: undefined;
		const answeredMessages = logicalAgentId && options.coordinator ? (await options.coordinator.registry.listMessages(logicalAgentId)).filter((message) => message.status === "answered") : [];
		const responseContext = answeredMessages.length ? `\n\n${renderBuiltInPrompt("orchestrator-responses", { responses: answeredMessages.map((message) => `- ${message.summary}: ${message.response}`).join("\n") })}` : "";
		for (let protocolAttempt = 0; protocolAttempt < 2; protocolAttempt++) {
			let execution: { exitCode: number; stderr: string; finalText: string };
			if (options.coordinator) {
				const coordinated = await options.coordinator.launch({
					operationId: created.record.id,
					...(logicalAgentId ? { existingAgentId: logicalAgentId } : {}),
					role: taskAgentName(options.task),
					task: `${taskPrompt(options, protocolAttempt === 1)}${responseContext}`,
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
					...(options.signal ? { signal: options.signal } : {}),
					onSpawn: (pid) => void runs.update(created.record.id, { state: "running", ...(pid === undefined ? {} : { pid }) }, "run.started"),
					...(options.onUpdate ? { onText: (text: string) => options.onUpdate?.({ content: [{ type: "text", text }], details: { runId: created.record.id, state: "running" } }) } : {}),
				});
				logicalAgentId = coordinated.agent.id;
				if (coordinated.result.provider !== options.model.provider || coordinated.result.model !== options.model.model || coordinated.result.effort !== options.model.effort) {
					await runs.update(created.record.id, {
						resolvedProvider: coordinated.result.provider,
						resolvedModel: coordinated.result.model,
						resolvedEffort: coordinated.result.effort,
					}, "run.provider_fallback");
				}
				execution = { exitCode: coordinated.result.exitCode, stderr: coordinated.result.stderr, finalText: coordinated.result.text };
			} else execution = await this.spawnTask(options, created.record.id, created.credential, protocolAttempt === 1);
			stderr += execution.stderr;
			finalText = execution.finalText || finalText;
			const handoff = await runs.readHandoff(created.record.id);
			if (handoff) {
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
					if (exhausted && logicalAgentId) await options.coordinator?.registry.transition(logicalAgentId, "failed", { error: `Task CI exhausted after ${generation} attempts: ${summary}` }).catch(() => undefined);
					return { run, handoff, stderr, finalText };
				}

				const settlement = await updateTask(`run-complete:${created.record.id}`, () => settleManagedTaskHandoff({
					workItems,
					runs,
					workItemId: options.workItemId,
					taskId: options.task.id,
					runId: created.record.id,
					handoff,
					completedCommit: head,
					exitCode: execution.exitCode,
					completionEvent: "run.completed",
				}));
				await updateTask(`run-ci-green:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { runtime: { deterministicFailure: undefined, ciRepairGeneration: undefined } }));
				if (logicalAgentId && options.coordinator) await finalizeTaskAgentAfterSettlement(options.coordinator.registry, logicalAgentId, handoff.summary);
				return { run: settlement.run, handoff, stderr, finalText };
			}
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
				if (logical && (logical.state === "paused" || logical.state === "cancelled")) {
					const taskStatus = logical.state;
					const runState = taskStatus === "paused" ? "interrupted" : "cancelled";
					const run = await runs.update(created.record.id, { state: runState, exitCode: execution.exitCode, error: logical.summary ?? `Agent is ${taskStatus}` }, `run.${runState}`);
					await updateTask(`run-${taskStatus}:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: taskStatus }));
					return { run, stderr, finalText };
				}
			}
			if (execution.exitCode !== 0) {
				const termination = this.#termination.get(created.record.id);
				if (termination) {
					this.#termination.delete(created.record.id);
					const runState = termination === "paused" ? "interrupted" : "cancelled";
					const run = await runs.update(created.record.id, { state: runState, exitCode: execution.exitCode, error: `Run ${termination} by orchestrator` }, `run.${runState}`);
					await updateTask(`run-terminated:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: termination }));
					return { run, stderr, finalText };
				}
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
			this.#settling.delete(created.record.id);
		}
	}

	pause(runId: string): boolean {
		return this.terminate(runId, "paused");
	}

	stop(runId: string): boolean {
		return this.terminate(runId, "cancelled");
	}

	private terminate(runId: string, state: "paused" | "cancelled"): boolean {
		const child = this.#active.get(runId);
		if (!child) return false;
		this.#termination.set(runId, state);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 5000).unref();
		return true;
	}

	activeRunIds(): string[] {
		return [...new Set([...this.#active.keys(), ...this.#settling])];
	}

	private async spawnTask(
		options: LaunchTaskOptions,
		runId: string,
		credential: string,
		protocolNudge: boolean,
	): Promise<{ exitCode: number; stderr: string; finalText: string }> {
		const promptDirectory = await mkdtemp(join(tmpdir(), "pibox-harness-prompt-"));
		const promptPath = join(promptDirectory, "implementer.md");
		const builtInAgentPrompt = await readFile(join(BUILT_IN_AGENT_ROOT, `${taskAgentName(options.task)}.md`), "utf8").catch(() => "");
		const agentPrompt = parseFrontmatter<Record<string, unknown>>(options.agentPrompt ?? builtInAgentPrompt).body;
		const systemPrompt = [agentPrompt, readBuiltInPrompt("workflow-task-agent"), options.persistentContext].filter(Boolean).join("\n\n");
		await writeFile(promptPath, `${systemPrompt.trim()}\n`, { encoding: "utf8", mode: 0o600 });
		const tools = resolveToolSelectors(options.tools ?? DEFAULT_SUBAGENT_TOOLS, [PIBOX_TASK_TOOL_GROUP, PIBOX_LEDGER_TOOL_GROUP]);
		const args = [
			"-e", HARNESS_EXTENSION_PATH,
			"-e", FAST_MODE_EXTENSION_PATH,
			"--mode", "json", "-p", "--no-session",
			"--model", `${options.model.provider}/${options.model.model}`,
			"--thinking", options.model.effort,
			"--tools", tools.join(","),
			"--append-system-prompt", promptPath,
		];
		for (const skillPath of options.skillPaths ?? []) args.push("--skill", skillPath);
		args.push(taskPrompt(options, protocolNudge));
		const invocation = this.invocationResolver(args);
		const runs = new HarnessRunStore(options.identity, options.workItemId);
		const events: unknown[] = [];
		let stderr = "";
		let buffer = "";
		try {
			const exitCode = await new Promise<number>((resolve) => {
				const child = spawn(invocation.command, invocation.args, {
					cwd: options.workspace,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						...mcpLaunchEnvironment(options.tools ?? DEFAULT_SUBAGENT_TOOLS),
						...fastModeChildEnvironment(options.model.capabilityTier, { provider: options.model.provider, model: options.model.model }),
						PIBOX_HARNESS_RUN_ID: runId,
						PIBOX_HARNESS_WORK_ITEM: options.workItemId,
						PIBOX_HARNESS_TASK: options.task.id,
						PIBOX_HARNESS_CREDENTIAL: credential,
						PIBOX_HARNESS_PRIVATE_ROOT: options.identity.privateRoot,
						PIBOX_HARNESS_REPOSITORY_ID: options.identity.id,
						PIBOX_WORKFLOW_LEDGER_ATTEMPT: protocolNudge ? "2" : "1",
					},
				});
				this.#active.set(runId, child);
				void runs.update(runId, { state: "running", ...(child.pid === undefined ? {} : { pid: child.pid }) }, "run.started");
				const processLine = (line: string) => {
					if (!line.trim()) return;
					try {
						const event = JSON.parse(line) as unknown;
						events.push(event);
						const text = finalAssistantText([event]);
						if (text && options.onUpdate) options.onUpdate({ content: [{ type: "text", text }], details: { runId, state: "running" } });
					} catch {
						void runs.appendEvent(runId, "process.stdout_unparsed", { line });
					}
				};
				child.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
				});
				child.stderr.on("data", (data) => (stderr += data.toString()));
				child.on("error", (error) => {
					stderr += error.message;
					resolve(1);
				});
				child.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					this.#active.delete(runId);
					resolve(code ?? 1);
				});
				if (options.signal) {
					const abort = () => child.kill("SIGTERM");
					if (options.signal.aborted) abort();
					else options.signal.addEventListener("abort", abort, { once: true });
				}
			});
			return { exitCode, stderr, finalText: finalAssistantText(events) };
		} finally {
			await rm(promptDirectory, { recursive: true, force: true });
		}
	}
}
