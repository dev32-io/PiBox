import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import styledOutputs from "../index.js";
import { exploreCounts, exploreRuns, exploreTarget } from "../components/tool-group.js";
import { toolActivity } from "../components/tool-activity.js";

initTheme("dark", false);
const theme = new Proxy({}, {
	get(_target, property) {
		if (property === "fg" || property === "bg") return (_color: string, text: string) => text;
		if (property === "bold") return (text: string) => text;
		return undefined;
	},
});

function install(): { tools: Map<string, any>; handlers: Map<string, (...args: any[]) => any> } {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	styledOutputs({
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerMarkdownTransformer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
	} as any);
	handlers.get("session_start")?.({}, { mode: "tui", ui: { theme, requestRender() {} } });
	return { tools, handlers };
}

function assistant(content: any[]): any {
	return {
		role: "assistant", content, provider: "test", model: "test", api: "test", stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

const CWD = "/repo";
const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
const READ = (id: string, path = `${CWD}/src/${id}.ts`) => call(id, "read", { path });
const GREP = (id: string) => call(id, "grep", { pattern: "pane=true" });
const FIND = (id: string) => call(id, "find", { pattern: "**/*.ts" });
const LS = (id: string) => call(id, "ls", { path: `${CWD}/docs` });
const ok = (text: string) => ({ content: [{ type: "text", text }], isError: false });

/** What Pi does for one assistant message: render it, then create its tool rows in content order. */
function message(tools: Map<string, any>, content: any[], ui: any = { requestRender() {} }): ToolExecutionComponent[] {
	new AssistantMessageComponent(assistant(content));
	return content.filter((block) => block.type === "toolCall").map((block) =>
		new ToolExecutionComponent(block.name, block.id, block.arguments, {}, tools.get(block.name), ui, CWD));
}

const rows = (component: ToolExecutionComponent, width = 100) => component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
const transcript = (components: ToolExecutionComponent[], width = 100) => components.flatMap((component) => rows(component, width));

test("2-4 consecutive read-only calls render one tree whose connector continues from the glyph column", () => {
	const { tools } = install();
	for (const content of [
		[READ("a"), GREP("b")],
		[READ("a"), READ("b"), FIND("c")],
		[READ("a"), GREP("b"), FIND("c"), LS("d")],
	]) {
		const components = message(tools, content);
		components[0]!.updateResult(ok("one\ntwo"));
		for (const component of components.slice(1)) component.updateResult(ok("x"));
		for (const member of components.slice(1)) assert.deepEqual(member.render(100), [], "members render zero lines, no spacer");
		const lines = rows(components[0]!).filter(Boolean);
		assert.equal(lines.length, 1 + content.length);
		const glyphColumn = lines[0]!.indexOf("✓");
		assert.equal(glyphColumn, 3);
		assert.match(lines[0]!, /✓ \u{f1e5} Explored /u);
		lines.slice(1).forEach((line, index) => {
			const branch = index === content.length - 1 ? "└─" : "├─";
			assert.equal(line.indexOf(branch), glyphColumn, line);
		});
		assert.doesNotMatch(lines.join("\n"), /Done/, "no separate status line");
	}
	const components = message(tools, [READ("a"), GREP("b"), FIND("c"), LS("d")]);
	components.forEach((component) => component.updateResult(ok("1\n2")));
	assert.deepEqual(rows(components[0]!).filter(Boolean), [
		"   ✓ \u{f1e5} Explored 1 file, 1 search, 1 glob, 1 directory",
		"   ├─ \u{f15c} Read src/a.ts • 2 lines",
		"   ├─ \u{f002} Grep pane=true • 2 matches",
		"   ├─ \u{f07b} Find **/*.ts • 2 files",
		"   └─ \u{f07b} Ls docs • 2 entries",
	]);
});

test("a single read-only call renders exactly as an ungrouped row", () => {
	const { tools } = install();
	const [single] = message(tools, [READ("solo")]);
	single!.updateResult(ok("body"));
	// A row Pi created outside any observed message is never grouped.
	const reference = new ToolExecutionComponent("read", "unobserved", READ("solo").arguments, {}, tools.get("read"), { requestRender() {} } as any, CWD);
	reference.updateResult(ok("body"));
	assert.deepEqual(rows(single!).filter(Boolean), rows(reference).filter(Boolean));
	assert.match(rows(single!).join("\n"), /✓ \u{f15c} Read src\/solo\.ts\n {3}└─ Done • 1 line/u);
});

const IMAGE_RESULT = { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], isError: false };

test("a read that returns an image by content renders standalone, splitting the group around it", () => {
	const { tools } = install();
	const pair = message(tools, [READ("a"), READ("shot", `${CWD}/shot`)]);
	pair[0]!.updateResult(ok("one"));
	assert.match(rows(pair[0]!).join("\n"), /Exploring/, "grouped until the image arrives");
	pair[1]!.updateResult(IMAGE_RESULT);
	const [first, second] = pair.map((component) => rows(component).join("\n"));
	assert.doesNotMatch(`${first}\n${second}`, /Explored/);
	assert.match(first!, /Read src\/a\.ts\n {3}└─ Done/);
	assert.match(second!, /Read shot\n {3}└─ Done/);
	assert.ok(pair[1]!.children.some((child: any) => child.constructor.name === "Image"), "the image child still renders");

	const triple = message(tools, [READ("x"), READ("img", `${CWD}/shot`), READ("z")]);
	triple.forEach((component, index) => component.updateResult(index === 1 ? IMAGE_RESULT : ok("body")));
	const text = transcript(triple).join("\n");
	assert.doesNotMatch(text, /Explored/);
	assert.equal(text.match(/└─ Done/g)?.length, 3);
	assert.deepEqual(triple.map((component) => rows(component).some(Boolean)), [true, true, true]);
});

test("any other tool or visible text between calls breaks the group; hidden thinking does not", () => {
	assert.deepEqual([...exploreRuns([READ("a"), call("b", "bash", { command: "ls" }), READ("c")]).runs.values()].map((run) => run.length), [1, 1]);
	assert.deepEqual([...exploreRuns([READ("a"), { type: "text", text: "Now the tests." }, READ("c")]).runs.values()].map((run) => run.length), [1, 1]);
	assert.equal(exploreRuns([READ("a"), { type: "text", text: "  " }, { type: "thinking", thinking: "hm" }, READ("c")]).runs.get("c")?.length, 2);
	assert.equal(exploreRuns([READ("a"), READ("s", "/r/skills/x/SKILL.md"), READ("c")]).runs.get("c")?.length, 1, "loaded skills stay one-line rows");
	assert.equal(exploreRuns([READ("a"), READ("i", "/r/shot.png")]).runs.get("a")?.length, 1, "image reads keep their attachment visible");

	const { tools } = install();
	const components = message(tools, [READ("a"), call("b", "bash", { command: "ls" }), READ("c")]);
	components.forEach((component) => component.updateResult(ok("x")));
	const text = transcript(components).join("\n");
	assert.doesNotMatch(text, /Explored/);
	assert.equal(text.match(/└─ Done/g)?.length, 3);
});

test("running, error, and mixed states drive the group glyph and member rows", (t) => {
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const { tools } = install();
	const components = message(tools, [READ("a"), GREP("b"), FIND("c")]);
	try {
		components.forEach((component) => component.markExecutionStarted());
		now += 3_200;
		components[0]!.updateResult(ok("x"));
		let lines = rows(components[0]!).filter(Boolean);
		assert.equal(lines[0], "   ✽ \u{f1e5} Exploring… 1 file, 1 search, 1 glob • 3s");
		assert.equal(lines[1], "   ├─ \u{f15c} Read src/a.ts • 1 line");
		assert.equal(lines[2], "   ├─ \u{f002} Grep pane=true • Running…");

		components[1]!.updateResult({ content: [{ type: "text", text: "rg: regex parse error\ndetails" }], isError: true });
		assert.match(rows(components[0]!).join("\n"), /✽ .*Exploring…/u, "running wins while any member runs");
		now += 100;
		components[2]!.updateResult(ok("a.ts"));
		lines = rows(components[0]!).filter(Boolean);
		assert.equal(lines[0], "   ✗ \u{f1e5} Explored 1 file, 1 search, 1 glob • 3.3s");
		assert.equal(lines[2], "   ├─ \u{f002} Grep pane=true • ✗ rg: regex parse error");
		assert.equal(lines[3], "   └─ \u{f07b} Find **/*.ts • 1 file");
	} finally {
		toolActivity().clear();
	}
});

test("out-of-order completion reports wall time from first start to last end", (t) => {
	let now = 50_000;
	t.mock.method(Date, "now", () => now);
	const { tools } = install();
	const components = message(tools, [READ("a"), READ("b"), GREP("c")]);
	components[1]!.markExecutionStarted();
	now += 200;
	components[0]!.markExecutionStarted();
	components[2]!.markExecutionStarted();
	now += 300;
	components[2]!.updateResult(ok("hit"));
	assert.match(rows(components[0]!).join("\n"), /Exploring…/);
	now += 400;
	components[1]!.updateResult(ok("b"));
	now += 100;
	components[0]!.updateResult(ok("a"));
	assert.equal(rows(components[0]!).filter(Boolean)[0], "   ✓ \u{f1e5} Explored 2 files, 1 search • 1.0s");
	assert.equal(toolActivity().runningCount, 0);
});

test("streamed calls join the group as they arrive, and streamed args can split it", () => {
	const { tools } = install();
	const ui = { requestRender() {} };
	const streaming = new AssistantMessageComponent(undefined as any);
	streaming.updateContent(assistant([READ("a")]), true);
	const first = new ToolExecutionComponent("read", "a", READ("a").arguments, {}, tools.get("read"), ui as any, CWD);
	assert.match(rows(first).join("\n"), /✽ \u{f15c} Read src\/a\.ts/u, "alone it is an ordinary row");
	streaming.updateContent(assistant([READ("a"), call("b", "read", { path: "/r/skills/x/SKILL" })]), true);
	const second = new ToolExecutionComponent("read", "b", { path: "/r/skills/x/SKILL" }, {}, tools.get("read"), ui as any, CWD);
	assert.match(rows(first).join("\n"), /Exploring… 2 files/, "the first row becomes the anchor without its own update");
	assert.deepEqual(second.render(100), []);
	streaming.updateContent(assistant([READ("a"), call("b", "read", { path: "/r/skills/x/SKILL.md" })]), true);
	second.updateArgs({ path: "/r/skills/x/SKILL.md" });
	assert.doesNotMatch(rows(first).join("\n"), /Explor/, "a completed skill path leaves the group");
	assert.match(rows(second).join("\n"), /Loading skill x/);
});

const supportsToolMouse = typeof (ToolExecutionComponent.prototype as any).createResultRegion === "function";

function click(component: ToolExecutionComponent, y: number): any {
	const height = component.render(100).length;
	return (component as any).handleMouse({ type: "click", button: "left", x: 6, y, screenX: 6, screenY: y, width: 100, height, shift: false, alt: false, ctrl: false });
}

test("a click anywhere on the group toggles its member previews; ctrl+o shows full outputs and resets clicks", { skip: !supportsToolMouse }, () => {
	const { tools } = install();
	const components = message(tools, [READ("a"), GREP("b")]);
	const sibling = message(tools, [READ("c"), GREP("d")]);
	const body = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
	for (const group of [components, sibling]) {
		group[0]!.updateResult(ok(body));
		group[1]!.updateResult(ok("src/x.ts:1: pane=true"));
	}
	const collapsed = rows(components[0]!);
	assert.doesNotMatch(collapsed.join("\n"), /line 1\b/);

	assert.equal(click(components[0]!, 3)?.handled, true, "the last tree row is part of the group target");
	let open = rows(components[0]!).filter(Boolean);
	assert.equal(open[1], "   ├─ \u{f15c} Read src/a.ts • 14 lines");
	assert.equal(open[2], "   │     line 1", "member previews hang under a rail");
	assert.ok(open.includes("   │     line 10"));
	assert.ok(!open.some((line) => line.includes("line 11")), "a click shows each member's collapsed preview");
	assert.ok(open.some((line) => /│ {5}… \+4 more lines \(ctrl\+o to expand\)/.test(line)));
	assert.equal(open.at(-1), "         src/x.ts:1: pane=true", "the last member's preview has no rail");
	assert.deepEqual(rows(sibling[0]!), collapsed.map((line) => line.replace("src/a.ts", "src/c.ts")), "only the clicked group opens");

	assert.equal(click(components[0]!, 1)?.handled, true);
	assert.deepEqual(rows(components[0]!), collapsed);
	assert.equal(click(components[1]!, 0), undefined, "a member row has no lines to click");

	for (const component of [...components, ...sibling]) component.setExpanded(true);
	open = rows(components[0]!);
	assert.ok(open.some((line) => line.endsWith("│     line 14")), "global expansion shows full outputs");
	assert.ok(rows(sibling[0]!).some((line) => line.endsWith("line 14")));
	assert.equal(click(components[0]!, 1)?.handled, true);
	assert.deepEqual(rows(components[0]!).filter(Boolean).length, 3, "a click still closes one group under global expansion");
	for (const component of [...components, ...sibling]) component.setExpanded(false);
	for (const component of [...components, ...sibling]) component.setExpanded(true);
	assert.ok(rows(components[0]!).some((line) => line.endsWith("line 14")), "the global key overrides earlier clicks");
});

test("open groups wrap long member targets with a rail under the tree", () => {
	const { tools } = install();
	const long = `${CWD}/${"deeply/nested/".repeat(8)}file.ts`;
	const components = message(tools, [READ("a", long), READ("b")]);
	components.forEach((component) => component.updateResult(ok("x")));
	const collapsed = rows(components[0]!, 60).filter(Boolean);
	assert.equal(collapsed.length, 3);
	assert.ok(collapsed[1]!.endsWith("…"));
	components.forEach((component) => component.setExpanded(true));
	const open = rows(components[0]!, 60).filter(Boolean);
	assert.ok(open.join("").replace(/\s|│/g, "").includes(exploreTarget("read", { path: long }, CWD).replace(/\s/g, "")));
	assert.match(open[2]!, /^ {3}│ {2}\S/, "continuation rows keep the tree rail");
	for (const line of open) assert.ok(line.length <= 60, line);
});

test("rows bind to their own message; session boundaries release the last observed message", () => {
	const { tools, handlers } = install();
	const first = message(tools, [READ("call_0"), READ("call_1")]);
	const second = message(tools, [READ("call_0"), call("call_1", "bash", { command: "ls" })]);
	[...first, ...second].forEach((component) => component.updateResult(ok("x")));
	assert.match(rows(first[0]!).join("\n"), /Explored 2 files/, "reused provider ids stay with their message");
	assert.doesNotMatch(rows(second[0]!).join("\n"), /Explored/);
	handlers.get("session_shutdown")?.({}, {});
	handlers.get("session_start")?.({}, { mode: "tui", ui: { theme, requestRender() {} } });
	const fallback = new ToolExecutionComponent("read", "call_0", READ("call_0").arguments, {}, tools.get("read"), { requestRender() {} } as any, CWD);
	fallback.updateResult(ok("x"));
	assert.match(rows(fallback).join("\n"), /└─ Done/, "a row with no observed message renders standalone");
});

test("reload reinstalls nothing, and grouped rows still render one group", () => {
	install();
	const updateDisplay = (ToolExecutionComponent.prototype as any).updateDisplay;
	const updateContent = (AssistantMessageComponent.prototype as any).updateContent;
	const { tools } = install();
	assert.equal((ToolExecutionComponent.prototype as any).updateDisplay, updateDisplay);
	assert.equal((AssistantMessageComponent.prototype as any).updateContent, updateContent);
	assert.equal(typeof (ToolExecutionComponent.prototype as any)[Symbol.for("pibox:styled-outputs:tool-base-update-display")], "function");
	const components = message(tools, [READ("a"), READ("b")]);
	components.forEach((component) => component.updateResult(ok("x")));
	assert.equal(transcript(components).filter((line) => line.includes("Explored")).length, 1);
});

test("restored history renders final groups without inventing durations", () => {
	const { tools } = install();
	const components = message(tools, [READ("a"), GREP("b")]);
	components[0]!.updateResult(ok("x"));
	components[1]!.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
	assert.deepEqual(rows(components[0]!).filter(Boolean), [
		"   ✗ \u{f1e5} Explored 1 file, 1 search",
		"   ├─ \u{f15c} Read src/a.ts • 1 line",
		"   └─ \u{f002} Grep pane=true • ✗ Operation aborted",
	]);
});

test("a member that never finishes freezes the group's elapsed time at agent end", (t) => {
	let now = 10_000;
	t.mock.method(Date, "now", () => now);
	const { tools, handlers } = install();
	const ui = { mode: "fullscreen", requestRender() {} };
	const components = message(tools, [READ("a"), GREP("b")], ui);
	try {
		components.forEach((component) => component.markExecutionStarted());
		now += 1_000;
		components[0]!.updateResult(ok("x"));
		now += 4_000;
		handlers.get("agent_end")?.({}, {});
		assert.equal(toolActivity().animating, false);
		now += 60_000;
		assert.match(rows(components[0]!).filter(Boolean)[0]!, /Exploring… 1 file, 1 search • 5s$/);
	} finally {
		handlers.get("session_shutdown")?.({}, {});
	}
});

test("summary counts use natural plurals in a fixed order", () => {
	assert.equal(exploreCounts(["grep", "read", "read", "ls", "find", "grep", "ls"]), "2 files, 2 searches, 1 glob, 2 directories");
	assert.equal(exploreTarget("read", { path: "/repo/AGENTS.md", offset: 1, limit: 12 }, "/repo"), "AGENTS.md:1-12");
	assert.equal(exploreTarget("read", { path: "/repo/a.ts", offset: 40 }, "/repo"), "a.ts:40");
	assert.equal(exploreTarget("grep", { pattern: "a  b", path: "/repo/src" }, "/repo"), "a b in src");
});
