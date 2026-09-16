import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
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

function install(requestRender: () => void = () => undefined, tools = new Map<string, any>()): Map<string, (...args: any[]) => any> {
	const handlers = new Map<string, (...args: any[]) => any>();
	styledOutputs({
		registerTool(definition: any) { tools.set(definition.name, definition); },
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

test("completed writes defer one metadata invalidation without duplicating their result", async () => {
	initTheme("dark", false);
	const definitions = new Map<string, any>();
	install(undefined, definitions);
	for (const [action, before, after] of [["create", "", "created\n"], ["rewrite", "old\n", "new\n"]] as const) {
		let renders = 0;
		const component = new ToolExecutionComponent("write", action, { path: `/tmp/${action}.txt`, content: after }, {}, definitions.get("write"), { requestRender() { renders++; } } as any, process.cwd());
		component.updateResult({
			content: [{ type: "text", text: `Wrote /tmp/${action}.txt` }],
			details: { piboxWrite: { action, diff: generateDiffString(before, after).diff } },
			isError: false,
		});
		const initial = component.render(120).map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
		assert.match(initial, /✓ Write /);
		assert.equal(initial.match(/└─ Done/g)?.length, 1);
		assert.equal(renders, 0, "renderer does not invalidate during composition");

		await Promise.resolve();
		const settled = component.render(120).map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
		assert.match(settled, new RegExp(`✓ ${action === "create" ? "Create" : "Rewrite"} `));
		assert.equal(settled.match(/└─ Done/g)?.length, 1);
		assert.equal(renders, 1, "metadata transition invalidates exactly once");
	}
});

test("composed tool families share three-column semantic indentation", () => {
	initTheme("dark", false);
	const definitions = new Map<string, any>();
	install(undefined, definitions);
	const rows = (component: ToolExecutionComponent) => component.render(120)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.filter((line) => line.length > 0);
	const assertIndent = (rendered: string[], text: string, indent: number) => {
		const line = rendered.find((candidate) => candidate.trimStart().startsWith(text));
		assert.ok(line, `missing row: ${text}`);
		assert.equal(line.match(/^ */)?.[0].length, indent, line);
	};

	const builtIn = new ToolExecutionComponent("bash", "built-in", { command: "echo output" }, {}, definitions.get("bash"), { requestRender() {} } as any, process.cwd());
	builtIn.updateResult({ content: [{ type: "text", text: "output\n  nested" }], isError: false });
	const builtInRows = rows(builtIn);
	assertIndent(builtInRows, "✓ Bash", 3);
	assertIndent(builtInRows, "└─ Done", 3);
	assertIndent(builtInRows, "output", 6);
	assertIndent(builtInRows, "nested", 8);

	const harness = new ToolExecutionComponent("resource_list", "harness", {}, {}, { ...toolDefinition, name: "resource_list", renderShell: "default" }, { requestRender() {} } as any, process.cwd());
	harness.updateResult({ content: [{ type: "text", text: JSON.stringify({ resources: [{ ref: "story:test", state: "active" }] }) }], isError: false });
	const harnessRows = rows(harness);
	assertIndent(harnessRows, "✓ List resources", 3);
	assertIndent(harnessRows, "└─ Done", 3);
	assertIndent(harnessRows, "└─ story:test", 6);

	const harnessProse = new ToolExecutionComponent("workflow_status", "harness-prose", {}, {}, { ...toolDefinition, name: "workflow_status", renderShell: "default" }, { requestRender() {} } as any, process.cwd());
	harnessProse.updateResult({ content: [{ type: "text", text: "plain\n  nested" }], isError: false });
	const harnessProseRows = rows(harnessProse);
	assertIndent(harnessProseRows, "plain", 6);
	assertIndent(harnessProseRows, "nested", 8);

	const harnessDiff = new ToolExecutionComponent("task_write", "harness-diff", {}, {}, { ...toolDefinition, name: "task_write", renderShell: "default" }, { requestRender() {} } as any, process.cwd());
	harnessDiff.updateResult({ content: [{ type: "text", text: "updated" }], details: { piboxResourceDiff: { action: "update", ref: "task:test", diff: generateDiffString("old\n", "new\n").diff } }, isError: false });
	const harnessDiffRows = rows(harnessDiff);
	assertIndent(harnessDiffRows, "-1 old", 6);
	assertIndent(harnessDiffRows, "+1 new", 6);

	const subagent = new ToolExecutionComponent("subagent_spawn", "subagent", { agent: "investigator", mode: "foreground", task: "Inspect" }, {}, { ...toolDefinition, name: "subagent_spawn", renderShell: "default" }, { requestRender() {} } as any, process.cwd());
	subagent.updateResult({ content: [{ type: "text", text: "Report\n  proof" }], details: { agent: "investigator", terminal: { status: "completed" } }, isError: false });
	const subagentRows = rows(subagent);
	assertIndent(subagentRows, "✓ investigator", 3);
	assertIndent(subagentRows, "└─ Done", 3);
	assertIndent(subagentRows, "Prompt:", 6);
	assertIndent(subagentRows, "Inspect", 9);
	assertIndent(subagentRows, "Result:", 6);
	assertIndent(subagentRows, "Report", 9);
	assertIndent(subagentRows, "proof", 11);

	for (const renderShell of ["default", "self"] as const) {
		const definition = {
			...toolDefinition,
			renderShell,
			renderCall: () => ({ render: () => ["call", "call continuation"], invalidate() {} }),
			renderResult: () => ({ render: () => ["result", "result continuation"], invalidate() {} }),
		};
		const thirdParty = new ToolExecutionComponent("spacing_test", `third-${renderShell}`, {}, {}, definition, { requestRender() {} } as any, process.cwd());
		thirdParty.updateResult({ content: [{ type: "text", text: "result" }], isError: false });
		const rendered = rows(thirdParty);
		assertIndent(rendered, "✓ call", 3);
		assertIndent(rendered, "call continuation", 6);
		assertIndent(rendered, "└─ Done", 3);
		assertIndent(rendered, "result continuation", 6);
	}

	const unknown = new ToolExecutionComponent("unknown_tool", "unknown", {}, {}, undefined, { requestRender() {} } as any, process.cwd());
	unknown.updateResult({ content: [{ type: "text", text: "result\n  nested" }], isError: false });
	const unknownRows = rows(unknown);
	assertIndent(unknownRows, "unknown_tool", 3);
	assertIndent(unknownRows, "result", 6);
	assertIndent(unknownRows, "nested", 8);
});

test("native tool expansion toggles subagent prompts while streaming and after settlement", (t) => {
	// Compare expansion state, not a spinner frame that can advance between renders.
	t.mock.method(Date, "now", () => 1_000);
	initTheme("dark", false);
	install();
	const task = "x".repeat(500) + "PROMPT_END";
	for (const name of ["subagent_spawn", "subagent_continue"]) {
		const definition = { ...toolDefinition, name };
		const component = new ToolExecutionComponent(name, `prompt-${name}`, {}, {}, definition, { requestRender() {} } as any, process.cwd());
		assert.doesNotMatch(component.render(120).join("\n"), /Prompt:/, "incomplete streamed arguments are safe");
		component.updateArgs({ agent: "investigator", title: "Inspect renderer", task });
		component.setArgsComplete();
		component.markExecutionStarted();
		const checkExpansion = () => {
			component.setExpanded(false);
			const collapsed = component.render(120).join("\n");
			assert.match(collapsed, /Prompt:/);
			assert.match(collapsed, /ctrl\+o to expand/);
			assert.doesNotMatch(collapsed, /PROMPT_END/);
			component.setExpanded(true);
			assert.match(component.render(120).join("\n"), /PROMPT_END/);
			component.setExpanded(false);
			assert.equal(component.render(120).join("\n"), collapsed);
		};
		checkExpansion();
		component.updateResult({ content: [{ type: "text", text: "Completed investigation" }], isError: false });
		checkExpansion();
		component.invalidate();
		assert.match(component.render(120).join("\n"), /Completed investigation/);
	}
});

// The repository's minimum Pi version predates pointer support. Run these against
// a mouse-capable Pi as well; feature detection keeps the compatibility suite valid.
const supportsToolMouse = typeof (ToolExecutionComponent.prototype as any).createResultRegion === "function";

function mouseAt(component: ToolExecutionComponent, text: string, type = "click", button = "left", x = 10): any {
	const width = 120;
	const rows = component.render(width);
	const y = rows.findIndex((row) => row.includes(text));
	assert.ok(y >= 0, `missing mouse target: ${text}`);
	return (component as any).handleMouse({
		type, button, x, y, screenX: x, screenY: y,
		width, height: rows.length, shift: false, alt: false, ctrl: false,
	});
}

test("mouse toggles only the clicked subagent prompt in both native shells", { skip: !supportsToolMouse }, () => {
	initTheme("dark", false);
	install();
	for (const renderShell of ["default", "self"]) {
		for (const name of ["subagent_spawn", "subagent_continue"]) {
			const definition = { ...toolDefinition, name, renderShell };
			const args = { agent: "investigator", title: "Inspect renderer", task: "x".repeat(500) + "PROMPT_END" };
			const make = (id: string) => new ToolExecutionComponent(name, id, args, {}, definition, { requestRender() {} } as any, process.cwd());
			const component = make("clicked");
			const sibling = make("untouched");
			// Native Pi waits for a result (including a partial progress result).
			assert.equal(mouseAt(component, "Prompt:"), undefined);
			assert.doesNotMatch(component.render(120).join("\n"), /PROMPT_END/);
			for (const partial of [true, false]) {
				component.updateResult({ content: [{ type: "text", text: "Report" }], isError: false }, partial);
				for (const [type, button] of [["click", "right"], ["drag", "left"], ["wheel", "none"]]) {
					assert.equal(mouseAt(component, "Prompt:", type, button), undefined);
				}
				assert.equal(mouseAt(component, "ctrl+o to expand")?.handled, true);
				assert.match(component.render(120).join("\n"), /PROMPT_END/);
				assert.doesNotMatch(sibling.render(120).join("\n"), /PROMPT_END/);
				assert.equal(mouseAt(component, "Prompt:")?.handled, true);
				assert.doesNotMatch(component.render(120).join("\n"), /PROMPT_END/);
			}
			component.invalidate();
			assert.equal(mouseAt(component, "Prompt:")?.handled, true);
			component.setExpanded(false);
			assert.doesNotMatch(component.render(120).join("\n"), /PROMPT_END/, "global keyboard state still controls the same expansion flag");
		}
	}
});

test("third-party styled wrappers retain native click expansion including the overflow row", { skip: !supportsToolMouse }, () => {
	initTheme("dark", false);
	install();
	for (const renderShell of ["default", "self"]) {
		const definition = {
			...toolDefinition, renderShell,
			renderResult: () => ({ render: () => ["one", "two", "three", "four", "RESULT_END"], invalidate() {} }),
		};
		const component = new ToolExecutionComponent("spacing_test", "third-party-click", {}, {}, definition, { requestRender() {} } as any, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "result" }], isError: false });
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/);
		assert.equal(mouseAt(component, "ctrl+o to expand")?.handled, true);
		assert.match(component.render(120).join("\n"), /RESULT_END/);
		assert.equal(mouseAt(component, "call")?.handled, true);
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/);
	}
});

test("renderer-owned mouse controls run before native expansion fallback", { skip: !supportsToolMouse }, () => {
	initTheme("dark", false);
	install();
	for (const renderShell of ["default", "self"]) {
		const events: any[] = [];
		const definition = {
			...toolDefinition, renderShell,
			renderResult: () => ({
				render: () => ["  control", "second", "third", "fourth", "RESULT_END"],
				invalidate() {},
				handleMouse(event: any) { events.push(event); return { handled: true }; },
			}),
		};
		const component = new ToolExecutionComponent("spacing_test", "interactive-third-party", {}, {}, definition, { requestRender() {} } as any, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "result" }], isError: false });
		assert.equal(mouseAt(component, "control", "click", "left", 20)?.handled, true);
		assert.equal(events.length, 1);
		assert.equal(events[0].x, 9, "shell/prefix removed and stripped child padding restored");
		assert.equal(events[0].y, 0);
		assert.equal(events[0].height, 5, "child receives its full unclipped height");
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/);
		assert.equal(mouseAt(component, "second", "wheel", "none", 20)?.handled, true);
		assert.equal(events[1].type, "wheel");
		assert.equal(events[1].y, 1);
		assert.equal(mouseAt(component, "ctrl+o to expand")?.handled, true);
		assert.equal(events.length, 2, "synthetic overflow row belongs to the outer native expansion region");
		assert.match(component.render(120).join("\n"), /RESULT_END/);
	}
});

test("all harness renderer families retain mouse expansion of their result previews", { skip: !supportsToolMouse }, () => {
	initTheme("dark", false);
	install();
	const report = Array.from({ length: 18 }, (_, i) => `proof ${i}`).join("\n") + "\nRESULT_END";
	const cases: Array<[string, any]> = [
		...[
			"subagent_read", "subagent_status", "subagent_control", "resource_read", "resource_list", "resource_delete",
			"workflow_status", "workflow_compile", "story_write", "e2e_write", "task_write", "task_clarify", "stage_write",
			"evaluation_read", "distill_read", "distill_prepare", "distill_record",
		].map((name): [string, any] => [name, {}]),
		["story_write", { piboxResourceDiff: { action: "update", ref: "story:example", diff: Array.from({ length: 20 }, (_, i) => `+${i + 1} ${i === 19 ? "RESULT_END" : `line ${i}`}`).join("\n") } }],
		["memory_adapter", { action: "recall", records: Array.from({ length: 9 }, (_, i) => ({ id: String(i), memory: i === 8 ? "RESULT_END" : `memory ${i}` })) }],
		["wait", { kind: "event", event: "subagent_settled", settlements: Array.from({ length: 9 }, (_, i) => ({ agent: i === 8 ? "RESULT_END" : `agent ${i}` })) }],
	];
	for (const [name, details] of cases) {
		const component = new ToolExecutionComponent(name, `result-${name}`, {}, {}, { ...toolDefinition, name, renderShell: "default" }, { requestRender() {} } as any, process.cwd());
		component.updateResult({ content: [{ type: "text", text: report }], details, isError: false });
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/, name);
		assert.equal(mouseAt(component, "ctrl+o to expand")?.handled, true, name);
		assert.match(component.render(120).join("\n"), /RESULT_END/, name);
		assert.equal(mouseAt(component, "RESULT_END")?.handled, true, name);
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/, name);
	}
});

test("every styled built-in keeps native expansion including compact skill/rule reads", { skip: !supportsToolMouse }, () => {
	initTheme("dark", false);
	const definitions = new Map<string, any>();
	install(undefined, definitions);
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
		const count = name === "edit" ? 2002 : 20;
		const rows = Array.from({ length: count }, (_, i) => `row ${i}`);
		const markerIndex = name === "bash" ? 0 : count - 1;
		rows[markerIndex] = "RESULT_END";
		const component = new ToolExecutionComponent(name, `builtin-${name}`, { path: "/tmp/test", command: "test", pattern: "test" }, {}, definitions.get(name), { requestRender() {} } as any, process.cwd());
		component.updateResult({ content: [{ type: "text", text: rows.join("\n") }], isError: false });
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/, name);
		assert.equal(mouseAt(component, "ctrl+o to expand")?.handled, true, name);
		assert.match(component.render(120).join("\n"), /RESULT_END/, name);
		assert.equal(mouseAt(component, "RESULT_END")?.handled, true, name);
		assert.doesNotMatch(component.render(120).join("\n"), /RESULT_END/, name);
	}
	for (const path of ["/tmp/skills/test/SKILL.md", "/tmp/.pi/rules/test.md"]) {
		const component = new ToolExecutionComponent("read", path, { path }, {}, definitions.get("read"), { requestRender() {} } as any, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "HIDDEN_CONTENT" }], isError: false });
		assert.doesNotMatch(component.render(120).join("\n"), /HIDDEN_CONTENT/);
		assert.equal(mouseAt(component, "Loaded")?.handled, true);
		assert.match(component.render(120).join("\n"), /HIDDEN_CONTENT/);
	}
});
