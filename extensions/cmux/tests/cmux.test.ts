import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import cmuxExtension, { type CmuxDependencies } from "../index.js";
import { CmuxPaneAdapter, SocketViewerTransport, chooseLargestOwnedPane, sanitizeTerminalText, splitDirection, splitIsViable, type CmuxClient, type CmuxPane, type ViewerFrame, type ViewerTransport } from "../cmux.js";
import { CMUX_PANES_ENTRY_TYPE, loadCmuxPanesDefault, resolveCmuxPanesDefault, restoreCmuxPanesEnabled } from "../config.js";
import type { LogicalAgentSnapshot, RuntimeOwner, SubagentEvent, SubagentService } from "../../subagent/api.js";
import type { SubagentDisplayEvent } from "../../subagent/display.js";

class FakeViewers implements ViewerTransport {
	readonly writes = new Map<string, string>();
	readonly frames = new Map<string, ViewerFrame[]>();
	readonly commands: string[] = [];
	readonly log: string[] = [];
	private readonly closes = new Map<string, () => void>();
	constructor(private readonly sequence: string[] = []) {}
	command(key: string, onUnexpectedClose: () => void): string { this.commands.push(key); this.closes.set(key, onUnexpectedClose); return `viewer-${this.commands.length}`; }
	send(key: string, frame: ViewerFrame): void {
		this.log.push(`send:${key}:${frame.type}`);
		this.frames.set(key, [...(this.frames.get(key) ?? []), frame]);
		if (frame.type === "text") this.writes.set(key, (this.writes.get(key) ?? "") + frame.text);
	}
	write(key: string, text: string): void { this.send(key, { type: "text", text }); }
	async close(key: string): Promise<void> { this.log.push(`flush:${key}`); this.sequence.push(`flush:${key}`); this.closes.delete(key); }
	abandon(key: string): void { this.log.push(`abandon:${key}`); this.closes.delete(key); }
	async shutdown(): Promise<void> { this.log.push("shutdown"); }
	userClose(key: string): void { this.closes.get(key)?.(); this.closes.delete(key); }
}

class FakeCmux implements CmuxClient {
	readonly log: string[] = [];
	readonly resizes: Array<{ paneId: string; direction: "right" | "down"; amount: number }> = [];
	private next = 0;
	constructor(readonly panes: CmuxPane[], private readonly sequence: string[] = []) {}
	async listPanes(): Promise<readonly CmuxPane[]> { return structuredClone(this.panes); }
	async split(direction: "right" | "down", sourceSurfaceId: string, command: string) {
		const index = this.panes.findIndex((pane) => pane.surfaceIds.includes(sourceSurfaceId));
		if (index < 0) throw new Error("missing source");
		const id = ++this.next;
		const original = this.panes[index]!;
		const source: CmuxPane = direction === "right" ? { ...original, width: original.width / 2 } : { ...original, height: original.height / 2 };
		this.panes[index] = source;
		const pane: CmuxPane = direction === "right"
			? { ...original, paneId: `pane-${id}`, surfaceIds: [`surface-${id}`], x: original.x + original.width / 2, width: original.width / 2, ...(original.columns === undefined ? {} : { columns: original.columns / 2 }) }
			: { ...original, paneId: `pane-${id}`, surfaceIds: [`surface-${id}`], y: original.y + original.height / 2, height: original.height / 2, ...(original.rows === undefined ? {} : { rows: original.rows / 2 }) };
		this.panes.push(pane);
		this.log.push(`split:${direction}:${sourceSurfaceId}:${command}`);
		return { paneId: pane.paneId, surfaceId: pane.surfaceIds[0]! };
	}
	async resizeSource(paneId: string, direction: "right" | "down", amount: number): Promise<void> {
		const sourceIndex = this.panes.findIndex((pane) => pane.paneId === paneId);
		const targetIndex = this.panes.length - 1;
		const source = this.panes[sourceIndex]!; const target = this.panes[targetIndex]!;
		this.panes[sourceIndex] = direction === "right" ? { ...source, width: source.width + amount } : { ...source, height: source.height + amount };
		this.panes[targetIndex] = direction === "right" ? { ...target, x: target.x + amount, width: target.width - amount } : { ...target, y: target.y + amount, height: target.height - amount };
		this.resizes.push({ paneId, direction, amount });
		this.log.push(`resize:${paneId}:${direction}:${amount}`);
	}
	async closeSurface(surfaceId: string): Promise<void> {
		this.log.push(`close:${surfaceId}`); this.sequence.push(`close:${surfaceId}`);
		const index = this.panes.findIndex((pane) => pane.surfaceIds.includes(surfaceId));
		if (index >= 0) this.panes.splice(index, 1);
	}
	async renameTab(surfaceId: string, title: string): Promise<void> { this.log.push(`rename:${surfaceId}:${title}`); }
}

const owner: RuntimeOwner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
const pane = (paneId: string, surfaceId: string, width: number, height: number, columns = 120, rows = 40): CmuxPane => ({ paneId, surfaceIds: [surfaceId], x: 0, y: 0, width, height, columns, rows });
const snapshot = (agentId: string, attemptId: string, title = "Task"): LogicalAgentSnapshot => ({
	handle: { owner, agentId, continuationCapability: "token" }, agent: "worker", title, state: "running", attemptId,
	provider: "test", model: "test", effort: "off", fast: false, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const event = (agentId: string, attemptId: string, type: SubagentEvent["type"], data?: Record<string, unknown>): SubagentEvent => ({ owner, cursor: 1, agentId, attemptId, sequence: 1, type, at: "2026-01-01T00:00:00Z", ...(data ? { data } : {}) });
const displayEvent = (agentId: string, attemptId: string, frame: SubagentDisplayEvent["frame"]): SubagentDisplayEvent => ({ owner, agentId, attemptId, frame });

function extensionFixture(t: TestContext, dependencies: CmuxDependencies = {}, serviceOverrides: Partial<SubagentService> = {}) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let command: any; let listener: ((event: SubagentEvent) => void) | undefined;
	const branch: any[] = []; const notices: string[] = []; const viewers: FakeViewers[] = []; const clients: FakeCmux[] = [];
	const active = snapshot("a", "one");
	const replay = () => ({ snapshot: { owner, cursor: 0, agents: [active] }, events: [], reset: false });
	let controlCalls = 0;
	const forbidden = () => { controlCalls++; throw new Error("child control called"); };
	const service = {
		owner, protocolVersion: 1, launch: forbidden, continue: forbidden, wait: forbidden, stop: forbidden, release: forbidden, teardown: forbidden,
		inspect: () => [active], replay,
		subscribe: (_owner: RuntimeOwner, _cursor: number, callback: (value: SubagentEvent) => void) => {
			listener = callback; return { initial: replay(), unsubscribe() { listener = undefined; } };
		},
		...serviceOverrides,
	} as unknown as SubagentService;
	cmuxExtension({
		on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (_name: string, value: any) => { command = value; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main" }, loadDefault: () => true,
		resolveSubagents: () => ({ owner, protocolVersion: 1, service }),
		createClient: () => { const value = new FakeCmux([pane("main-pane", "main", 1200, 600)]); clients.push(value); return value; },
		createViewers: async () => { const value = new FakeViewers(); viewers.push(value); return value; },
		...dependencies,
	});
	const ctx = { cwd: process.cwd(), ui: { notify: (message: string) => notices.push(message) }, sessionManager: { getSessionId: () => "session", getBranch: () => branch } } as unknown as ExtensionContext;
	const run = (name: string, value = {}) => handlers.get(name)!(value, ctx);
	t.after(async () => { await run("session_shutdown"); assert.equal(controlCalls, 0, "observer must never control children"); });
	return { branch, notices, viewers, clients, run, command: (args: string) => command.handler(args, ctx), emit: (value: SubagentEvent) => listener?.(value), get subscribed() { return Boolean(listener); } };
}

async function opened(width = 1200, height = 600) {
	const client = new FakeCmux([pane("main-pane", "main", width, height)]);
	const viewers = new FakeViewers();
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one"));
	await adapter.idle();
	return { adapter, client, viewers };
}

function commandParts(command: string): string[] {
	return [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

async function socketFixture(t: TestContext) {
	const transport = await SocketViewerTransport.create(); const sockets: Socket[] = [];
	t.after(async () => { for (const socket of sockets) socket.destroy(); await transport.shutdown(); });
	return { transport, connectSocket(path: string, allowHalfOpen = false) { const socket = connect({ path, allowHalfOpen }); sockets.push(socket); return socket; } };
}

function receiveFrames(socket: Socket, onFrame: (frame: ViewerFrame) => void = () => {}) {
	let input = ""; const frames: ViewerFrame[] = [];
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		input += chunk;
		for (;;) {
			const end = input.indexOf("\n"); if (end < 0) break;
			const frame = JSON.parse(input.slice(0, end)) as ViewerFrame; input = input.slice(end + 1); frames.push(frame); onFrame(frame);
		}
	});
	return frames;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
	let timer: NodeJS.Timeout;
	try {
		return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("test timeout")), milliseconds); })]);
	} finally {
		clearTimeout(timer!);
	}
}

test("cmux pane defaults are global-only, strict, and branch-restored", async () => {
	for (const value of [undefined, null, [], {}, { enabled: "false" }, { enabled: true }]) assert.equal(resolveCmuxPanesDefault(value), true);
	assert.equal(resolveCmuxPanesDefault({ enabled: false }), false);
	let branch: unknown[] = [
		{ type: "custom", customType: CMUX_PANES_ENTRY_TYPE, data: { schemaVersion: 1, enabled: false } },
		{ type: "custom", customType: CMUX_PANES_ENTRY_TYPE, data: { schemaVersion: 2, enabled: true } },
	];
	const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
	assert.equal(restoreCmuxPanesEnabled(ctx, true), false);
	branch = [];
	assert.equal(restoreCmuxPanesEnabled(ctx, false), false);
	const root = await mkdtemp(join(tmpdir(), "pibox-cmux-config-"));
	try {
		const global = join(root, "global"); const repo = join(root, "repo");
		await mkdir(global); await mkdir(join(repo, ".pi"), { recursive: true });
		await writeFile(join(global, "settings.json"), JSON.stringify({ cmuxPanes: { enabled: false } }));
		await writeFile(join(repo, ".pi", "settings.json"), JSON.stringify({ cmuxPanes: { enabled: true } }));
		assert.equal(loadCmuxPanesDefault(repo, global), false);
		await writeFile(join(global, "settings.json"), JSON.stringify({ cmuxPanes: { enabled: "no" } }));
		assert.equal(loadCmuxPanesDefault(repo, global), true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("enabled/disabled defaults, legacy opt-out, observer-only toggles, tree and reload", async (t) => {
	for (const enabled of [true, false]) {
		const host = extensionFixture(t, { loadDefault: () => enabled, env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main", PIBOX_CMUX_PANES: "0" } });
		const { viewers, clients, notices } = host;
		await host.run("session_start");
		assert.equal(host.subscribed, enabled);
		assert.equal(viewers.length, enabled ? 1 : 0);
		if (!enabled) await host.command("on");
		assert.deepEqual(viewers[0]!.frames.get("a\0one")?.[0], { type: "init", title: "worker · Task", limited: true });
		await host.command("off");
		assert.equal(host.subscribed, false); assert.ok(viewers[0]!.log.includes("shutdown")); assert.ok(clients[0]!.log.includes("close:surface-1"));
		await host.command("on");
		assert.ok(host.subscribed); assert.equal(viewers[1]!.commands.length, 1, "on reseeds active attempts");
		host.emit(event("b", "two", "attempt_started"));
		assert.equal(viewers[1]!.commands.length, 2, "on observes future attempts");
		await host.command("");
		assert.equal(host.subscribed, false, "no args toggles off");
		host.branch.splice(0, host.branch.length, { type: "custom", customType: CMUX_PANES_ENTRY_TYPE, data: { schemaVersion: 1, enabled: true } });
		await host.run("session_tree");
		assert.ok(host.subscribed); assert.equal(viewers[2]!.commands.length, 1, "tree restoration reattaches active attempts");
		await host.run("session_shutdown");
		assert.equal(host.subscribed, false);
		await host.run("session_start", { reason: "reload" });
		assert.ok(host.subscribed); assert.equal(viewers[3]!.commands.length, 1, "reload restores branch override live-only");
		await host.command("status"); assert.match(notices.at(-1)!, /on.*active/);
		await host.command("bad"); assert.match(notices.at(-1)!, /Usage:/);
		await host.run("session_shutdown");
	}
});

test("extension stays absent in children and command works outside cmux without resources", async (t) => {
	const registrations: string[] = [];
	cmuxExtension({ on: (name: string) => registrations.push(name), registerCommand: (name: string) => registrations.push(name) } as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "s", PIBOX_RUNTIME_ROLE: "subagent" }, loadDefault: () => { throw new Error("child must not load settings"); },
	});
	assert.deepEqual(registrations, []);
	const host = extensionFixture(t, { env: {}, resolveSubagents: () => { throw new Error("must not resolve"); }, createClient: () => { throw new Error("must not create"); } });
	await host.run("session_start");
	await host.command("status"); assert.match(host.notices.at(-1)!, /on.*unavailable outside cmux/);
	await host.command(""); assert.match(host.notices.at(-1)!, /off.*unavailable outside cmux/); assert.equal(host.branch.length, 1);
	assert.equal(host.viewers.length, 0);
});

test("layout reserves one third initially then halves owned panes along their longest axis", async () => {
	const { adapter, client, viewers } = await opened();
	assert.deepEqual(client.resizes[0], { paneId: "main-pane", direction: "right", amount: 200 });
	adapter.handle(event("b", "two", "attempt_started"), snapshot("b", "two"));
	await adapter.idle();
	assert.equal(client.resizes.length, 1, "agent split keeps cmux's equal halves");
	assert.match(client.log.find((line) => line.startsWith("split:down"))!, /^split:down:surface-1:/, "later split stays inside owned agent pane");
	assert.equal(client.panes.find((pane) => pane.paneId === "pane-1")!.height, 300);
	assert.equal(client.panes.find((pane) => pane.paneId === "pane-2")!.height, 300);
	adapter.handle(event("c", "three", "attempt_started"), snapshot("c", "three"));
	await adapter.idle();
	assert.equal(client.resizes.length, 1);
	assert.equal(client.panes.find((pane) => pane.paneId === "main-pane")!.width, 800, "main remains protected");
	assert.equal(client.panes.find((pane) => pane.paneId === "pane-1")!.width, 200);
	assert.equal(client.panes.find((pane) => pane.paneId === "pane-3")!.width, 200);
	assert.equal(viewers.commands.length, 3);
	assert.ok(client.log.includes("rename:surface-1:worker · Task"));
	await adapter.shutdown();
});

test("portrait layout reserves main height then halves agent width", async () => {
	const { adapter, client } = await opened(600, 1200);
	assert.deepEqual(client.resizes, [{ paneId: "main-pane", direction: "down", amount: 200 }]);
	adapter.handle(event("b", "two", "attempt_started"), snapshot("b", "two"));
	await adapter.idle();
	assert.equal(client.resizes.length, 1);
	assert.equal(client.panes.find((pane) => pane.paneId === "main-pane")!.height, 800);
	assert.equal(client.panes.find((pane) => pane.paneId === "pane-1")!.width, 300);
	assert.equal(client.panes.find((pane) => pane.paneId === "pane-2")!.width, 300);
	await adapter.shutdown();
});

test("minimum sizes use the actual half or third split for cell and pixel geometry", () => {
	const wide = pane("p", "s", 400, 200, 40, 10);
	const tall = pane("p", "s", 200, 400, 20, 10);
	assert.equal(splitIsViable(wide, "right", 3), false);
	assert.equal(splitIsViable(wide, "right", 2), true);
	assert.equal(splitIsViable(tall, "down", 3), false);
	assert.equal(splitIsViable(tall, "down", 2), true);
	const pixelWide: CmuxPane = { paneId: "p", surfaceIds: ["s"], x: 0, y: 0, width: 360, height: 180 };
	const pixelTall: CmuxPane = { ...pixelWide, width: 180, height: 200 };
	assert.equal(splitIsViable(pixelWide, "right", 3), false);
	assert.equal(splitIsViable(pixelWide, "right", 2), true);
	assert.equal(splitIsViable(pixelTall, "down", 3), false);
	assert.equal(splitIsViable(pixelTall, "down", 2), true);
});

test("layout waits through stale post-split and post-resize geometry", async () => {
	const real = new FakeCmux([pane("main-pane", "main", 1200, 600)]);
	let stale: readonly CmuxPane[] | undefined; let staleReads = 0;
	const client: CmuxClient = {
		async listPanes() { if (stale && staleReads-- > 0) return structuredClone(stale); return real.listPanes(); },
		async split(direction, source, command) { stale = structuredClone(await real.listPanes()); const result = await real.split(direction, source, command); staleReads = 2; return result; },
		async resizeSource(paneId, direction, amount) { stale = structuredClone(await real.listPanes()); await real.resizeSource(paneId, direction, amount); staleReads = 2; },
		async closeSurface(surfaceId) { await real.closeSurface(surfaceId); },
	};
	const viewers = new FakeViewers(); const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one"));
	await adapter.idle();
	assert.equal(real.resizes.length, 1);
	assert.equal(viewers.log.some((line) => line.startsWith("abandon:")), false);
	await adapter.shutdown();
});

test("layout helpers are deterministic and tiny panes are skipped", async () => {
	const left = pane("a", "owned-a", 400, 300); const right = pane("b", "owned-b", 400, 300);
	assert.equal(chooseLargestOwnedPane([right, left], new Set(["owned-a", "owned-b"]))?.paneId, "a");
	assert.equal(splitDirection(pane("p", "s", 300, 600)), "down");
	assert.equal(splitIsViable(pane("p", "s", 100, 70, 10, 4)), false);
	const client = new FakeCmux([pane("main-pane", "main", 100, 70, 10, 4)]); const viewers = new FakeViewers();
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one")); await adapter.idle();
	assert.equal(client.log.some((line) => line.startsWith("split:")), false);
	assert.ok(viewers.log.some((line) => line.startsWith("abandon:")));
	await adapter.shutdown();
});

test("adapter sends structured init, cumulative usage, sanitized text, and flushes before close", async () => {
	const sequence: string[] = []; const client = new FakeCmux([pane("main-pane", "main", 1200, 600)], sequence); const viewers = new FakeViewers(sequence);
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one")); await adapter.idle();
	adapter.handle(event("a", "one", "message_delta", { text: "ok\u001b]0;owned", secret: "never" }));
	adapter.handle(event("a", "one", "message_delta", { text: " title\u0007done\u001b[31m" }));
	adapter.handle(event("a", "one", "usage", { inputTokens: 120, outputTokens: 7, cacheReadTokens: 999 }));
	adapter.handle(event("a", "one", "tool_activity", { tool: "read\u001b[2J", active: true, args: "never" }));
	assert.equal(sanitizeTerminalText("a\u001b"), "a");
	const frames = viewers.frames.get("a\0one")!;
	assert.deepEqual(frames[0], { type: "init", title: "worker · Task" });
	assert.deepEqual(frames.find((frame) => frame.type === "usage"), { type: "usage", inputTokens: 120, outputTokens: 7 });
	assert.deepEqual(frames.find((frame) => frame.type === "notice"), { type: "notice", text: "read[2J started" });
	const output = viewers.writes.get("a\0one")!;
	assert.doesNotMatch(output, /[\u001b\u0007]|secret|args|never/);
	adapter.handle(event("a", "one", "output_drained"));
	adapter.handle(event("a", "one", "terminal", { status: "completed", reportPath: "/private/report" }));
	await adapter.idle();
	assert.deepEqual(sequence.slice(-2), ["flush:a\0one", "close:surface-1"]);
	assert.equal(viewers.frames.get("a\0one")!.at(-1)?.type, "status");
	assert.doesNotMatch(JSON.stringify(viewers.frames.get("a\0one")), /report/);
	await adapter.shutdown();
});

test("seed sends cumulative usage and leaves missing usage unknown", async () => {
	const client = new FakeCmux([pane("main-pane", "main", 1200, 600)]); const viewers = new FakeViewers();
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.seed([
		{ ...snapshot("a", "one"), progress: { startedAt: "2026-01-01T00:00:00Z", lastEventAt: "2026-01-01T00:00:01Z", turns: 2, toolCalls: 0, toolErrors: 0, inputTokens: 55, outputTokens: 8, reasoningTokens: 0 } },
		snapshot("b", "two"),
	]);
	await adapter.idle();
	assert.deepEqual(viewers.frames.get("a\0one")?.find((frame) => frame.type === "usage"), { type: "usage", inputTokens: 55, outputTokens: 8 });
	assert.equal(viewers.frames.get("b\0two")?.some((frame) => frame.type === "usage"), false);
	await adapter.shutdown();
});

test("rich display frames are ephemeral and suppress compact tool summaries after ready", async () => {
	const { adapter, viewers } = await opened();
	const key = "a\0one";
	adapter.handle(event("a", "one", "tool_activity", { tool: "read", active: true }));
	adapter.handleDisplay(displayEvent("a", "one", { type: "display_ready" }));
	adapter.handleDisplay(displayEvent("a", "one", { type: "tool_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } }));
	adapter.handle(event("a", "one", "tool_activity", { tool: "read", active: false }));
	const frames = viewers.frames.get(key)!;
	assert.equal(frames.filter((frame) => frame.type === "notice").length, 1);
	assert.deepEqual(frames.filter((frame) => frame.type === "display").map((frame) => frame.frame.type), ["display_ready", "tool_start"]);
	await adapter.shutdown();
});

test("viewer and tab title stay meaningful and bounded; rename failure is harmless", async () => {
	const client = new FakeCmux([pane("main-pane", "main", 1200, 600)]);
	const viewers = new FakeViewers();
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one", `Task ${"🙂".repeat(100_000)}`));
	await assert.doesNotReject(adapter.idle());
	const title = (viewers.frames.get("a\0one")?.[0] as Extract<ViewerFrame, { type: "init" }>).title;
	assert.equal(Array.from(title).length, 80);
	assert.equal(client.log.includes(`rename:surface-1:${title}`), true);
	assert.equal(viewers.log.some((line) => line.startsWith("abandon:")), false);
	await adapter.shutdown();

	const failingClient = new FakeCmux([pane("main-pane", "main", 1200, 600)]);
	failingClient.renameTab = async () => { throw new Error("rename denied"); };
	const failingAdapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client: failingClient, viewers: new FakeViewers() });
	failingAdapter.handle(event("b", "two", "attempt_started"), snapshot("b", "two"));
	await assert.doesNotReject(failingAdapter.idle());
	await failingAdapter.shutdown();
});

test("cmux failures omit viewer without escaping into agent lifecycle", async () => {
	const viewers = new FakeViewers();
	const client: CmuxClient = {
		async listPanes() { return [pane("main-pane", "main", 1200, 600)]; },
		async split() { throw new Error("cmux unavailable"); },
		async resizeSource() { throw new Error("unexpected"); },
		async closeSurface() {},
	};
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one"));
	await assert.doesNotReject(adapter.idle());
	assert.ok(viewers.log.some((line) => line.startsWith("abandon:")));
	await adapter.shutdown();
});

test("user close never reopens same attempt; continuation gets a fresh pane", async () => {
	const { adapter, viewers } = await opened();
	viewers.userClose("a\0one");
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one"));
	adapter.handle(event("a", "one", "message_delta", { text: "hidden" }));
	assert.equal(viewers.commands.length, 1);
	assert.doesNotMatch(viewers.writes.get("a\0one") ?? "", /hidden/);
	adapter.handle(event("a", "two", "attempt_started"), snapshot("a", "two"));
	await adapter.idle();
	assert.equal(viewers.commands.length, 2);
	await adapter.shutdown();
});

test("rich observer is capability-gated, metadata inspect runs only at attempt start, and cleanup unsubscribes", async (t) => {
	let compactListener: ((event: SubagentEvent) => void) | undefined;
	let richListener: ((event: SubagentDisplayEvent) => void) | undefined;
	let inspectCount = 0; let richUnsubscribed = false;
	const host = extensionFixture(t, {}, {
		inspect: () => { inspectCount++; return [snapshot("a", "one")]; },
		replay: () => ({ snapshot: { owner, cursor: 0, agents: [] }, events: [], reset: false }),
		subscribe: (_owner: RuntimeOwner, _cursor: number, listener: (event: SubagentEvent) => void) => { compactListener = listener; return { initial: { snapshot: { owner, cursor: 0, agents: [] }, events: [], reset: false }, unsubscribe() { compactListener = undefined; } }; },
		subscribeDisplay: (_owner: RuntimeOwner, listener: (event: SubagentDisplayEvent) => void) => { richListener = listener; return { unsubscribe() { richListener = undefined; richUnsubscribed = true; } }; },
	});
	await host.run("session_start");
	compactListener!(event("a", "one", "attempt_started"));
	compactListener!(event("a", "one", "message_delta", { text: "one" }));
	compactListener!(event("a", "one", "message_delta", { text: "two" }));
	richListener!(displayEvent("a", "one", { type: "display_ready" }));
	assert.equal(inspectCount, 1);
	assert.equal(host.viewers[0]!.frames.get("a\0one")?.some((frame) => frame.type === "display"), true);
	await host.run("session_shutdown");
	assert.equal(compactListener, undefined); assert.equal(richListener, undefined); assert.equal(richUnsubscribed, true);
});

test("failed cmux probe does not attach rich observer or create viewer", async (t) => {
	let subscribed = false;
	const host = extensionFixture(t, {
		createClient: () => ({ listPanes: async () => { throw new Error("cmux missing"); } }) as unknown as CmuxClient,
	}, { subscribeDisplay: () => { subscribed = true; return { unsubscribe() {} }; } });
	await host.run("session_start");
	assert.equal(subscribed, false); assert.equal(host.viewers.length, 0);
});

test("disable fences delayed startup and disposes its transport", async (t) => {
	let resolveViewer!: (viewer: ViewerTransport) => void; let reachedViewer!: () => void; let subscribed = false;
	const pendingViewer = new Promise<ViewerTransport>((resolve) => { resolveViewer = resolve; });
	const creatingViewer = new Promise<void>((resolve) => { reachedViewer = resolve; });
	const viewer = new FakeViewers();
	const host = extensionFixture(t, { createViewers: () => { reachedViewer(); return pendingViewer; } }, {
		subscribeDisplay: () => { subscribed = true; return { unsubscribe() {} }; },
	});
	const starting = host.run("session_start");
	try {
		await withTimeout(creatingViewer);
		await host.command("off");
	} finally { resolveViewer(viewer); await starting; }
	assert.equal(subscribed, false); assert.ok(viewer.log.includes("shutdown"));
});

test("startup failure shuts transport down and current-cursor handshake replays only initial memory events", async (t) => {
	const failed = extensionFixture(t, {}, { subscribe: () => { throw new Error("activation ended"); } });
	await failed.run("session_start");
	assert.ok(failed.viewers[0]!.log.includes("shutdown"));

	const initial = [event("a", "one", "attempt_started"), event("a", "one", "message_delta", { text: "atomic" })];
	let subscribedAt = -1;
	const host = extensionFixture(t, {}, {
		replay: (_owner: RuntimeOwner, cursor?: number) => {
			assert.equal(cursor, undefined, "only current in-memory cursor requested");
			return { snapshot: { owner, cursor: 9, agents: [] }, events: [], reset: false };
		},
		subscribe: (_owner: RuntimeOwner, cursor: number) => {
			subscribedAt = cursor;
			return { initial: { snapshot: { owner, cursor: 9, agents: [] }, events: initial, reset: false }, unsubscribe() {} };
		},
	});
	await host.run("session_start");
	assert.equal(subscribedAt, 9); assert.match(host.viewers[0]!.writes.get("a\0one")!, /atomic/);
});

test("failed surface close remains owned and retries during shutdown", async () => {
	const real = new FakeCmux([pane("main-pane", "main", 1200, 600)]);
	let closes = 0;
	const client: CmuxClient = {
		listPanes: () => real.listPanes(), split: (direction, source, command) => real.split(direction, source, command),
		resizeSource: (paneId, direction, amount) => real.resizeSource(paneId, direction, amount),
		async closeSurface(surfaceId) { if (++closes === 1) throw new Error("transient"); await real.closeSurface(surfaceId); },
	};
	const viewers = new FakeViewers();
	const adapter = new CmuxPaneAdapter({ mainSurfaceId: "main", client, viewers });
	adapter.handle(event("a", "one", "attempt_started"), snapshot("a", "one"));
	await adapter.idle();
	viewers.userClose("a\0one");
	await adapter.idle();
	assert.equal(real.panes.some((candidate) => candidate.surfaceIds.includes("surface-1")), true);
	await adapter.shutdown();
	assert.equal(closes, 2);
	assert.equal(real.panes.some((candidate) => candidate.surfaceIds.includes("surface-1")), false);
});

test("socket transport waits for viewer, flushes before close, force-closes malformed clients, and removes files", async (t) => {
	const { transport, connectSocket } = await socketFixture(t);
	const command = transport.command("attempt", () => assert.fail("unexpected close"));
	const [, , socketPath, token] = commandParts(command);
	assert.ok(socketPath && token);
	transport.write("attempt", "first 🪨 last");
	const close = transport.close("attempt");
	const viewer = connectSocket(socketPath!);
	await once(viewer, "connect");
	const frames = receiveFrames(viewer, (frame) => { if (frame.type === "close") viewer.write(`${JSON.stringify({ type: "drained" })}\n`); });
	viewer.write(`${JSON.stringify({ type: "hello", token })}\n`);
	await withTimeout(close);
	assert.deepEqual(frames.map((frame) => frame.type), ["text", "close"]);
	assert.deepEqual(frames[0], { type: "text", text: "first 🪨 last" });

	const hangingCommand = transport.command("hanging", () => undefined);
	const hangingToken = commandParts(hangingCommand)[3]!;
	const hanging = connectSocket(socketPath!, true);
	hanging.setEncoding("utf8");
	await once(hanging, "connect");
	hanging.write(`${JSON.stringify({ type: "hello", token: hangingToken })}\n`);
	hanging.on("data", (chunk) => { if (chunk.includes('"close"')) hanging.write(`${JSON.stringify({ type: "drained" })}\n`); });
	await withTimeout(transport.close("hanging"), 1_000);
	hanging.destroy();

	const budgetCommand = transport.command("budget", () => undefined);
	const budgetToken = commandParts(budgetCommand)[3]!;
	const initialText = "a".repeat(60 * 1024); const laterText = "b".repeat(8 * 1024);
	transport.write("budget", initialText);
	const budgetViewer = connectSocket(socketPath!);
	await once(budgetViewer, "connect");
	let receivedLength = 0;
	let budgetFrames: ViewerFrame[] = [];
	const received = new Promise<void>((resolve) => {
		budgetFrames = receiveFrames(budgetViewer, (frame) => {
			if (frame.type === "text") receivedLength += frame.text.length;
			if (receivedLength === initialText.length) setImmediate(() => transport.write("budget", laterText));
			if (receivedLength === initialText.length + laterText.length) resolve();
		});
	});
	budgetViewer.write(`${JSON.stringify({ type: "hello", token: budgetToken })}\n`);
	await withTimeout(received);
	assert.equal(budgetFrames.filter((frame) => frame.type === "text").map((frame) => frame.text).join(""), initialText + laterText);
	assert.ok(budgetFrames.every((frame) => Buffer.byteLength(`${JSON.stringify(frame)}\n`) <= 16 * 1024));
	transport.abandon("budget");

	const invalid = connectSocket(socketPath!);
	await once(invalid, "connect");
	const invalidClosed = once(invalid, "close");
	invalid.write("null\n");
	await withTimeout(invalidClosed);

	const malformed = connectSocket(socketPath!);
	await once(malformed, "connect");
	const malformedClosed = once(malformed, "close");
	await withTimeout(transport.shutdown());
	await withTimeout(malformedClosed);
	await assert.rejects(access(socketPath!));
});

test("socket queue coalesces headers, marks dropped detail, preserves orphan tool end, and closes last", async (t) => {
	const { transport, connectSocket } = await socketFixture(t);
	const command = transport.command("queued", () => undefined);
	const [, , socketPath, token] = commandParts(command);
	transport.send("queued", { type: "init", title: "old" });
	const latestTitle = `latest ${"🙂".repeat(100_000)}`;
	transport.send("queued", { type: "init", title: latestTitle });
	transport.send("queued", { type: "usage", inputTokens: 1 });
	transport.send("queued", { type: "usage", inputTokens: 9, outputTokens: 4 });
	transport.send("queued", { type: "status", text: "starting" });
	transport.send("queued", { type: "status", text: "running" });
	transport.send("queued", { type: "display", frame: { type: "tool_start", toolCallId: "orphan", toolName: "read", argsText: "x".repeat(12 * 1024) } });
	transport.send("queued", { type: "text", text: "y".repeat(60 * 1024) });
	transport.send("queued", { type: "display", frame: { type: "tool_end", toolCallId: "orphan", toolName: "read", text: "done", isError: false } });
	const viewer = connectSocket(socketPath!);
	await once(viewer, "connect");
	const frames = receiveFrames(viewer, (frame) => { if (frame.type === "close") viewer.write(`${JSON.stringify({ type: "drained" })}\n`); });
	viewer.write(`${JSON.stringify({ type: "hello", token })}\n`);
	await withTimeout(transport.close("queued"));
	const init = frames.find((frame) => frame.type === "init") as Extract<ViewerFrame, { type: "init" }>;
	assert.equal(init.title, Array.from(latestTitle).slice(0, 80).join(""));
	assert.ok(Buffer.byteLength(`${JSON.stringify(init)}\n`) <= 16 * 1024);
	assert.deepEqual(frames.find((frame) => frame.type === "usage"), { type: "usage", inputTokens: 9, outputTokens: 4 });
	assert.deepEqual(frames.find((frame) => frame.type === "status"), { type: "status", text: "running" });
	assert.equal(frames.some((frame) => frame.type === "notice" && /omitted/.test(frame.text)), true);
	assert.equal(frames.some((frame) => frame.type === "display" && frame.frame.type === "tool_end"), true);
	assert.equal(frames.at(-1)?.type, "close");
});

test("socket listen failure removes temporary directory", { concurrency: false }, async () => {
	const root = join(tmpdir(), "pibox-cmux-long-" + "x".repeat(110));
	await mkdir(root, { recursive: true });
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = root;
	try {
		await assert.rejects(SocketViewerTransport.create());
		assert.deepEqual(await readdir(root), []);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("real viewer preserves split UTF-8, escaped framed output, drains paused stdout, and exits cleanly", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pibox-viewer-test-"));
	const socketPath = join(directory, "viewer.sock"); const server = createServer();
	let socket: Socket | undefined; let child: ReturnType<typeof spawn> | undefined; let exited: Promise<unknown> | undefined;
	const cleanup = async () => {
		child?.kill("SIGKILL"); socket?.destroy();
		try { if (exited) await withTimeout(exited); }
		finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	};
	t.after(cleanup);
	server.on("connection", (value) => { socket = value; });
	const listening = once(server, "listening"); server.listen(socketPath); await withTimeout(listening);
	const connected = once(server, "connection");
	child = spawn(process.execPath, [new URL("../viewer.mjs", import.meta.url).pathname, socketPath, "token"], { stdio: ["ignore", "pipe", "ignore"] });
	exited = once(child, "close");
	let resolveFirst!: () => void; const firstOutput = new Promise<void>((resolve) => { resolveFirst = resolve; });
	let output = ""; child.stdout!.setEncoding("utf8"); child.stdout!.on("data", (chunk) => { output += chunk; if (output.length >= "A🪨B".length) resolveFirst(); });
	await withTimeout(connected);
	const replies = createInterface({ input: socket! }); t.after(() => replies.close());
	const [hello] = await withTimeout(once(replies, "line"));
	assert.deepEqual(JSON.parse(hello), { type: "hello", token: "token" });
	const unicode = Buffer.from(`${JSON.stringify({ type: "text", text: "A🪨B" })}\n`);
	const split = unicode.indexOf(Buffer.from("🪨")) + 2;
	await withTimeout(new Promise<void>((resolve) => socket!.write(unicode.subarray(0, split), () => resolve())));
	socket!.write(unicode.subarray(split));
	await withTimeout(firstOutput);
	assert.equal(output, "A🪨B");
	child.stdout!.pause();
	const payload = "🙂\\\tline\n".repeat(512); const frames = 64;
	const drained = once(replies, "line");
	for (let index = 0; index < frames; index++) {
		socket!.write(`${JSON.stringify({ type: "text", text: payload })}\n`, index === 0 ? () => child!.stdout!.resume() : undefined);
	}
	socket!.write(`${JSON.stringify({ type: "close" })}\n`);
	const [ack] = await withTimeout(drained, 5_000);
	assert.deepEqual(JSON.parse(ack), { type: "drained" });
	socket!.end();
	assert.deepEqual(await withTimeout(exited), [0, null]);
	assert.equal(output, "A🪨B" + payload.repeat(frames));
	await cleanup();
	await assert.rejects(access(directory));
});
