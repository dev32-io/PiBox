import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "./errors.js";
import { classifyFailure } from "./failure-classifier.js";
import type { RepositoryIdentity } from "./repository.js";
import { HarnessRunStore, type RunRecord, type TaskHandoff } from "./run-store.js";
import type { TaskManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";

export interface LaunchModel {
	provider: string;
	model: string;
	effort: string;
	requested: string;
}

const HARNESS_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const ROLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "roles");

export interface LaunchTaskOptions {
	identity: RepositoryIdentity;
	workItemId: string;
	task: TaskManifest;
	workspace: string;
	branch: string;
	baseCommit: string;
	planningRevision: number;
	model: LaunchModel;
	rolePrompt?: string;
	tools?: string[];
	skillPaths?: string[];
	canonicalMutation?: <T>(owner: string, operation: () => Promise<T>) => Promise<T>;
	signal?: AbortSignal;
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
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

function taskPrompt(options: LaunchTaskOptions, protocolNudge: boolean, builtInRolePrompt: string): string {
	const checks = options.task.verification.taskChecks.length ? options.task.verification.taskChecks.map((check) => `- ${check}`).join("\n") : "- None assigned at this boundary.";
	return [
		options.rolePrompt ?? builtInRolePrompt,
		"",
		"Execute the supervised contribution below. The approved artifacts and main-session decisions are authoritative.",
		`Work item: ${options.workItemId}`,
		`Task: ${options.task.id} — ${options.task.title}`,
		`Planning revision: ${options.planningRevision}`,
		`Workspace: ${options.workspace}`,
		"",
		"Call task_context list, then read the task brief, acceptance contract, and referenced canonical artifacts before editing.",
		"Keep changes inside the contribution boundary, commit intended changes, and leave canonical artifacts to the main session.",
		"Preserve declared partial state and run only proof assigned to this boundary.",
		"Assigned task checks:",
		checks,
		"",
		"Completion: leave the worktree clean and call task_complete with actual commits, checks, expected failures, and residual risks.",
		...(protocolNudge
			? ["", "Completion protocol: no valid task_complete handoff was recorded. Inspect the retained branch, finish missing commit or check work, and call task_complete."]
			: []),
	].join("\n");
}

export class SubagentSupervisor {
	#active = new Map<string, ChildProcess>();
	#termination = new Map<string, "paused" | "cancelled">();
	readonly invocationResolver: (args: string[]) => { command: string; args: string[] };

	constructor(invocationResolver = getPiInvocation) {
		this.invocationResolver = invocationResolver;
	}

	async launchTask(options: LaunchTaskOptions): Promise<LaunchTaskResult> {
		const runs = new HarnessRunStore(options.identity.privateRoot, options.workItemId);
		const workItems = new WorkItemStore(options.identity.root);
		const updateTask = <T>(owner: string, operation: () => Promise<T>) =>
			options.canonicalMutation ? options.canonicalMutation(owner, operation) : operation();
		const created = await runs.create({
			repositoryId: options.identity.id,
			workItemId: options.workItemId,
			taskId: options.task.id,
			role: options.task.execution.assignment.role,
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
		await updateTask(`run-start:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, {
			status: "running",
			runtime: { branch: options.branch, worktree: options.workspace, baseCommit: options.baseCommit, lastRunId: created.record.id },
		}));

		let stderr = "";
		let finalText = "";
		for (let protocolAttempt = 0; protocolAttempt < 2; protocolAttempt++) {
			const execution = await this.spawnTask(options, created.record.id, created.credential, protocolAttempt === 1);
			stderr += execution.stderr;
			finalText = execution.finalText || finalText;
			const handoff = await runs.readHandoff(created.record.id);
			if (handoff) {
				const currentItem = await workItems.read(options.workItemId);
				if (currentItem.planning.status !== "approved" || currentItem.planning.revision !== options.planningRevision) {
					const run = await runs.update(created.record.id, { state: "interrupted", error: `Planning changed to ${currentItem.planning.status} r${currentItem.planning.revision}` }, "run.context_stale");
					await updateTask(`context-stale:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "paused" }));
					return { run, stderr, finalText };
				}
				const { runGit } = await import("./repository.js");
				const head = await runGit(options.workspace, ["rev-parse", "HEAD"]);
				const status = await runGit(options.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
				const actualCommits = (await runGit(options.workspace, ["rev-list", "--reverse", `${options.baseCommit}..HEAD`])).split("\n").filter(Boolean);
				const artifactChanges = await runGit(options.workspace, ["diff", "--name-only", `${options.baseCommit}..HEAD`, "--", "agent-artifacts"]);
				if (handoff.runId !== created.record.id || handoff.taskId !== options.task.id || status || artifactChanges || !handoff.commits.includes(head) || handoff.commits.some((commit) => !actualCommits.includes(commit))) {
					await runs.update(created.record.id, { state: "protocol_failed", error: "Terminal handoff failed supervisor Git/scope validation" }, "run.invalid_handoff");
					await updateTask(`invalid-handoff:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "protocol_failed" }));
					return { run: await runs.read(created.record.id), stderr, finalText };
				}
				const run = await runs.update(created.record.id, { state: "completed", exitCode: execution.exitCode }, "run.completed");
				await updateTask(`run-complete:${created.record.id}`, () => workItems.updateTask(options.workItemId, options.task.id, { status: "contribution_complete", runtime: { completedCommit: head } }));
				return { run, handoff, stderr, finalText };
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
		return { run, stderr, finalText };
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
		return [...this.#active.keys()];
	}

	private async spawnTask(
		options: LaunchTaskOptions,
		runId: string,
		credential: string,
		protocolNudge: boolean,
	): Promise<{ exitCode: number; stderr: string; finalText: string }> {
		const promptDirectory = await mkdtemp(join(tmpdir(), "pibox-harness-prompt-"));
		const promptPath = join(promptDirectory, "implementer.md");
		const builtInRolePrompt = await readFile(join(ROLE_ROOT, `${options.task.execution.assignment.role}.md`), "utf8").catch(() => "");
		await writeFile(promptPath, taskPrompt(options, protocolNudge, builtInRolePrompt), { encoding: "utf8", mode: 0o600 });
		const taskCapabilities = ["task_context", "task_checkpoint", "task_request_change", "task_report_decision", "task_blocked", "task_complete"];
		const tools = [...new Set([...(options.tools ?? ["read", "grep", "find", "bash", "edit", "write"]), ...taskCapabilities])];
		const args = [
			"-e", HARNESS_EXTENSION_PATH,
			"--mode", "json", "-p", "--no-session",
			"--model", `${options.model.provider}/${options.model.model}`,
			"--thinking", options.model.effort,
			"--tools", tools.join(","),
			"--append-system-prompt", promptPath,
		];
		for (const skillPath of options.skillPaths ?? []) args.push("--skill", skillPath);
		args.push(protocolNudge ? "Complete the required terminal protocol for the existing task contribution." : `Implement harness task ${options.task.id}.`);
		const invocation = this.invocationResolver(args);
		const runs = new HarnessRunStore(options.identity.privateRoot, options.workItemId);
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
						PIBOX_HARNESS_RUN_ID: runId,
						PIBOX_HARNESS_WORK_ITEM: options.workItemId,
						PIBOX_HARNESS_TASK: options.task.id,
						PIBOX_HARNESS_CREDENTIAL: credential,
						PIBOX_HARNESS_PRIVATE_ROOT: options.identity.privateRoot,
						PIBOX_HARNESS_REPOSITORY_ID: options.identity.id,
					},
				});
				this.#active.set(runId, child);
				void runs.update(runId, { state: "running", ...(child.pid === undefined ? {} : { pid: child.pid }) }, "run.started");
				const processLine = (line: string) => {
					if (!line.trim()) return;
					try {
						const event = JSON.parse(line) as unknown;
						events.push(event);
						void runs.appendTranscript(runId, event);
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
			await runs.flushTranscript(runId);
			return { exitCode, stderr, finalText: finalAssistantText(events) };
		} finally {
			await rm(promptDirectory, { recursive: true, force: true });
		}
	}
}
