import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import statusBar from "../index.js";
import { SUBAGENT_ANIMATION_INTERVAL_MS } from "../../../subagent/display.js";
import { getSubagentUiProjectionRegistry, type SubagentUiAgentProjection } from "../../../subagent/ui-projection.js";

const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
const startedAt = "2026-01-01T00:00:00.000Z";

function standalone(updatedAt = startedAt): SubagentUiAgentProjection {
	return {
		agentId: "standalone",
		agent: "general-purpose",
		state: "running",
		presentation: "background",
		provider: "provider",
		model: "model",
		effort: "medium",
		tier: "medium",
		fast: false,
		startedAt,
		updatedAt,
	};
}

function workflow(updatedAt = startedAt): SubagentUiAgentProjection {
	return {
		agentId: "workflow",
		agent: "implementer",
		state: "running",
		presentation: "background",
		provider: "provider",
		model: "model",
		effort: "high",
		tier: "high",
		fast: false,
		startedAt,
		updatedAt,
		workflow: { storyId: "story", slotId: "task:one", action: "task-launch", taskId: "one" },
	};
}

test("workflow-only projection events do not invalidate or animate the standalone footer", { concurrency: false }, async (t) => {
	const registry = getSubagentUiProjectionRegistry();
	registry.clear();
	const binding = registry.bind(owner, "status-bar-events");
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	let renderRequests = 0;
	let footer: { dispose(): void } | undefined;
	const tui = { requestRender() { renderRequests++; } };
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		async exec() { return { stdout: "", stderr: "", code: 1, killed: false }; },
		getThinkingLevel() { return "medium"; },
	} as unknown as ExtensionAPI;
	const ctx: any = {
		mode: "tui",
		cwd: process.cwd(),
		ui: {
			setFooter(factory: (tui: unknown, theme: unknown, data: unknown) => { dispose(): void }) {
				footer = factory(tui, { fg: (_tone: string, text: string) => text }, {
					getExtensionStatuses: () => new Map(),
					onBranchChange: () => () => undefined,
				});
			},
			onTerminalInput: () => () => undefined,
		},
	};
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	statusBar(pi);
	await fire("session_start", { reason: "startup" });
	t.after(async () => {
		await fire("session_shutdown", { reason: "quit" });
		footer?.dispose();
		binding.release();
		registry.clear();
	});

	binding.publish([workflow()]);
	assert.equal(renderRequests, 0, "workflow activity belongs only to the workflow widget");

	binding.publish([standalone(), workflow()]);
	assert.equal(renderRequests, 1, "a new standalone row invalidates the footer");
	binding.publish([standalone(), workflow("2026-01-01T00:00:01.000Z")]);
	assert.equal(renderRequests, 1, "workflow progress cannot invalidate an unchanged standalone projection");

	await new Promise((resolve) => setTimeout(resolve, SUBAGENT_ANIMATION_INTERVAL_MS + 25));
	assert.ok(renderRequests > 1, "standalone rows retain footer animation");
	binding.publish([standalone("2026-01-01T00:00:02.000Z"), workflow("2026-01-01T00:00:01.000Z")]);
	const afterStandaloneProgress = renderRequests;
	binding.publish([workflow("2026-01-01T00:00:03.000Z")]);
	assert.equal(renderRequests, afterStandaloneProgress + 1, "removing the standalone row invalidates once and stops its animation");
	const afterRemoval = renderRequests;
	await new Promise((resolve) => setTimeout(resolve, SUBAGENT_ANIMATION_INTERVAL_MS + 25));
	assert.equal(renderRequests, afterRemoval, "workflow-only rows do not keep the footer animation alive");
});
