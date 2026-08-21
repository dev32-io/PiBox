import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowMetrics } from "../workflow-metrics.js";

const at = (seconds: number): string => new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1_000).toISOString();

function event(sequence: number, type: string, seconds: number, extra: Record<string, unknown> = {}): any {
	return { id: `repo:${sequence}`, repositoryId: "repo", sequence, type, at: at(seconds), workItemId: "example", ownerGeneration: 1, correlationId: `event-${sequence}`, ...extra };
}

function attempt(id: string, started: number, exited: number, extra: Record<string, unknown> = {}): any {
	return { id, sequence: Number(id.replace(/\D/g, "")) || 1, state: "exited", startedAt: at(started), updatedAt: at(exited), exitedAt: at(exited), ...extra };
}

test("projects pause/resume wall time, concurrent agent sums, repair generations, retries, and verification durations", () => {
	const workflowEvents = [
		event(1, "workflow.started", 0),
		event(2, "workflow.paused", 10),
		event(3, "workflow.resumed", 20),
		event(4, "workflow.stopped", 50),
	];
	const agents: any[] = [
		{
			id: "fixer", workItemId: "example", evaluationId: "review", attempts: [
				attempt("a1", 1, 11, { activity: { kind: "repair", generation: 1 }, progress: { processStartedAt: at(1), processExitedAt: at(11), inputTokens: 100, outputTokens: 200, toolErrors: 1 } }),
				attempt("a2", 12, 22, { activity: { kind: "repair", generation: 1 }, progress: { inputTokens: 0, outputTokens: 50, toolErrors: 0 } }),
			],
		},
		{
			id: "fixer-2", workItemId: "example", evaluationId: "review", attempts: [
				attempt("b1", 5, 25, { activity: { kind: "repair", generation: 2 }, progress: { processStartedAt: at(5), processExitedAt: at(25), inputTokens: 300, outputTokens: 400, toolErrors: 2 } }),
			],
		},
		{ id: "other-workflow", workItemId: "other", attempts: [attempt("c1", 0, 100)] },
	];
	const verificationAttempts: any[] = [
		{ id: "001", workItemId: "example", stageId: "delivery", checkId: "unit", state: "passed", startedAt: at(2), completedAt: at(7) },
		{ id: "002", workItemId: "example", stageId: "delivery", checkId: "unit", state: "passed", startedAt: at(30), completedAt: at(40) },
		{ id: "001", workItemId: "example", stageId: "delivery", checkId: "lint", state: "failed", startedAt: at(6), completedAt: at(9) },
		{ id: "001", workItemId: "other", stageId: "delivery", checkId: "unit", state: "passed", startedAt: at(0), completedAt: at(100) },
	];

	assert.deepEqual(projectWorkflowMetrics({ workItemId: "example", workflowEvents, agents, verificationAttempts, now: Date.parse(at(100)) }), {
		elapsedMs: 50_000,
		runningMs: 40_000,
		agentActiveMs: 40_000,
		implementerMs: 0,
		reviewerMs: 0,
		fixerMs: 40_000,
		e2eAgentMs: 0,
		deterministicMs: 18_000,
		harnessSchedulingMs: 0,
		implementationMs: 0,
		integrationMs: 7_000,
		verificationMs: 17_000,
		reviewMs: 0,
		e2eMs: 0,
		orchestrationMs: 16_000,
		fixes: 2,
		retries: 2,
		agentCount: 2,
		verificationAttempts: 3,
		inputTokens: 400,
		outputTokens: 650,
		toolErrors: 3,
		live: { sampledAtMs: Date.parse(at(100)), elapsed: false, running: false, activeAgents: 0, activeVerifications: 0, activeImplementers: 0, activeReviewers: 0, activeFixers: 0, activeE2e: 0, activeScheduling: 0, orchestrator: false },
	});
});

test("uses durable legacy attempt timestamps and safely defaults historical input usage", () => {
	const metrics = projectWorkflowMetrics({
		workItemId: "example",
		workflowEvents: [event(1, "workflow.started", 0), event(2, "workflow.completed", 40)],
		agents: [{
			id: "legacy", workItemId: "example", attempts: [{
				id: "attempt", sequence: 1, state: "exited", startedAt: at(10), updatedAt: at(30), exitedAt: at(30),
				progress: { startedAt: at(10), lastEventAt: at(30), turns: 1, toolCalls: 2, toolErrors: 1, outputTokens: 250, reasoningTokens: 10 },
			}],
		} as any],
		verificationAttempts: [{ id: "001", workItemId: "example", stageId: "delivery", checkId: "legacy", state: "failed", startedAt: at(12) }],
		now: Date.parse(at(100)),
	});

	assert.equal(metrics.elapsedMs, 40_000, "terminal control time freezes elapsed duration");
	assert.equal(metrics.agentActiveMs, 20_000);
	assert.equal(metrics.inputTokens, 0);
	assert.equal(metrics.outputTokens, 250);
	assert.equal(metrics.verificationMs, 0, "terminal legacy attempts without a completion timestamp are not treated as still running");
	assert.equal(metrics.orchestrationMs, 20_000, "orchestrator residual excludes known legacy process runtime");
});

test("unions duplicate durable running transitions and keeps pause decision time out of running time", () => {
	const metrics = projectWorkflowMetrics({
		workItemId: "example",
		workflowEvents: [
			event(1, "workflow.started", 0), event(2, "workflow.started", 2), event(3, "workflow.paused", 10),
			event(4, "workflow.resumed", 20), event(5, "workflow.resumed", 22),
		],
		agents: [], verificationAttempts: [], now: Date.parse(at(50)),
	});
	assert.equal(metrics.elapsedMs, 50_000);
	assert.equal(metrics.runningMs, 40_000);
	assert.deepEqual(metrics.live, { sampledAtMs: Date.parse(at(50)), elapsed: true, running: true, activeCategory: "orchestration", activeAgents: 0, activeVerifications: 0, activeImplementers: 0, activeReviewers: 0, activeFixers: 0, activeE2e: 0, activeScheduling: 0, orchestrator: true });
});

test("publishes open interval rates for read-free live projection", () => {
	const metrics = projectWorkflowMetrics({
		workItemId: "example",
		workflowEvents: [event(1, "workflow.started", 0)],
		agents: [{
			id: "worker", role: "implementer", workItemId: "example", taskId: "task", state: "running", attempts: [{
				id: "attempt", sequence: 1, state: "running", startedAt: at(10), updatedAt: at(10),
				progress: { processStartedAt: at(10) },
			}],
		} as any],
		verificationAttempts: [{ id: "001", workItemId: "example", stageId: "delivery", checkId: "unit", state: "running", startedAt: at(20) }],
		now: Date.parse(at(50)),
	});

	assert.equal(metrics.agentActiveMs, 40_000);
	assert.equal(metrics.implementationMs, 10_000);
	assert.equal(metrics.verificationMs, 30_000);
	assert.equal(metrics.orchestrationMs, 10_000);
	assert.equal((metrics.implementationMs ?? 0) + metrics.verificationMs + (metrics.orchestrationMs ?? 0), metrics.runningMs, "exclusive phases add up to active workflow time");
	assert.equal(metrics.implementerMs, 40_000);
	assert.equal(metrics.deterministicMs, 30_000);
	assert.equal(metrics.harnessSchedulingMs, 0);
	assert.deepEqual(metrics.live, { sampledAtMs: Date.parse(at(50)), elapsed: true, running: true, activeCategory: "verification", activeAgents: 1, activeVerifications: 1, activeImplementers: 1, activeReviewers: 0, activeFixers: 0, activeE2e: 0, activeScheduling: 0, orchestrator: false });
});

test("stops active workflow time on detach and resumes it only after a running attach", () => {
	const metrics = projectWorkflowMetrics({
		workItemId: "example",
		workflowEvents: [
			event(1, "workflow.started", 0),
			event(2, "workflow.detached", 10, { transition: { from: "running", to: "running" } }),
			event(3, "workflow.attached", 30, { transition: { from: "running", to: "running" } }),
			event(4, "workflow.paused", 50),
		],
		agents: [{ id: "worker", role: "implementer", workItemId: "example", taskId: "task", attempts: [attempt("a1", 0, 50)] }] as any[],
		verificationAttempts: [],
		now: Date.parse(at(100)),
	});
	assert.equal(metrics.runningMs, 30_000);
	assert.equal(metrics.implementationMs, 30_000);
	assert.equal(metrics.implementerMs, 50_000);
	assert.equal(metrics.live?.running, false);
});

test("tracks launch-to-ready scheduling and detailed role sums without sampling writes", () => {
	const metrics = projectWorkflowMetrics({
		workItemId: "example",
		workflowEvents: [event(1, "workflow.started", 0), event(2, "workflow.completed", 20)],
		agents: [{
			id: "worker", role: "implementer", workItemId: "example", taskId: "task", attempts: [{
				...attempt("a1", 2, 10),
				timing: { reservedAt: at(1), attemptStartedAt: at(2), processSpawnedAt: at(3), childReadyAt: at(5), firstActivityAt: at(5), processExitedAt: at(10), outputDrainedAt: at(11), settledAt: at(11) },
			}],
		}] as any[],
		verificationAttempts: [], now: Date.parse(at(100)),
	});
	assert.equal(metrics.implementerMs, 7_000);
	assert.equal(metrics.harnessSchedulingMs, 3_000);
	assert.equal(metrics.orchestrationMs, 13_000);
});

test("keeps launch startup out of process time and closes legacy attempts with terminal logical state", () => {
	const launching = projectWorkflowMetrics({
		workItemId: "example", workflowEvents: [event(1, "workflow.started", 0)],
		agents: [{ id: "starting", role: "implementer", state: "launching", workItemId: "example", taskId: "task", attempts: [{ id: "a", sequence: 1, state: "launching", startedAt: at(10), updatedAt: at(10), timing: { attemptStartedAt: at(10) } }] }] as any[],
		verificationAttempts: [], now: Date.parse(at(20)),
	});
	assert.equal(launching.implementerMs, 0);
	assert.equal(launching.harnessSchedulingMs, 10_000);
	assert.equal(launching.live?.activeImplementers, 0);
	assert.equal(launching.live?.activeScheduling, 1);

	const terminal = projectWorkflowMetrics({
		workItemId: "example", workflowEvents: [event(1, "workflow.started", 0), event(2, "workflow.completed", 30)],
		agents: [{ id: "legacy", role: "implementer", state: "failed", completedAt: at(20), updatedAt: at(20), workItemId: "example", taskId: "task", attempts: [{ id: "a", sequence: 1, state: "running", startedAt: at(5), updatedAt: at(20) }] }] as any[],
		verificationAttempts: [], now: Date.parse(at(100)),
	});
	assert.equal(terminal.implementerMs, 15_000);
	assert.equal(terminal.live?.activeAgents, 0);
});

test("tracks review and E2E as separate clock-speed phases", () => {
	const workflowEvents = [
		event(1, "workflow.started", 0),
		event(2, "step.started", 50, { correlationId: "integration", metricCategory: "integration" }),
		event(3, "step.settled", 60, { correlationId: "integration", metricCategory: "integration" }),
		event(4, "workflow.completed", 60),
	];
	const agents = [
		{ id: "worker", role: "implementer", workItemId: "example", taskId: "task", attempts: [attempt("a1", 0, 10)] },
		{ id: "reviewer", role: "code-reviewer", workItemId: "example", evaluationId: "review", attempts: [attempt("a2", 10, 30)] },
		{ id: "e2e", role: "e2e-tester", workItemId: "example", evaluationId: "e2e", attempts: [attempt("a3", 30, 50)] },
	] as any[];
	const metrics = projectWorkflowMetrics({ workItemId: "example", workflowEvents, agents, verificationAttempts: [], now: Date.parse(at(100)) });
	assert.equal(metrics.implementationMs, 10_000);
	assert.equal(metrics.reviewMs, 20_000);
	assert.equal(metrics.e2eMs, 20_000);
	assert.equal(metrics.integrationMs, 10_000);
	assert.equal(metrics.implementerMs, 10_000);
	assert.equal(metrics.reviewerMs, 20_000);
	assert.equal(metrics.e2eAgentMs, 20_000);
	assert.equal(metrics.orchestrationMs, 10_000, "deterministic integration work without a child remains orchestrator residual");
	assert.equal((metrics.implementationMs ?? 0) + (metrics.integrationMs ?? 0) + (metrics.reviewMs ?? 0) + (metrics.e2eMs ?? 0), metrics.runningMs);
});
