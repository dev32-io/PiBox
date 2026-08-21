import type { WorkflowMetricCategory, WorkflowMetrics } from "../workflow-runtime/api.js";
import { TERMINAL_AGENT_STATES, type ProcessAttempt, type SessionAgentRecord } from "../workflow-runtime/agent-registry.js";
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
type TimedCategory = Exclude<WorkflowMetricCategory, "orchestration">;

const RUNNING_CLOSE = new Set(["workflow.paused", "workflow.stopped", "workflow.completed", "workflow.failed", "workflow.detached"]);
const ELAPSED_TERMINAL = new Set(["workflow.stopped", "workflow.completed", "workflow.failed"]);
const TERMINAL_ATTEMPT_STATES = new Set(["exited", "failed"]);
const CATEGORY_PRIORITY: readonly TimedCategory[] = ["e2e", "review", "verification", "integration", "implementation"];

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

function unionIntervals(intervals: readonly Interval[]): Interval[] {
	const sorted = intervals
		.filter(([start, end]) => end > start)
		.map(([start, end]) => [start, end] as Interval)
		.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	const union: Interval[] = [];
	for (const interval of sorted) {
		const previous = union.at(-1);
		if (!previous || interval[0] > previous[1]) union.push(interval);
		else union[union.length - 1] = [previous[0], Math.max(previous[1], interval[1])];
	}
	return union;
}

function unionDuration(intervals: readonly Interval[]): number {
	return unionIntervals(intervals).reduce((total, interval) => total + duration(interval[0], interval[1]), 0);
}

function opensRunning(event: WorkflowDomainEvent): boolean {
	if (event.type === "workflow.started" || event.type === "workflow.resumed") return true;
	return event.type === "workflow.attached" && event.transition?.to === "running";
}

function workflowTiming(events: readonly WorkflowDomainEvent[], now: number): Pick<WorkflowMetrics, "elapsedMs" | "runningMs"> & { elapsedOpen: boolean; runningOpen: boolean; runningIntervals: Interval[] } {
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
		if (opensRunning(event)) {
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
	const union = unionIntervals(runningIntervals);
	return {
		elapsedMs: duration(firstStartedAt, terminalAt ?? (firstStartedAt === undefined ? undefined : now)),
		runningMs: unionDuration(union),
		elapsedOpen: firstStartedAt !== undefined && terminalAt === undefined,
		runningOpen: runningStartedAt !== undefined,
		runningIntervals: union,
	};
}

function processInterval(attempt: ProcessAttempt, now: number, agent?: SessionAgentRecord): Interval | undefined {
	const progress = attempt.progress;
	// A timing record distinguishes launch from an actual OS process. Historical
	// records without timing retain their attempt/progress fallback.
	const startedAt = time(attempt.timing ? attempt.timing.processSpawnedAt : (progress?.processStartedAt ?? attempt.startedAt ?? progress?.startedAt));
	if (startedAt === undefined) return undefined;
	const explicitEnd = time(attempt.timing?.processExitedAt ?? progress?.processExitedAt ?? attempt.exitedAt ?? progress?.settledAt);
	const terminal = TERMINAL_ATTEMPT_STATES.has(attempt.state) || Boolean(agent && TERMINAL_AGENT_STATES.has(agent.state));
	const terminalFallback = terminal ? time(attempt.updatedAt ?? agent?.completedAt ?? agent?.updatedAt) : undefined;
	return [startedAt, explicitEnd ?? terminalFallback ?? now];
}

function processIntervalIsOpen(attempt: ProcessAttempt, agent?: SessionAgentRecord): boolean {
	if (TERMINAL_ATTEMPT_STATES.has(attempt.state) || Boolean(agent && TERMINAL_AGENT_STATES.has(agent.state))) return false;
	const progress = attempt.progress;
	const startedAt = time(attempt.timing ? attempt.timing.processSpawnedAt : (progress?.processStartedAt ?? attempt.startedAt ?? progress?.startedAt));
	const explicitEnd = time(attempt.timing?.processExitedAt ?? progress?.processExitedAt ?? attempt.exitedAt ?? progress?.settledAt);
	return startedAt !== undefined && explicitEnd === undefined;
}

function schedulingInterval(attempt: ProcessAttempt, now: number): Interval | undefined {
	const start = time(attempt.timing?.attemptStartedAt ?? attempt.startedAt);
	if (start === undefined) return undefined;
	const ready = time(attempt.timing?.childReadyAt ?? attempt.timing?.firstActivityAt ?? attempt.progress?.processStartedAt);
	if (ready !== undefined) return [start, ready];
	if (!attempt.timing) return undefined;
	const terminal = time(attempt.timing.processExitedAt ?? attempt.exitedAt ?? (TERMINAL_ATTEMPT_STATES.has(attempt.state) ? attempt.updatedAt : undefined));
	return [start, terminal ?? now];
}

function schedulingIntervalIsOpen(attempt: ProcessAttempt): boolean {
	return Boolean(attempt.timing && !TERMINAL_ATTEMPT_STATES.has(attempt.state) && !attempt.timing.childReadyAt && !attempt.timing.firstActivityAt);
}

type AgentMetricRole = "implementer" | "reviewer" | "fixer" | "e2e";

function agentMetricRole(agent: SessionAgentRecord, attempt: ProcessAttempt): AgentMetricRole | undefined {
	if (attempt.activity?.kind === "repair" || agent.role === "repair-implementer") return "fixer";
	if (agent.role === "e2e-tester") return "e2e";
	if (attempt.activity?.kind === "review" || agent.role === "code-reviewer") return "reviewer";
	if (agent.taskId || agent.role === "implementer") return "implementer";
	return undefined;
}

function agentCategory(agent: SessionAgentRecord, attempt: ProcessAttempt): TimedCategory | undefined {
	const role = agentMetricRole(agent, attempt);
	if (role === "fixer") return "integration";
	if (role === "e2e") return "e2e";
	if (role === "reviewer") return "review";
	if (role === "implementer") return "implementation";
	return undefined;
}

function stepCategoryIntervals(events: readonly WorkflowDomainEvent[], now: number): Map<TimedCategory, Interval[]> {
	const result = new Map<TimedCategory, Interval[]>();
	const open = new Map<string, { category: TimedCategory; startedAt: number }>();
	for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
		const at = time(event.at);
		if (at === undefined) continue;
		if (event.type === "step.started" && event.metricCategory) {
			open.set(event.correlationId, { category: event.metricCategory, startedAt: at });
			continue;
		}
		if (event.type !== "step.settled" && event.type !== "step.failed") continue;
		const started = open.get(event.correlationId);
		if (!started) continue;
		const intervals = result.get(started.category) ?? [];
		intervals.push([started.startedAt, at]);
		result.set(started.category, intervals);
		open.delete(event.correlationId);
	}
	for (const started of open.values()) {
		const intervals = result.get(started.category) ?? [];
		intervals.push([started.startedAt, now]);
		result.set(started.category, intervals);
	}
	return result;
}

function exclusiveCategoryDurations(activeIntervals: readonly Interval[], categoryIntervals: ReadonlyMap<TimedCategory, readonly Interval[]>): { totals: Record<WorkflowMetricCategory, number>; activeCategory?: WorkflowMetricCategory } {
	const totals: Record<WorkflowMetricCategory, number> = { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0, orchestration: 0 };
	const normalized = new Map<TimedCategory, Interval[]>();
	for (const category of CATEGORY_PRIORITY) normalized.set(category, unionIntervals(categoryIntervals.get(category) ?? []));
	for (const active of activeIntervals) {
		const boundaries = new Set<number>(active);
		for (const intervals of normalized.values()) for (const interval of intervals) {
			const start = Math.max(active[0], interval[0]);
			const end = Math.min(active[1], interval[1]);
			if (end > start) { boundaries.add(start); boundaries.add(end); }
		}
		const ordered = [...boundaries].sort((left, right) => left - right);
		for (let index = 0; index < ordered.length - 1; index++) {
			const start = ordered[index]!;
			const end = ordered[index + 1]!;
			if (end <= start) continue;
			const category = CATEGORY_PRIORITY.find((candidate) => normalized.get(candidate)!.some((interval) => interval[0] < end && interval[1] > start)) ?? "orchestration";
			totals[category] += end - start;
		}
	}
	const active = activeIntervals.at(-1);
	const now = active?.[1];
	const activeCategory = active && now !== undefined
		? CATEGORY_PRIORITY.find((candidate) => normalized.get(candidate)!.some((interval) => interval[0] <= now && interval[1] >= now)) ?? "orchestration"
		: undefined;
	return { totals, ...(activeCategory ? { activeCategory } : {}) };
}

/** Pure projection from durable workflow, managed-agent, step, and verification records. */
export function projectWorkflowMetrics(input: WorkflowMetricProjectionInput): WorkflowMetrics {
	const now = input.now ?? Date.now();
	const events = input.workflowEvents.filter((event) => event.workItemId === input.workItemId);
	const agents = input.agents.filter((agent) => agent.workItemId === input.workItemId);
	const attempts = agents.flatMap((agent) => agent.attempts.map((attempt) => ({ agent, attempt })));
	const roleTotals: Record<AgentMetricRole, number> = { implementer: 0, reviewer: 0, fixer: 0, e2e: 0 };
	const activeRoles: Record<AgentMetricRole, number> = { implementer: 0, reviewer: 0, fixer: 0, e2e: 0 };
	let agentActiveMs = 0;
	let harnessSchedulingMs = 0;
	let activeScheduling = 0;
	for (const { agent, attempt } of attempts) {
		const interval = processInterval(attempt, now, agent);
		const processMs = interval ? duration(interval[0], interval[1]) : 0;
		agentActiveMs += processMs;
		const role = agentMetricRole(agent, attempt);
		if (role) {
			roleTotals[role] += processMs;
			if (processIntervalIsOpen(attempt, agent)) activeRoles[role] += 1;
		}
		const scheduling = schedulingInterval(attempt, now);
		if (scheduling) harnessSchedulingMs += duration(scheduling[0], scheduling[1]);
		if (schedulingIntervalIsOpen(attempt)) activeScheduling += 1;
	}
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
	const activeVerifications = verification.filter((attempt) => ["starting", "running"].includes(attempt.state) && time(attempt.startedAt) !== undefined && time(attempt.completedAt) === undefined).length;
	const deterministicMs = verification.reduce((total, attempt) => {
		const start = time(attempt.startedAt);
		if (start === undefined) return total;
		const terminal = !["starting", "running"].includes(attempt.state);
		const end = time(attempt.completedAt) ?? (terminal ? start : now);
		return total + duration(start, end);
	}, 0);
	const verificationGroups = new Map<string, number>();
	for (const attempt of verification) {
		const key = `${attempt.stageId}:${attempt.checkId}`;
		verificationGroups.set(key, (verificationGroups.get(key) ?? 0) + 1);
	}
	const verificationRetries = [...verificationGroups.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);

	const categoryIntervals = stepCategoryIntervals(events, now);
	for (const { agent, attempt } of attempts) {
		const category = agentCategory(agent, attempt);
		const interval = processInterval(attempt, now, agent);
		if (!category || !interval) continue;
		const intervals = categoryIntervals.get(category) ?? [];
		intervals.push(interval);
		categoryIntervals.set(category, intervals);
	}
	for (const attempt of verification) {
		const start = time(attempt.startedAt);
		if (start === undefined) continue;
		const terminal = !["starting", "running"].includes(attempt.state);
		const end = time(attempt.completedAt) ?? (terminal ? start : now);
		if (end === undefined) continue;
		const intervals = categoryIntervals.get("verification") ?? [];
		intervals.push([start, end]);
		categoryIntervals.set("verification", intervals);
	}

	const timing = workflowTiming(events, now);
	const categories = exclusiveCategoryDurations(timing.runningIntervals, categoryIntervals);
	const knownIntervals = attempts.flatMap(({ agent, attempt }) => {
		const interval = processInterval(attempt, now, agent);
		return interval ? [interval] : [];
	});
	for (const attempt of verification) {
		const start = time(attempt.startedAt);
		if (start === undefined) continue;
		const terminal = !["starting", "running"].includes(attempt.state);
		const end = time(attempt.completedAt) ?? (terminal ? start : now);
		if (end > start) knownIntervals.push([start, end]);
	}
	const coveredActive = timing.runningIntervals.flatMap((active) => knownIntervals.flatMap((known) => {
		const start = Math.max(active[0], known[0]);
		const end = Math.min(active[1], known[1]);
		return end > start ? [[start, end] as Interval] : [];
	}));
	const orchestrationMs = Math.max(0, timing.runningMs - unionDuration(coveredActive));
	const orchestratorOpen = timing.runningOpen && !attempts.some(({ agent, attempt }) => processIntervalIsOpen(attempt, agent)) && activeVerifications === 0;
	return {
		elapsedMs: timing.elapsedMs,
		runningMs: timing.runningMs,
		agentActiveMs,
		implementerMs: roleTotals.implementer,
		reviewerMs: roleTotals.reviewer,
		fixerMs: roleTotals.fixer,
		e2eAgentMs: roleTotals.e2e,
		deterministicMs,
		harnessSchedulingMs,
		implementationMs: categories.totals.implementation,
		integrationMs: categories.totals.integration,
		verificationMs: categories.totals.verification,
		reviewMs: categories.totals.review,
		e2eMs: categories.totals.e2e,
		orchestrationMs,
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
			...(timing.runningOpen && categories.activeCategory ? { activeCategory: categories.activeCategory } : {}),
			activeAgents: attempts.filter(({ agent, attempt }) => processIntervalIsOpen(attempt, agent)).length,
			activeVerifications,
			activeImplementers: activeRoles.implementer,
			activeReviewers: activeRoles.reviewer,
			activeFixers: activeRoles.fixer,
			activeE2e: activeRoles.e2e,
			activeScheduling,
			orchestrator: orchestratorOpen,
		},
	};
}
