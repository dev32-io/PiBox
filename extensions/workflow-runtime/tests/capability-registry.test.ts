import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowAdapter } from "../api.js";
import { WORKFLOW_ADAPTER_PROTOCOL_VERSION, WorkflowAdapterCapabilityRegistry, getWorkflowAdapterCapabilityRegistry, registerWorkflowAdapter } from "../capability-registry.js";

function adapter(id: string, prefix = `${id}:`): WorkflowAdapter {
	return {
		id,
		canHandle: (ref) => ref.startsWith(prefix),
		async controlExecution(ref, command) { return { workflowRef: ref, mode: command === "pause" || command === "detach" ? "paused" : command === "stop" ? "stopped" : command === "complete" ? "completed" : "running", generation: 1 }; },
		async snapshot(ref) { return { ref, title: id, status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "done" }; },
		async controlWorkflow() {},
	};
}

test("explicit workflow capabilities are versioned and resolvable across load order", () => {
	const registry = new WorkflowAdapterCapabilityRegistry();
	assert.equal(registry.resolve("late:item"), undefined);
	const registration = registry.register({ protocolVersion: WORKFLOW_ADAPTER_PROTOCOL_VERSION, adapter: adapter("late") });
	assert.equal(registry.resolve("late:item")?.id, "late");
	assert.throws(() => registry.resolve("late:item", 2), /Unsupported workflow adapter protocol version/);
	assert.equal(registration.unregister(), true);
	assert.equal(registry.resolve("late:item"), undefined);
});

test("replacement registration fences stale reload cleanup", () => {
	const registry = new WorkflowAdapterCapabilityRegistry();
	const first = registry.register({ protocolVersion: WORKFLOW_ADAPTER_PROTOCOL_VERSION, adapter: adapter("workflow") });
	const replacementAdapter = adapter("workflow", "replacement:");
	const replacement = registry.register({ protocolVersion: WORKFLOW_ADAPTER_PROTOCOL_VERSION, adapter: replacementAdapter }, { replace: true });
	assert.equal(first.unregister(), false, "an old extension instance cannot remove its replacement");
	assert.equal(registry.resolve("replacement:item"), replacementAdapter);
	assert.equal(replacement.unregister(), true);
});

test("process-global lookup survives module consumers and stale registrations cleanly unregister", () => {
	const registry = getWorkflowAdapterCapabilityRegistry();
	registry.clear();
	const registered = registerWorkflowAdapter(adapter("global"), { replace: true });
	assert.equal(getWorkflowAdapterCapabilityRegistry().resolve("global:item")?.id, "global");
	assert.equal(registered.unregister(), true);
	assert.equal(getWorkflowAdapterCapabilityRegistry().resolve("global:item"), undefined);
});
