import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import styledOutputs from "../index.js";
import { getSubagentUiProjectionRegistry } from "../../../subagent/ui-projection.js";

function theme(): any {
	return new Proxy({}, {
		get(_target, property) {
			if (property === "fg" || property === "bg") return (_color: string, text: string) => text;
			if (["bold", "italic", "strikethrough"].includes(String(property))) return (text: string) => text;
			return undefined;
		},
	});
}

function assistant(content: any[]): any {
	return {
		role: "assistant",
		content,
		provider: "test",
		model: "test",
		api: "test",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function install(requestRender: () => void = () => undefined): Map<string, (...args: any[]) => any> {
	const handlers = new Map<string, (...args: any[]) => any>();
	styledOutputs({
		registerTool() {},
		registerMarkdownTransformer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
	} as any);
	handlers.get("session_start")?.({}, { mode: "tui", ui: { theme: theme(), requestRender } });
	return handlers;
}

function isSpacer(component: any): boolean {
	return component?.constructor?.name === "Spacer";
}

function leadingRows(component: any): number {
	const leading = component.children?.[0];
	assert.ok(isSpacer(leading));
	return leading.render(80).length;
}

const toolDefinition = {
	name: "spacing_test",
	label: "Spacing test",
	description: "Test-only renderer",
	parameters: {},
	renderShell: "self",
	renderCall: () => ({ render: () => ["call"], invalidate() {} }),
	async execute() { return { content: [{ type: "text", text: "ok" }] }; },
} as any;

function tool(id: string, requestRender: () => void = () => undefined): ToolExecutionComponent {
	return new ToolExecutionComponent("spacing_test", id, {}, {}, toolDefinition, { requestRender } as any, process.cwd());
}

test("surviving tool components dereference the newest harness renderer after reload", () => {
	install();
	const definition = {
		...toolDefinition,
		name: "subagent_status",
		label: "Subagent status",
	} as any;
	const component = new ToolExecutionComponent("subagent_status", "reload-renderer", {}, {}, definition, { requestRender() {} } as any, process.cwd());
	assert.match(component.render(120).join("\n"), /Inspect subagents/);
	const state = (globalThis as any)[Symbol.for("pibox:styled-outputs:state")];
	const prior = state.harnessCallRenderer;
	try {
		state.harnessCallRenderer = () => ({ render: () => ["latest renderer"], invalidate() {} });
		assert.match(component.render(120).join("\n"), /latest renderer/, "the existing component does not retain the pre-reload module closure");
	} finally {
		state.harnessCallRenderer = prior;
	}
});

test("styled transcript rendering owns projection invalidation without the footer", () => {
	const registry = getSubagentUiProjectionRegistry();
	registry.clear();
	let renders = 0;
	const requestRender = () => { renders++; };
	const handlers = install(requestRender);
	tool("projection-invalidation", requestRender);
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const binding = registry.bind(owner, "styled-output-test");
	binding.publish([]);
	assert.equal(renders, 2, "bind and publish each invalidate transcript projections");
	handlers.get("session_shutdown")?.({ reason: "quit" }, {});
	binding.publish([]);
	assert.equal(renders, 2, "session shutdown releases the transcript projection subscription");
	binding.release();
});

test("top-level messages own one leading boundary while sibling tool calls stay compact", () => {
	install();

	const user = new UserMessageComponent("Please inspect this");
	assert.equal(isSpacer(user.children.at(-1)), false, "user messages do not add a trailing boundary that can double the next block");

	const reply = new AssistantMessageComponent(assistant([{ type: "text", text: "Finished" }]));
	assert.equal(leadingRows((reply as any).contentContainer), 1, "assistant text starts on a fresh terminal row");

	new AssistantMessageComponent(assistant([{ type: "toolCall", id: "one", name: "spacing_test", arguments: {} }]));
	const firstTool = tool("one");
	const siblingTool = tool("two");
	assert.equal(leadingRows(firstTool), 1, "a tool-only assistant request gets one starter row");
	assert.equal(leadingRows(siblingTool), 0, "sibling calls remain a compact tool sequence");

	new AssistantMessageComponent(assistant([
		{ type: "text", text: "I will inspect it." },
		{ type: "toolCall", id: "three", name: "spacing_test", arguments: {} },
	]));
	const inlineTool = tool("three");
	assert.equal(leadingRows(inlineTool), 0, "a tool following text in the same assistant message does not create an internal gap");
});
