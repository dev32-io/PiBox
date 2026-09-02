import assert from "node:assert/strict";
import test from "node:test";
import { SubagentUiProjectionRegistry, type SubagentUiAgentProjection } from "../ui-projection.js";

const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };

function agent(
	agentId: string,
	startedAt: string,
	presentation: "foreground" | "background" = "background",
	state: SubagentUiAgentProjection["state"] = "running",
	workflow?: SubagentUiAgentProjection["workflow"],
): SubagentUiAgentProjection {
	return { agentId, agent: agentId, state, presentation, provider: "provider", model: "model", effort: "medium", fast: false, startedAt, updatedAt: startedAt, ...(workflow ? { workflow } : {}) };
}

test("process-global projection bindings sort stably, bound rows, report overflow, and notify on events", () => {
	const registry = new SubagentUiProjectionRegistry();
	let renders = 0;
	const unsubscribe = registry.subscribe(() => { renders++; });
	const binding = registry.bind(owner, "binding");
	binding.publish([
		agent("later", "2026-01-01T00:00:02Z"),
		agent("same-b", "2026-01-01T00:00:01Z"),
		agent("same-a", "2026-01-01T00:00:01Z"),
		agent("foreground", "2026-01-01T00:00:00Z", "foreground"),
		agent("workflow-active", "2026-01-01T00:00:00Z", "background", "running", { storyId: "story-one", slotId: "task:one", action: "task-launch", taskId: "one" }),
		agent("other-workflow", "2026-01-01T00:00:00Z", "foreground", "running", { storyId: "story-two", slotId: "final-review" }),
		agent("workflow-settled", "2026-01-01T00:00:00Z", "background", "completed", { storyId: "story-one", slotId: "task:done" }),
		agent("settled", "2026-01-01T00:00:00Z", "background", "completed"),
	]);
	assert.deepEqual(registry.project(2)?.agents.map((value) => value.agentId), ["same-a", "same-b"], "the generic footer keeps only standalone background children");
	assert.equal(registry.project(2)?.overflow, 1, "workflow children do not consume footer rows or overflow");
	const workflow = registry.projectWorkflow("story-one");
	assert.deepEqual(workflow?.agents.map((value) => value.agentId), ["workflow-active"]);
	assert.deepEqual(workflow?.agents[0]?.workflow, { storyId: "story-one", slotId: "task:one", action: "task-launch", taskId: "one" });
	assert.deepEqual(registry.projectWorkflow("story-two")?.agents.map((value) => value.agentId), ["other-workflow"], "workflow projection is presentation-independent");
	assert.equal(registry.lookup({ owner, agentId: "workflow-settled" })?.state, "completed", "terminal workflow rows remain available to activation-scoped transcript consumers");
	assert.equal(registry.lookup({ owner, agentId: "settled" })?.state, "completed", "terminal rows remain available to activation-scoped transcript consumers");
	assert.equal(registry.lookup({ owner: { ...owner, activationId: "replacement" }, agentId: "settled" }), undefined, "another activation cannot adopt the transcript projection");
	assert.equal(registry.lookup({ owner, agentId: "missing" }), undefined);
	assert.equal(renders, 2, "binding and semantic event publication each request a render");
	unsubscribe();
	binding.release();
});

test("a replacement binding fences stale projection publication and release", () => {
	const registry = new SubagentUiProjectionRegistry();
	const old = registry.bind(owner, "old");
	old.publish([agent("old-agent", "2026-01-01T00:00:00Z")]);
	const replacement = registry.bind(owner, "replacement");
	assert.equal(old.publish([agent("stale", "2026-01-01T00:00:00Z")]), false);
	assert.equal(old.release(), false);
	replacement.publish([agent("current", "2026-01-01T00:00:00Z")]);
	assert.deepEqual(registry.project()?.agents.map((value) => value.agentId), ["current"]);
});
