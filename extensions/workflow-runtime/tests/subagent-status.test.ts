import assert from "node:assert/strict";
import test from "node:test";
import { projectSubagentStatus, subagentStatusEmptyText } from "../subagent-status.js";

function agent(id: string, state: string, updatedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		role: "implementer",
		state,
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		effort: "max",
		updatedAt,
		...extra,
	};
}

test("default status returns actionable agents with attention first and newest first", () => {
	const settledHistory = Array.from({ length: 15 }, (_, index) => agent(
		`completed-${index}`,
		"completed",
		`2025-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
	));
	const agents = [
		...settledHistory,
		agent("running-newest", "running", "2025-02-05T00:00:00.000Z"),
		agent("failed", "failed", "2025-02-04T00:00:00.000Z", { error: "Needs recovery" }),
		agent("completed-with-message", "completed", "2025-02-03T00:00:00.000Z"),
		agent("paused", "paused", "2025-02-02T00:00:00.000Z"),
		agent("running-older", "running", "2025-02-01T00:00:00.000Z"),
		agent("cancelled", "cancelled", "2025-02-06T00:00:00.000Z"),
	];
	const messages = [{
		id: "decision", agentId: "completed-with-message", status: "open", type: "change_request",
		summary: "Choose a recovery path", updatedAt: "2025-02-06T00:00:00.000Z",
	}];

	const projected = projectSubagentStatus(agents, messages);

	assert.deepEqual(projected.agents.map((record) => record.id), ["failed", "completed-with-message", "paused", "running-newest", "running-older"]);
	assert.equal(projected.agents.find((record) => record.id === "completed-with-message")?.openMessageCount, 1);
	assert.deepEqual(projected.openMessages.map((message) => message.id), ["decision"]);
	assert.equal(projected.counts.agents, agents.length);
	assert.equal(projected.counts.actionableAgents, 5);
	assert.equal(projected.counts.settledAgents, 18);
	assert.equal(projected.page.hasMoreAgents, false);
});

test("settled history is bounded, newest first, and projects only current-attempt diagnostics", () => {
	const longSummary = `  ${"summary ".repeat(50)}\nprivate tail`;
	const records = [
		agent("older", "completed", "2025-03-01T00:00:00.000Z"),
		agent("newest", "protocol_failed", "2025-03-03T00:00:00.000Z", {
			role: "reviewer\nwith whitespace",
			provider: "stale-provider",
			model: "stale-model",
			effort: "low",
			workItemId: "example",
			currentAttemptId: "attempt-current",
			attempts: [
				{ id: "attempt-old", provider: "old-provider", model: "old-model", effort: "low", progress: { turns: 99, toolCalls: 99, toolErrors: 99, outputTokens: 99, reasoningTokens: 99 } },
				{
					id: "attempt-current", provider: "ollama-cloud", model: "deepseek-v4-pro", effort: "high", fast: true,
					progress: {
						startedAt: "2025-03-03T00:00:00.000Z", lastEventAt: "2025-03-03T00:01:00.000Z",
						turns: 4, toolCalls: 7, toolErrors: 1, outputTokens: 1200, reasoningTokens: 300,
						contextTokens: 9000, activeTool: "bash $(private)", privateText: "must not leak",
					},
				},
			],
			summary: longSummary,
			error: `${"failure ".repeat(50)}secret`,
			assignmentPath: "/private/assignment.json",
			operationId: "private-operation",
		}),
		agent("middle", "completed", "2025-03-02T00:00:00.000Z"),
	];

	const projected = projectSubagentStatus(records, [], { includeSettled: true, limit: 2 });

	assert.deepEqual(projected.agents.map((record) => record.id), ["newest", "middle"]);
	assert.equal(projected.page.hasMoreAgents, true);
	assert.equal(projected.agents[0]?.role, "reviewer with whitespace");
	assert.deepEqual(
		{
			provider: projected.agents[0]?.provider,
			model: projected.agents[0]?.model,
			effort: projected.agents[0]?.effort,
			fast: projected.agents[0]?.fast,
			workflowRef: projected.agents[0]?.workflowRef,
		},
		{ provider: "ollama-cloud", model: "deepseek-v4-pro", effort: "high", fast: true, workflowRef: "work-item:example" },
	);
	assert.deepEqual(projected.agents[0]?.progress, {
		startedAt: "2025-03-03T00:00:00.000Z",
		lastEventAt: "2025-03-03T00:01:00.000Z",
		turns: 4,
		toolCalls: 7,
		toolErrors: 1,
		outputTokens: 1200,
		reasoningTokens: 300,
		contextTokens: 9000,
		activeTool: "bashprivate",
	});
	assert.equal(projected.agents[0]?.summary?.length, 240);
	assert.equal(projected.agents[0]?.error?.length, 240);
	const serialized = JSON.stringify(projected);
	for (const privateValue of ["attempt-old", "privateText", "/private/assignment.json", "private-operation", "must not leak"]) {
		assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("agent, workflow, and state filters narrow agents and their open messages", () => {
	const agents = [
		agent("target", "waiting_decision", "2025-04-03T00:00:00.000Z", { workItemId: "example" }),
		agent("same-workflow", "running", "2025-04-02T00:00:00.000Z", { workItemId: "example" }),
		agent("other", "waiting_decision", "2025-04-01T00:00:00.000Z", { workItemId: "other" }),
	];
	const messages = [
		{ id: "target-message", agentId: "target", status: "open", updatedAt: "2025-04-04T00:00:00.000Z" },
		{ id: "same-workflow-message", agentId: "same-workflow", status: "open", updatedAt: "2025-04-03T00:00:00.000Z" },
		{ id: "closed", agentId: "target", status: "closed", updatedAt: "2025-04-05T00:00:00.000Z" },
	];

	const projected = projectSubagentStatus(agents, messages, {
		agentId: "target",
		workflowRef: "work-item:example",
		state: "waiting_decision",
		limit: 1,
	});

	assert.deepEqual(projected.agents.map((record) => record.id), ["target"]);
	assert.deepEqual(projected.openMessages.map((message) => message.id), ["target-message"]);
	assert.equal(projected.openMessages[0]?.workflowRef, "work-item:example");
});

test("empty status explains how to inspect settled history without suggesting polling", () => {
	const done = agent("done", "completed", "2025-05-01T00:00:00.000Z");
	const payload = projectSubagentStatus([done], []);
	assert.equal(subagentStatusEmptyText(payload), "No actionable subagents. Use includeSettled: true to inspect settled history.");
	const stateFiltered = projectSubagentStatus([done], [], { state: "completed" });
	assert.deepEqual(stateFiltered.agents, []);
	assert.equal(subagentStatusEmptyText(stateFiltered, { state: "completed" }), "No actionable subagents. Use includeSettled: true to inspect settled history.");
	assert.equal(subagentStatusEmptyText(projectSubagentStatus([], [], { agentId: "missing" }), { agentId: "missing" }), "No subagents match the requested filters.");
});
