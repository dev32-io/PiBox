import type { WorkflowMetrics } from "../workflow-runtime/api.js";
import type { ProcessAttempt, SessionAgentRecord } from "../workflow-runtime/agent-registry.js";
import type { DurableVerificationAttemptRecord } from "./verification-runner.js";
import type { WorkflowDomainEvent } from "./workflow-events.js";

export interface WorkflowMetricProjectionInput {
	workItemId: string;
	workflowEvents: readonly WorkflowDomainEvent[];
	agents: readonly SessionAgentRecord[];
	verificationAttempts: readonly DurableVerificationAttemptRecord[];
	/** Projection boundary for open durable intervals. */
	now?: number;
}

type Interval = readonly [number, number];

const RUNNING_OPEN = new Set(["workflow.started", "workflow.resumed"]);
const RUNNING_CLOSE = new Set(["workflow.paused", "workflow.stopped", "workflow.completed", "workflow.failed"]);
const ELAPSED_TERMINAL = new Set(["workflow.stopped", "workflow.completed", "workflow.failed"]);
const TERMINAL_ATTEMPT_STATES = new Set(["exited", "failed"]);

function time(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegative(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function duration(start: number | undefined, end: number | undefined): number {
	return start === undefined || end === undefined ? 0 : Math.max(0, end - start);
}

function unionDuration(intervals: readonly Interval[]): number {
	const sorted = intervals
		.filter(([start, end]) => end >= start)
		.map(([start, end]) => [start, end] as const)
		.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	let total = 0;
	let open: Interval | undefined;
	for (const interval of sorted) {
		if (!open) { open = interval; continue; }
		if (interval[0] <= open[1]) open = [open[0], Math.max(open[1], interval[1])];
		else { total += open[1] - open[0]; open = interval; }
	}
	return total + (open ? open[1] - open[0] : 0);
}

function workflowTiming(events: readonly WorkflowDomainEvent[], now: number): Pick<WorkflowMetrics, "elapsedMs" | "runningMs"> & { elapsedOpen: boolean; runningOpen: boolean } {
	const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
	let firstStartedAt: number | undefined;
	let runningStartedAt: number | undefined;
	let terminalAt: number | undefined;
	const runningIntervals: Interval[] = [];
	for (const event of ordered) {
		const at = time(event.at);
		if (at === undefined) continue;
		if (event.type === "workflow.started" && firstStartedAt === undefined) firstStartedAt = at;
		if (firstStartedAt === undefined) continue;
		if (RUNNING_OPEN.has(event.type)) {
			if (runningStartedAt === undefined) runningStartedAt = at;
			terminalAt = undefined;
			continue;
		}
		if (!RUNNING_CLOSE.has(event.type)) continue;
		if (runningStartedAt !== undefined) runningIntervals.push([runningStartedAt, at]);
		runningStartedAt = undefined;
		if (ELAPSED_TERMINAL.has(event.type)) terminalAt = at;
	}
	if (runningStartedAt !== undefined) runningIntervals.push([runningStartedAt, now]);
	return {
		elapsedMs: duration(firstStartedAt, terminalAt ?? (firstStartedAt === undefined ? undefined : now)),
		runningMs: unionDuration(runningIntervals),
		elapsedOpen: firstStartedAt !== undefined && terminalAt === undefined,
		runningOpen: runningStartedAt !== undefined,
	};
}

function processInterval(attempt: ProcessAttempt, now: number): Interval | undefined {
	const progress = attempt.progress;
	// processStartedAt/processExitedAt are authoritative for current records.
	// Attempt/progress lifecycle timestamps preserve metrics for legacy records.
	const startedAt = time(progress?.processStartedAt ?? attempt.startedAt ?? progress?.startedAt);
	if (startedAt === undefined) return undefined;
	const explicitEnd = time(progress?.processExitedAt ?? attempt.exitedAt ?? progress?.settledAt);
	const terminalFallback = TERMINAL_ATTEMPT_STATES.has(attempt.state) ? time(attempt.updatedAt) : undefined;
	return [startedAt, explicitEnd ?? terminalFallback ?? now];
}

function processIntervalIsOpen(attempt: ProcessAttempt): boolean {
	if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) return false;
	const progress = attempt.progress;
	const startedAt = time(progress?.processStartedAt ?? attempt.startedAt ?? progress?.startedAt);
	const explicitEnd = time(progress?.processExitedAt ?? attempt.exitedAt ?? progress?.settledAt);
	return startedAt !== undefined && explicitEnd === undefined;
}

/** Pure projection from durable workflow, managed-agent, and verification records. */
export function projectWorkflowMetrics(input: WorkflowMetricProjectionInput): WorkflowMetrics {
	const now = input.now ?? Date.now();
	const events = input.workflowEvents.filter((event) => event.workItemId === input.workItemId);
	const agents = input.agents.filter((agent) => agent.workItemId === input.workItemId);
	const attempts = agents.flatMap((agent) => agent.attempts.map((attempt) => ({ agent, attempt })));
	const agentActiveMs = attempts.reduce((total, { attempt }) => {
		const interval = processInterval(attempt, now);
		return total + (interval ? duration(interval[0], interval[1]) : 0);
	}, 0);
	const fixes = new Set(attempts
		.filter(({ attempt }) => attempt.activity?.kind === "repair")
		.map(({ agent, attempt }) => `${agent.evaluationId ?? agent.runId ?? agent.id}:${attempt.activity!.generation}`)).size;
	const processRetries = agents.reduce((total, agent) => total + Math.max(0, agent.attempts.length - 1), 0);

	const uniqueVerification = new Map<string, DurableVerificationAttemptRecord>();
	for (const attempt of input.verificationAttempts) {
		if (attempt.workItemId !== input.workItemId) continue;
		uniqueVerification.set(`${attempt.stageId}:${attempt.checkId}:${attempt.id}`, attempt);
	}
	const verification = [...uniqueVerification.values()];
	const verificationMs = verification.reduce((total, attempt) => {
		const start = time(attempt.startedAt);
		const terminal = !["starting", "running"].includes(attempt.state);
		const end = time(attempt.completedAt) ?? (terminal ? start : now);
		return total + duration(start, end);
	}, 0);
	const activeVerifications = verification.filter((attempt) => ["starting", "running"].includes(attempt.state) && time(attempt.startedAt) !== undefined && time(attempt.completedAt) === undefined).length;
	const verificationGroups = new Map<string, number>();
	for (const attempt of verification) {
		const key = `${attempt.stageId}:${attempt.checkId}`;
		verificationGroups.set(key, (verificationGroups.get(key) ?? 0) + 1);
	}
	const verificationRetries = [...verificationGroups.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
	const timing = workflowTiming(events, now);
	return {
		elapsedMs: timing.elapsedMs,
		runningMs: timing.runningMs,
		agentActiveMs,
		verificationMs,
		fixes,
		retries: processRetries + verificationRetries,
		agentCount: agents.length,
		verificationAttempts: verification.length,
		inputTokens: attempts.reduce((total, { attempt }) => total + nonNegative(attempt.progress?.inputTokens), 0),
		outputTokens: attempts.reduce((total, { attempt }) => total + nonNegative(attempt.progress?.outputTokens), 0),
		toolErrors: attempts.reduce((total, { attempt }) => total + nonNegative(attempt.progress?.toolErrors), 0),
		live: {
			sampledAtMs: now,
			elapsed: timing.elapsedOpen,
			running: timing.runningOpen,
			activeAgents: attempts.filter(({ attempt }) => processIntervalIsOpen(attempt)).length,
			activeVerifications,
		},
	};
}
