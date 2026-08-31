import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sameRuntimeOwner } from "./activation.js";
import type {
	ContinuationSpec,
	LaunchSpec,
	LogicalAgentHandle,
	LogicalAgentSnapshot,
	PromptContextHashes,
	ResolvedExecutionConfig,
	RuntimeOwner,
	SubagentInspection,
	SubagentReplay,
	SubagentService,
	SubagentSubscription,
	SubagentEventListener,
	TerminalReason,
	TerminalResult,
	TerminalStatus,
} from "./api.js";
import { initialAgentProgress, markAgentProcessExited, markAgentProcessStarted, projectAgentProgress, type AgentProgress } from "./agent-progress.js";
import { ContinuationCapabilityStore, type ContinuationReservation } from "./continuations.js";
import { SubagentEventBuffer } from "./events.js";
import { createPiInvocationResolver, type SubagentInvocationRequest, type SubagentInvocationResolver } from "./invocation.js";
import { JsonlStreamParser } from "./jsonl.js";
import { promptContextHashes } from "./prompt-context.js";
import { SUBAGENT_PROTOCOL_VERSION } from "./registry.js";

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_EVENT_TEXT_CHARACTERS = 16 * 1024;

export interface SubagentProcessManagerOptions {
	readonly owner: RuntimeOwner;
	readonly sessionDirectory: string;
	readonly invocationResolver?: SubagentInvocationResolver;
	readonly eventCapacity?: number;
	readonly maximumStderrBytes?: number;
	readonly maximumJsonlLineCharacters?: number;
	readonly terminationGraceMs?: number;
	readonly idFactory?: () => string;
}

interface AgentRecord {
	readonly agentId: string;
	readonly agent: string;
	readonly cwd: string;
	readonly stableSystemContext: string;
	readonly transcriptPath: string;
	readonly execution: ResolvedExecutionConfig;
	readonly continuationKey: string | undefined;
	handle: LogicalAgentHandle;
	state: LogicalAgentSnapshot["state"];
	startedAt: string;
	updatedAt: string;
	progress: AgentProgress | undefined;
	summary: string | undefined;
	active: AttemptRecord | undefined;
	lastAttemptMetadata: Readonly<Record<string, string>> | undefined;
	lastResult: TerminalResult | undefined;
}

interface AttemptRecord {
	readonly attemptId: string;
	readonly contextHashes: PromptContextHashes;
	readonly child: ChildProcessWithoutNullStreams;
	readonly writerCapability: string;
	readonly continuation: boolean;
	readonly publicResult: Deferred<TerminalResult>;
	readonly completion: Deferred<void>;
	stopRequested: boolean;
	terminationReason: Extract<TerminalReason, "explicit_stop" | "owner_lost"> | undefined;
	termSent: boolean;
	settled: boolean;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

/** Owns bounded, non-detached child processes for exactly one runtime activation. */
export class SubagentProcessManager implements SubagentService {
	readonly protocolVersion = SUBAGENT_PROTOCOL_VERSION;
	readonly owner: RuntimeOwner;

	private readonly sessionDirectory: string;
	private readonly invocationResolver: SubagentInvocationResolver;
	private readonly maximumStderrBytes: number;
	private readonly maximumJsonlLineCharacters: number;
	private readonly terminationGraceMs: number;
	private readonly idFactory: () => string;
	private readonly events: SubagentEventBuffer;
	private readonly capabilities: ContinuationCapabilityStore<AgentRecord>;
	private readonly agents = new Map<string, AgentRecord>();
	private readonly transcriptWriters = new Set<string>();
	private closed = false;
	private teardownPromise: Promise<void> | undefined;

	constructor(options: SubagentProcessManagerOptions) {
		this.owner = structuredClone(options.owner);
		this.sessionDirectory = resolve(requireText(options.sessionDirectory, "sessionDirectory"));
		this.invocationResolver = options.invocationResolver ?? createPiInvocationResolver();
		this.maximumStderrBytes = positiveInteger(options.maximumStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, "maximumStderrBytes");
		this.maximumJsonlLineCharacters = positiveInteger(options.maximumJsonlLineCharacters ?? 1024 * 1024, "maximumJsonlLineCharacters");
		this.terminationGraceMs = nonNegativeNumber(options.terminationGraceMs ?? 1_500, "terminationGraceMs");
		this.idFactory = options.idFactory ?? randomUUID;
		this.events = new SubagentEventBuffer(this.owner, { agents: [] }, options.eventCapacity ?? 256);
		this.capabilities = new ContinuationCapabilityStore<AgentRecord>(this.idFactory);
	}

	async launch(spec: LaunchSpec): Promise<{ handle: LogicalAgentHandle; result: Promise<TerminalResult> }> {
		this.assertOpen();
		this.assertOwner(spec.owner);
		requireText(spec.agent, "agent");
		requireText(spec.cwd, "cwd");
		requireText(spec.attemptUserPrompt, "attemptUserPrompt");
		const execution = executionConfig(spec);
		const initialAttemptMetadata = spec.attemptMetadata ? cloneStringRecord(spec.attemptMetadata, "attemptMetadata") : undefined;
		await this.ensureSessionDirectory();
		this.assertOpen();
		this.assertOwner(spec.owner);

		const agentId = this.nextId("agent");
		const transcriptPath = resolve(this.sessionDirectory, `${agentId}.jsonl`);
		this.assertPrivateTranscriptPath(transcriptPath);
		const startedAt = new Date().toISOString();
		const record = {
			agentId,
			agent: spec.agent,
			cwd: resolve(spec.cwd),
			stableSystemContext: spec.stableSystemContext,
			transcriptPath,
			execution,
			continuationKey: spec.continuationKey,
			handle: undefined as unknown as LogicalAgentHandle,
			state: "launching" as const,
			startedAt,
			updatedAt: startedAt,
			progress: undefined,
			summary: undefined,
			active: undefined,
			lastAttemptMetadata: publicAttemptMetadata(initialAttemptMetadata),
			lastResult: undefined,
		};
		record.handle = this.capabilities.issue(this.owner, agentId, record);
		this.agents.set(agentId, record);
		try {
			const attempt = await this.startAttempt(record, spec.attemptUserPrompt, false, record.handle.continuationCapability, undefined, initialAttemptMetadata, undefined, undefined, spec.beforeSpawn);
			return { handle: structuredClone(record.handle), result: attempt.publicResult.promise };
		} catch (error) {
			this.agents.delete(agentId);
			this.capabilities.revoke(this.owner, record.handle);
			throw error;
		}
	}

	async continue(spec: ContinuationSpec): Promise<{ handle: LogicalAgentHandle; result: Promise<TerminalResult> }> {
		this.assertOpen();
		this.assertOwner(spec.owner);
		requireText(spec.attemptUserPrompt, "attemptUserPrompt");
		const reservation = this.capabilities.reserve(spec.owner, spec.handle);
		const record = reservation.value;
		if (record.active) {
			reservation.release();
			throw new Error("Logical agent already has an active transcript writer");
		}
		try {
			const attempt = await this.startAttempt(record, spec.attemptUserPrompt, true, spec.handle.continuationCapability, reservation, spec.attemptMetadata, spec.env, spec.workflowCredentials, spec.beforeSpawn);
			return { handle: structuredClone(spec.handle), result: attempt.publicResult.promise };
		} catch (error) {
			try { reservation.release(); } catch { /* a spawned attempt already consumed it */ }
			throw error;
		}
	}

	async wait(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<TerminalResult> {
		this.assertOpen();
		this.assertOwner(owner);
		this.assertOwner(handle.owner);
		const record = this.agents.get(handle.agentId);
		if (!record || record.handle.continuationCapability !== handle.continuationCapability) throw new Error("Unknown or stale logical agent handle");
		if (record.active) return record.active.publicResult.promise;
		if (record.lastResult) return structuredClone(record.lastResult);
		throw new Error("Logical agent has no attempt to wait for");
	}

	inspect(owner: RuntimeOwner, query: SubagentInspection = {}): readonly LogicalAgentSnapshot[] {
		this.assertOpen();
		this.assertOwner(owner);
		if (query.handle) this.assertOwner(query.handle.owner);
		const metadata = query.workflowMetadata ? cloneStringRecord(query.workflowMetadata, "workflowMetadata") : undefined;
		return this.snapshots().filter((snapshot) => {
			if (query.handle && (snapshot.handle.agentId !== query.handle.agentId || snapshot.handle.continuationCapability !== query.handle.continuationCapability)) return false;
			if (metadata && !Object.entries(metadata).every(([key, value]) => snapshot.workflowMetadata?.[key] === value)) return false;
			return true;
		});
	}

	async stop(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void> {
		this.assertOpen();
		this.assertOwner(owner);
		this.assertOwner(handle.owner);
		const record = this.agents.get(handle.agentId);
		const attempt = record?.active;
		if (!record || !attempt || attempt.writerCapability !== handle.continuationCapability) {
			throw new Error("Unknown or inactive logical agent handle");
		}
		if (!attempt.stopRequested) {
			attempt.stopRequested = true;
			attempt.terminationReason = "explicit_stop";
			record.state = "stopping";
			this.append(record, attempt, "stop_requested");
			this.append(record, attempt, "terminating", { signal: "SIGTERM" });
			this.sendTermination(attempt);
		}
		await this.escalateAndConfirm(attempt);
	}

	async release(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void> {
		this.assertOpen();
		this.assertOwner(owner);
		this.assertOwner(handle.owner);
		const record = this.agents.get(handle.agentId);
		if (!record || record.handle.continuationCapability !== handle.continuationCapability) throw new Error("Unknown or stale logical agent handle");
		if (record.active) throw new Error("Cannot release an active logical agent");
		this.capabilities.revoke(owner, record.handle);
		this.agents.delete(record.agentId);
		await rm(record.transcriptPath, { force: true });
	}

	replay(owner: RuntimeOwner, afterCursor?: number): SubagentReplay {
		this.assertOpen();
		this.assertOwner(owner);
		return this.events.replay(owner, afterCursor);
	}

	subscribe(owner: RuntimeOwner, afterCursor: number, listener: SubagentEventListener): SubagentSubscription {
		this.assertOpen();
		this.assertOwner(owner);
		return this.events.subscribe(owner, afterCursor, listener);
	}

	teardown(): Promise<void> {
		return this.teardownPromise ??= this.performTeardown();
	}

	private async performTeardown(): Promise<void> {
		this.closed = true;
		this.capabilities.clear();
		const attempts = [...this.agents.values()].flatMap((record) => record.active ? [record.active] : []);
		for (const attempt of attempts) {
			attempt.stopRequested = true;
			attempt.terminationReason = "owner_lost";
			attempt.child.stdin.end();
			this.sendTermination(attempt);
		}
		await Promise.all(attempts.map((attempt) => this.escalateAndConfirm(attempt)));
		this.events.close();
		const transcripts = [...this.agents.values()].map((record) => rm(record.transcriptPath, { force: true }).catch(() => undefined));
		await Promise.all(transcripts);
		this.agents.clear();
		this.transcriptWriters.clear();
		// The manager owns this activation directory. Removing it makes transcript
		// retention explicitly activation-scoped even after a crash-safe wrapper exit.
		await rm(this.sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
	}

	private async startAttempt(
		record: AgentRecord,
		attemptUserPrompt: string,
		continuation: boolean,
		writerCapability: string,
		reservation?: ContinuationReservation<AgentRecord>,
		attemptMetadata?: Readonly<Record<string, string>>,
		attemptEnv?: Readonly<Record<string, string>>,
		attemptWorkflowCredentials?: Readonly<Record<string, string>>,
		beforeSpawn?: () => void | Promise<void>,
	): Promise<AttemptRecord> {
		this.assertOpen();
		if (record.active || this.transcriptWriters.has(record.transcriptPath)) throw new Error("Transcript already has an active writer");
		const attemptId = this.nextId("attempt");
		const contextHashes = promptContextHashes(record.stableSystemContext, attemptUserPrompt);
		const normalizedAttemptMetadata = attemptMetadata ? cloneStringRecord(attemptMetadata, "attemptMetadata") : undefined;
		const request: SubagentInvocationRequest = {
			agentId: record.agentId,
			attemptId,
			agent: record.agent,
			cwd: record.cwd,
			stableSystemContext: record.stableSystemContext,
			attemptUserPrompt,
			transcriptPath: record.transcriptPath,
			continuation,
			...record.execution,
			...(attemptEnv ? { env: { ...record.execution.env, ...cloneStringRecord(attemptEnv, "env") } } : record.execution.env ? { env: record.execution.env } : {}),
			...(normalizedAttemptMetadata ? { attemptMetadata: normalizedAttemptMetadata } : {}),
			...(attemptWorkflowCredentials ? { workflowCredentials: cloneStringRecord(attemptWorkflowCredentials, "workflowCredentials") } : {}),
		};
		const invocation = await this.invocationResolver(request);
		this.assertOpen();
		validateInvocation(invocation);
		await beforeSpawn?.();
		this.assertOpen();
		const child = spawn(invocation.command, [...invocation.args], {
			cwd: record.cwd,
			detached: false,
			env: { ...process.env, ...invocation.env },
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const attempt: AttemptRecord = {
			attemptId,
			contextHashes,
			child,
			writerCapability,
			continuation,
			publicResult: deferred<TerminalResult>(),
			completion: deferred<void>(),
			stopRequested: false,
			terminationReason: undefined,
			termSent: false,
			settled: false,
		};
		record.active = attempt;
		record.lastAttemptMetadata = publicAttemptMetadata(normalizedAttemptMetadata);
		record.state = "running";
		const startedAt = new Date().toISOString();
		record.startedAt = startedAt;
		record.updatedAt = startedAt;
		record.progress = child.pid === undefined ? initialAgentProgress(startedAt) : markAgentProcessStarted(initialAgentProgress(startedAt), startedAt);
		this.transcriptWriters.add(record.transcriptPath);
		reservation?.settle();
		this.append(record, attempt, "attempt_started", { pid: child.pid ?? null, continuation, ...contextHashes });
		this.observeProcess(record, attempt);
		return attempt;
	}

	private observeProcess(record: AgentRecord, attempt: AttemptRecord): void {
		let stderr = "";
		let diagnostics = "";
		let finalText = "";
		let finalSeen = false;
		let malformedOutput = false;
		let assistantError: string | undefined;
		let agentSettled = false;
		let exitAt: string | undefined;

		const diagnose = (message: string): void => { diagnostics = retainUtf8Tail(diagnostics, `${message}\n`, this.maximumStderrBytes); };
		const parser = new JsonlStreamParser({
			maximumLineCharacters: this.maximumJsonlLineCharacters,
			onMalformed: (line, reason) => {
				malformedOutput = true;
				diagnose(`Malformed child JSONL (${reason}): ${boundedText(line, 2_048)}`);
			},
			onValue: (raw) => {
				if (this.closed || attempt.settled || !raw || typeof raw !== "object") return;
				const value = raw as Record<string, unknown>;
				const observedAt = new Date().toISOString();
				const previousProgress = record.progress ?? initialAgentProgress(observedAt);
				const nextProgress = projectAgentProgress(previousProgress, value, observedAt);
				if (nextProgress !== previousProgress) {
					record.progress = nextProgress;
					record.updatedAt = observedAt;
					if (value.type === "tool_execution_start" || value.type === "tool_execution_end") {
						const tool = nextProgress.activeTool ?? safeToolName(value.toolName);
						this.append(record, attempt, "tool_activity", {
							...(tool ? { tool } : {}),
							toolCalls: nextProgress.toolCalls,
							toolErrors: nextProgress.toolErrors,
							active: value.type === "tool_execution_start",
						});
					} else if (value.type === "turn_end") {
						this.append(record, attempt, "usage", {
							turns: nextProgress.turns,
							inputTokens: nextProgress.inputTokens ?? 0,
							outputTokens: nextProgress.outputTokens,
							reasoningTokens: nextProgress.reasoningTokens,
							cacheReadTokens: nextProgress.cacheReadTokens ?? 0,
							cacheWriteTokens: nextProgress.cacheWriteTokens ?? 0,
							...(nextProgress.contextTokens ? { contextTokens: nextProgress.contextTokens } : {}),
						});
					}
				}
				if (value.type === "message_update") {
					const update = value.assistantMessageEvent as Record<string, unknown> | undefined;
					if (update?.type === "text_delta" && typeof update.delta === "string" && update.delta) {
						this.append(record, attempt, "message_delta", { text: boundedText(update.delta, DEFAULT_EVENT_TEXT_CHARACTERS) });
					}
					return;
				}
				if (value.type === "message_end") {
					const message = value.message as Record<string, unknown> | undefined;
					if (message?.role !== "assistant") return;
					if (!Array.isArray(message.content)) {
						malformedOutput = true;
						diagnose("Malformed assistant message_end: message.content must be an array");
						return;
					}
					finalText = assistantText(message.content);
					finalSeen = true;
					assistantError = message.stopReason === "error" || message.stopReason === "aborted"
						? (typeof message.errorMessage === "string" ? message.errorMessage : `Assistant request ${message.stopReason}`)
						: undefined;
					this.append(record, attempt, "final_message", {
						text: boundedText(finalText, DEFAULT_EVENT_TEXT_CHARACTERS),
						...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
					});
					record.summary = boundedText(finalText, 512);
					return;
				}
				if (value.type === "agent_settled") agentSettled = true;
			},
		});

		attempt.child.stdout.on("data", (chunk: Buffer) => parser.write(chunk));
		attempt.child.stdout.once("end", () => parser.end());
		attempt.child.stderr.on("data", (chunk: Buffer) => { stderr = retainUtf8Tail(stderr, chunk.toString("utf8"), this.maximumStderrBytes); });
		attempt.child.once("error", (error) => diagnose(`Child process error: ${error.message}`));
		attempt.child.once("exit", () => { exitAt = new Date().toISOString(); });
		attempt.child.once("close", (code, signal) => {
			parser.end();
			if (!finalSeen) diagnose("Child exited without a final assistant message_end");
			if (!agentSettled) diagnose("Child exited without agent_settled");
			this.finishAttempt(record, attempt, {
				code,
				signal,
				exitAt: exitAt ?? new Date().toISOString(),
				stderr: retainUtf8Tail(stderr, diagnostics, this.maximumStderrBytes),
				finalText: finalSeen ? finalText : "",
				finalSeen,
				malformedOutput,
				assistantError,
				agentSettled,
			});
		});
	}

	private finishAttempt(record: AgentRecord, attempt: AttemptRecord, outcome: {
		code: number | null;
		signal: NodeJS.Signals | null;
		exitAt: string;
		stderr: string;
		finalText: string;
		finalSeen: boolean;
		malformedOutput: boolean;
		assistantError: string | undefined;
		agentSettled: boolean;
	}): void {
		if (attempt.settled) return;
		attempt.settled = true;
		record.progress = markAgentProcessExited(record.progress ?? initialAgentProgress(outcome.exitAt), outcome.exitAt);
		record.updatedAt = outcome.exitAt;

		const status: TerminalStatus = attempt.stopRequested
			? "cancelled"
			: outcome.code === 0 && outcome.finalSeen && outcome.agentSettled && !outcome.malformedOutput && !outcome.assistantError
				? "completed"
				: "failed";
		const reason: TerminalReason = attempt.terminationReason ?? (status === "completed" ? "completed" : "failure");
		if (!this.closed) this.append(record, attempt, "process_exited", {
			exitCode: outcome.code,
			...(outcome.signal ? { signal: outcome.signal } : {}),
		}, outcome.exitAt);
		if (!this.closed) this.append(record, attempt, "output_drained");
		if (!this.closed && attempt.continuation) record.handle = this.capabilities.issue(this.owner, record.agentId, record);
		record.state = status;
		record.summary = boundedText(outcome.finalText || outcome.assistantError || outcome.stderr, 512);
		const resultStderr = retainUtf8Tail(
			outcome.stderr,
			outcome.assistantError ? `${outcome.stderr && !outcome.stderr.endsWith("\n") ? "\n" : ""}${outcome.assistantError}` : "",
			this.maximumStderrBytes,
		);
		const result: TerminalResult = {
			owner: structuredClone(this.owner),
			handle: structuredClone(record.handle),
			attemptId: attempt.attemptId,
			contextHashes: structuredClone(attempt.contextHashes),
			status,
			reason,
			exitCode: outcome.code,
			text: outcome.finalText,
			...(resultStderr ? { stderr: resultStderr } : {}),
			...(record.progress ? { progress: structuredClone(record.progress) } : {}),
		};
		record.lastResult = result;
		// Exclusivity ends only after exit, output drain, and capability rotation,
		// immediately before the terminal event can synchronously wake subscribers.
		record.active = undefined;
		this.transcriptWriters.delete(record.transcriptPath);
		if (!this.closed) this.append(record, attempt, "terminal", { status, reason, exitCode: outcome.code, agentSettled: outcome.agentSettled, ...attempt.contextHashes });
		attempt.publicResult.resolve(result);
		attempt.completion.resolve(undefined);
	}

	private sendTermination(attempt: AttemptRecord): void {
		if (attempt.settled || attempt.termSent) return;
		attempt.termSent = true;
		try { attempt.child.kill("SIGTERM"); } catch { /* close remains authoritative */ }
	}

	private async escalateAndConfirm(attempt: AttemptRecord): Promise<void> {
		if (attempt.settled) return;
		const settledDuringGrace = await Promise.race([
			attempt.completion.promise.then(() => true),
			delay(this.terminationGraceMs).then(() => false),
		]);
		if (!settledDuringGrace && !attempt.settled) {
			try { attempt.child.kill("SIGKILL"); } catch { /* wait for confirmed close */ }
		}
		await attempt.completion.promise;
	}

	private append(record: AgentRecord, attempt: AttemptRecord, type: Parameters<SubagentEventBuffer["append"]>[0]["type"], data?: Readonly<Record<string, unknown>>, at?: string): void {
		if (this.closed) return;
		record.updatedAt = at ?? new Date().toISOString();
		this.events.append({ agentId: record.agentId, attemptId: attempt.attemptId, type, ...(data ? { data } : {}), ...(at ? { at } : {}) }, { agents: this.snapshots() });
	}

	private snapshots(): LogicalAgentSnapshot[] {
		return [...this.agents.values()].map((record) => ({
			handle: structuredClone(record.handle),
			agent: record.agent,
			state: record.state,
			...(record.active?.child.pid === undefined ? {} : { processId: record.active.child.pid }),
			provider: record.execution.provider,
			model: record.execution.model,
			effort: record.execution.effort,
			fast: record.execution.fast,
			...(record.continuationKey ? { continuationKey: record.continuationKey } : {}),
			...(record.execution.workflowMetadata ? { workflowMetadata: structuredClone(record.execution.workflowMetadata) } : {}),
			...(record.lastAttemptMetadata ? { attemptMetadata: structuredClone(record.lastAttemptMetadata) } : {}),
			startedAt: record.startedAt,
			updatedAt: record.updatedAt,
			...(record.active ? { attemptId: record.active.attemptId, contextHashes: structuredClone(record.active.contextHashes) } : record.lastResult ? { contextHashes: structuredClone(record.lastResult.contextHashes) } : {}),
			...(record.progress ? { progress: structuredClone(record.progress) } : {}),
			...(record.summary ? { summary: record.summary } : {}),
		}));
	}

	private async ensureSessionDirectory(): Promise<void> {
		await mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
	}

	private assertPrivateTranscriptPath(path: string): void {
		if (!path.startsWith(`${this.sessionDirectory}${sep}`)) throw new Error("Transcript path escaped the configured session directory");
	}

	private assertOwner(owner: RuntimeOwner): void {
		if (!sameRuntimeOwner(owner, this.owner)) throw new Error("Subagent manager belongs to another runtime activation");
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Subagent manager has been torn down");
	}

	private nextId(kind: string): string {
		const value = this.idFactory();
		if (!value || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new Error(`Invalid ${kind} id`);
		return value;
	}
}

function deferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	let settled = false;
	const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
	return {
		promise,
		resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
	};
}

function executionConfig(value: ResolvedExecutionConfig): ResolvedExecutionConfig {
	if (typeof value.fast !== "boolean") throw new Error("fast must be a boolean");
	return {
		provider: requireText(value.provider, "provider"),
		model: requireText(value.model, "model"),
		effort: requireText(value.effort, "effort"),
		tools: cloneStringList(value.tools, "tools"),
		extensionPaths: cloneStringList(value.extensionPaths, "extensionPaths"),
		skillPaths: cloneStringList(value.skillPaths, "skillPaths"),
		fast: value.fast,
		...(value.env ? { env: cloneStringRecord(value.env, "env") } : {}),
		...(value.workflowCredentials ? { workflowCredentials: cloneStringRecord(value.workflowCredentials, "workflowCredentials") } : {}),
		...(value.workflowMetadata ? { workflowMetadata: cloneStringRecord(value.workflowMetadata, "workflowMetadata") } : {}),
	};
}

function cloneStringList(value: readonly string[], name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${name} must contain non-empty strings`);
	return [...value];
}

function cloneStringRecord(value: Readonly<Record<string, string>>, name: string): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a string record`);
	const cloned: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!key || typeof entry !== "string") throw new Error(`${name} must contain string environment entries`);
		cloned[key] = entry;
	}
	return cloned;
}

function publicAttemptMetadata(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value).filter(([key]) => key.startsWith("PIBOX_WORKFLOW_"));
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function safeToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 32);
	return normalized || undefined;
}

function assistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const value = part as Record<string, unknown>;
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("\n");
}

function retainUtf8Tail(current: string, addition: string, maximum: number): string {
	const combined = Buffer.from(current + addition, "utf8");
	return combined.length <= maximum ? combined.toString("utf8") : combined.subarray(combined.length - maximum).toString("utf8");
}

function boundedText(value: string, maximumCharacters: number): string {
	return value.length <= maximumCharacters ? value : value.slice(0, maximumCharacters);
}

function requireText(value: string, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}

function nonNegativeNumber(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
	return value;
}

function validateInvocation(invocation: { command: string; args: readonly string[] }): void {
	if (!invocation.command) throw new Error("Invocation command is required");
	if (!Array.isArray(invocation.args) || invocation.args.some((argument) => typeof argument !== "string")) throw new Error("Invocation arguments must be strings");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
