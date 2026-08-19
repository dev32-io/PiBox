import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowMetrics } from "../workflow-metrics.js";

const at = (seconds: number): string => new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1_000).toISOString();

function event(sequence: number, type: string, seconds: number): any {
	return { id: `repo:${sequence}`, repositoryId: "repo", sequence, type, at: at(seconds), workItemId: "example", ownerGeneration: 1, correlationId: `event-${sequence}` };
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
		verificationMs: 18_000,
		fixes: 2,
		retries: 2,
		agentCount: 2,
		verificationAttempts: 3,
		inputTokens: 400,
		outputTokens: 650,
		toolErrors: 3,
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
});
