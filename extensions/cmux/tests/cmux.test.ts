import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import cmuxExtension from "../index.js";
import { CmuxPaneAdapter, SocketViewerTransport, chooseLargestOwnedPane, sanitizeTerminalText, splitDirection, splitIsViable, type CmuxClient, type CmuxPane, type ViewerFrame, type ViewerTransport } from "../cmux.js";
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

async function withTimeout<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
	let timer: NodeJS.Timeout;
	try {
		return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("test timeout")), milliseconds); })]);
	} finally {
		clearTimeout(timer!);
	}
}

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

test("extension silently no-ops outside cmux and observes service without child controls", async () => {
	for (const env of [{}, { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "s", PIBOX_CMUX_PANES: "0" }, { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "s", PIBOX_RUNTIME_ROLE: "subagent" }]) {
		const noOpHandlers = new Map<string, unknown>();
		cmuxExtension({ on: (name: string, handler: unknown) => noOpHandlers.set(name, handler) } as unknown as ExtensionAPI, { env });
		assert.equal(noOpHandlers.size, 0);
	}
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const pi = { on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	const active = snapshot("a", "one");
	let listener: ((event: SubagentEvent) => void) | undefined;
	const forbidden = () => { throw new Error("child control called"); };
	const service = {
		owner, protocolVersion: 1, launch: forbidden, continue: forbidden, wait: forbidden, stop: forbidden, release: forbidden, teardown: forbidden,
		inspect: () => [active], replay: () => ({ snapshot: { owner, cursor: 0, agents: [active] }, events: [], reset: false }),
		subscribe: (_owner: RuntimeOwner, _cursor: number, callback: (value: SubagentEvent) => void) => { listener = callback; return { initial: { snapshot: { owner, cursor: 0, agents: [active] }, events: [], reset: false }, unsubscribe() { listener = undefined; } }; },
	} as unknown as SubagentService;
	const viewers: FakeViewers[] = []; const clients: FakeCmux[] = [];
	cmuxExtension(pi, {
		env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main" }, resolveSubagents: () => ({ owner, protocolVersion: 1, service }),
		createClient: () => { const value = new FakeCmux([pane("main-pane", "main", 1200, 600)]); clients.push(value); return value; },
		createViewers: async () => { const value = new FakeViewers(); viewers.push(value); return value; },
	});
	const ctx = { sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	assert.ok(listener);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(viewers[0]!.frames.get("a\0one")?.[0], { type: "init", title: "worker · Task", limited: true });
	await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
	assert.equal(listener, undefined);
	assert.ok(viewers[0]!.log.includes("shutdown"));
	await handlers.get("session_start")!({ reason: "reload" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(viewers.length, 2);
	assert.deepEqual(viewers.map((viewer) => viewer.commands.length), [1, 1], "reload closes and rebinds active attempts live-only");
	await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
});

test("rich observer is capability-gated, metadata inspect runs only at attempt start, and cleanup unsubscribes", async () => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let compactListener: ((event: SubagentEvent) => void) | undefined;
	let richListener: ((event: SubagentDisplayEvent) => void) | undefined;
	let inspectCount = 0; let richUnsubscribed = false;
	const service = {
		owner, protocolVersion: 1,
		inspect: () => { inspectCount++; return [snapshot("a", "one")]; },
		replay: () => ({ snapshot: { owner, cursor: 0, agents: [] }, events: [], reset: false }),
		subscribe: (_owner: RuntimeOwner, _cursor: number, listener: (event: SubagentEvent) => void) => { compactListener = listener; return { initial: { snapshot: { owner, cursor: 0, agents: [] }, events: [], reset: false }, unsubscribe() { compactListener = undefined; } }; },
		subscribeDisplay: (_owner: RuntimeOwner, listener: (event: SubagentDisplayEvent) => void) => { richListener = listener; return { unsubscribe() { richListener = undefined; richUnsubscribed = true; } }; },
	} as unknown as SubagentService;
	const viewers = new FakeViewers();
	cmuxExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main" }, resolveSubagents: () => ({ owner, protocolVersion: 1, service }),
		createViewers: async () => viewers, createClient: () => new FakeCmux([pane("main-pane", "main", 1200, 600)]),
	});
	const ctx = { sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	compactListener!(event("a", "one", "attempt_started"));
	compactListener!(event("a", "one", "message_delta", { text: "one" }));
	compactListener!(event("a", "one", "message_delta", { text: "two" }));
	richListener!(displayEvent("a", "one", { type: "display_ready" }));
	assert.equal(inspectCount, 1);
	assert.equal(viewers.frames.get("a\0one")?.some((frame) => frame.type === "display"), true);
	await handlers.get("session_shutdown")!({}, ctx);
	assert.equal(richUnsubscribed, true);
});

test("failed cmux probe does not attach rich observer or create viewer", async () => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let subscribed = false; let viewerCreated = false;
	const service = { owner, protocolVersion: 1, subscribeDisplay: () => { subscribed = true; return { unsubscribe() {} }; } } as unknown as SubagentService;
	cmuxExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "stale", CMUX_SURFACE_ID: "missing" }, resolveSubagents: () => ({ owner, protocolVersion: 1, service }),
		createClient: () => ({ listPanes: async () => { throw new Error("cmux missing"); } }) as unknown as CmuxClient,
		createViewers: async () => { viewerCreated = true; return new FakeViewers(); },
	});
	await handlers.get("session_start")!({}, { sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext);
	assert.equal(subscribed, false);
	assert.equal(viewerCreated, false);
});

test("shutdown fences delayed startup and disposes its transport", async () => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let resolveViewer!: (viewer: ViewerTransport) => void; let subscribed = false;
	const pendingViewer = new Promise<ViewerTransport>((resolve) => { resolveViewer = resolve; });
	const service = { owner, protocolVersion: 1, subscribeDisplay: () => { subscribed = true; return { unsubscribe() {} }; } } as unknown as SubagentService;
	const viewer = new FakeViewers();
	cmuxExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main" }, resolveSubagents: () => ({ owner, protocolVersion: 1, service }),
		createClient: () => new FakeCmux([pane("main-pane", "main", 1200, 600)]), createViewers: () => pendingViewer,
	});
	const ctx = { sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	const starting = handlers.get("session_start")!({}, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await handlers.get("session_shutdown")!({}, ctx);
	resolveViewer(viewer);
	await starting;
	assert.equal(subscribed, false);
	assert.ok(viewer.log.includes("shutdown"));
});

test("startup failure shuts transport down and current-cursor handshake replays only initial memory events", async () => {
	const ctx = { sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	const failedHandlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const failedViewer = new FakeViewers();
	cmuxExtension({ on: (name: string, handler: any) => failedHandlers.set(name, handler) } as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main" },
		resolveSubagents: () => ({ owner, protocolVersion: 1, service: {
			replay: () => ({ snapshot: { owner, cursor: 7, agents: [] }, events: [], reset: false }),
			subscribe: () => { throw new Error("activation ended"); },
		} as unknown as SubagentService }),
		createViewers: async () => failedViewer,
		createClient: () => new FakeCmux([pane("main-pane", "main", 1200, 600)]),
	});
	await failedHandlers.get("session_start")!({}, ctx);
	assert.ok(failedViewer.log.includes("shutdown"));

	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const active = snapshot("a", "one");
	const initial = [event("a", "one", "attempt_started"), event("a", "one", "message_delta", { text: "atomic" })];
	let subscribedAt = -1;
	const service = {
		owner, protocolVersion: 1, inspect: () => [active],
		replay: (_owner: RuntimeOwner, cursor?: number) => {
			assert.equal(cursor, undefined, "only current in-memory cursor requested");
			return { snapshot: { owner, cursor: 9, agents: [] }, events: [], reset: false };
		},
		subscribe: (_owner: RuntimeOwner, cursor: number) => {
			subscribedAt = cursor;
			return { initial: { snapshot: { owner, cursor: 9, agents: [] }, events: initial, reset: false }, unsubscribe() {} };
		},
	} as unknown as SubagentService;
	const viewers = new FakeViewers();
	cmuxExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI, {
		env: { CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "main" },
		resolveSubagents: () => ({ owner, protocolVersion: 1, service }), createViewers: async () => viewers,
		createClient: () => new FakeCmux([pane("main-pane", "main", 1200, 600)]),
	});
	await handlers.get("session_start")!({}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(subscribedAt, 9);
	assert.match(viewers.writes.get("a\0one")!, /atomic/);
	await handlers.get("session_shutdown")!({}, ctx);
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

test("socket transport waits for viewer, flushes before close, force-closes malformed clients, and removes files", async () => {
	const transport = await SocketViewerTransport.create();
	const command = transport.command("attempt", () => assert.fail("unexpected close"));
	const [, , socketPath, token] = commandParts(command);
	assert.ok(socketPath && token);
	transport.write("attempt", "first 🪨 last");
	const close = transport.close("attempt");
	await new Promise((resolve) => setTimeout(resolve, 20));
	const viewer = connect(socketPath!);
	viewer.setEncoding("utf8");
	await once(viewer, "connect");
	viewer.write(`${JSON.stringify({ type: "hello", token })}\n`);
	let input = ""; const frames: any[] = [];
	viewer.on("data", (chunk) => {
		input += chunk;
		for (;;) {
			const end = input.indexOf("\n"); if (end < 0) break;
			const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1); frames.push(frame);
			if (frame.type === "close") viewer.write(`${JSON.stringify({ type: "drained" })}\n`);
		}
	});
	await withTimeout(close);
	assert.deepEqual(frames.map((frame) => frame.type), ["text", "close"]);
	assert.equal(frames[0].text, "first 🪨 last");

	const hangingCommand = transport.command("hanging", () => undefined);
	const hangingToken = commandParts(hangingCommand)[3]!;
	const hanging = connect({ path: socketPath!, allowHalfOpen: true });
	hanging.setEncoding("utf8");
	await once(hanging, "connect");
	hanging.write(`${JSON.stringify({ type: "hello", token: hangingToken })}\n`);
	hanging.on("data", (chunk) => { if (chunk.includes('"close"')) hanging.write(`${JSON.stringify({ type: "drained" })}\n`); });
	const started = Date.now();
	await withTimeout(transport.close("hanging"), 1_000);
	assert.ok(Date.now() - started < 1_000, "half-open viewer close is bounded");
	hanging.destroy();

	const budgetCommand = transport.command("budget", () => undefined);
	const budgetToken = commandParts(budgetCommand)[3]!;
	const initialText = "a".repeat(60 * 1024); const laterText = "b".repeat(8 * 1024);
	transport.write("budget", initialText);
	const budgetViewer = connect(socketPath!);
	budgetViewer.setEncoding("utf8");
	await once(budgetViewer, "connect");
	let budgetInput = ""; const budgetFrames: any[] = [];
	const received = new Promise<void>((resolve) => budgetViewer.on("data", (chunk) => {
		budgetInput += chunk;
		for (;;) {
			const end = budgetInput.indexOf("\n"); if (end < 0) break;
			budgetFrames.push(JSON.parse(budgetInput.slice(0, end))); budgetInput = budgetInput.slice(end + 1);
			const receivedLength = budgetFrames.reduce((total, frame) => total + (frame.type === "text" ? frame.text.length : 0), 0);
			if (receivedLength === initialText.length) setImmediate(() => transport.write("budget", laterText));
			if (receivedLength === initialText.length + laterText.length) resolve();
		}
	}));
	budgetViewer.write(`${JSON.stringify({ type: "hello", token: budgetToken })}\n`);
	await withTimeout(received);
	assert.equal(budgetFrames.filter((frame) => frame.type === "text").map((frame) => frame.text).join(""), initialText + laterText);
	assert.ok(budgetFrames.every((frame) => Buffer.byteLength(`${JSON.stringify(frame)}\n`) <= 16 * 1024));
	transport.abandon("budget");

	const invalid = connect(socketPath!);
	await once(invalid, "connect");
	const invalidClosed = once(invalid, "close");
	invalid.write("null\n");
	await withTimeout(invalidClosed);

	const malformed = connect(socketPath!);
	await once(malformed, "connect");
	const malformedClosed = once(malformed, "close");
	await withTimeout(transport.shutdown());
	await withTimeout(malformedClosed);
	await assert.rejects(access(socketPath!));
});

test("socket queue coalesces headers, marks dropped detail, preserves orphan tool end, and closes last", async () => {
	const transport = await SocketViewerTransport.create();
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
	const viewer = connect(socketPath!); viewer.setEncoding("utf8");
	await once(viewer, "connect");
	let input = ""; const frames: ViewerFrame[] = [];
	viewer.on("data", (chunk) => {
		input += chunk;
		for (;;) {
			const end = input.indexOf("\n"); if (end < 0) break;
			const frame = JSON.parse(input.slice(0, end)) as ViewerFrame; input = input.slice(end + 1); frames.push(frame);
			if (frame.type === "close") viewer.write(`${JSON.stringify({ type: "drained" })}\n`);
		}
	});
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
	await transport.shutdown();
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

test("delayed real viewer accepts framed multibyte escaped text under stdout backpressure", async () => {
	const transport = await SocketViewerTransport.create();
	let unexpectedlyClosed = false;
	const command = transport.command("real", () => { unexpectedlyClosed = true; });
	const parts = commandParts(command);
	const text = `begin\n${"🙂\\\tline\n".repeat(4_000)}end`;
	transport.write("real", text);
	await new Promise((resolve) => setTimeout(resolve, 30));
	const child = spawn(parts[0]!, parts.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
	child.stdout!.pause();
	let output = "";
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk) => { output += chunk; });
	await new Promise((resolve) => setTimeout(resolve, 30));
	child.stdout!.resume();
	await withTimeout(new Promise<void>((resolve) => {
		const timer = setInterval(() => { if (output.length === text.length) { clearInterval(timer); resolve(); } }, 5);
	}), 5_000);
	assert.equal(output, text);
	await withTimeout(transport.close("real"));
	await withTimeout(once(child, "close").then(() => undefined));
	assert.equal(unexpectedlyClosed, false);
	await transport.shutdown();
});

test("real viewer preserves split UTF-8 and applies stdout backpressure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pibox-viewer-test-"));
	const socketPath = join(directory, "viewer.sock");
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const viewerPath = new URL("../viewer.mjs", import.meta.url);
	const child = spawn(process.execPath, [viewerPath.pathname, socketPath, "token"], { stdio: ["ignore", "pipe", "ignore"] });
	let socket: Socket | undefined;
	let clientInput = "";
	const connected = new Promise<void>((resolve) => server.once("connection", (value) => {
		socket = value; value.setEncoding("utf8");
		value.on("data", (chunk) => { clientInput += chunk; if (clientInput.includes('"drained"')) value.end(); }); resolve();
	}));
	try {
		await withTimeout(connected);
		while (!clientInput.includes("\n")) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(JSON.parse(clientInput.slice(0, clientInput.indexOf("\n"))), { type: "hello", token: "token" });
		const unicode = Buffer.from(`${JSON.stringify({ type: "text", text: "A🪨B" })}\n`);
		const split = unicode.indexOf(Buffer.from("🪨")) + 2;
		socket!.write(unicode.subarray(0, split));
		socket!.write(unicode.subarray(split));
		const payload = "x".repeat(8 * 1024);
		let backpressured = false; const frames = 64;
		for (let index = 0; index < frames; index++) {
			const accepted = socket!.write(`${JSON.stringify({ type: "text", text: payload })}\n`);
			backpressured ||= !accepted;
		}
		assert.equal(backpressured, true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		let output = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk) => { output += chunk; });
		const expectedLength = "A🪨B".length + payload.length * frames;
		await withTimeout(new Promise<void>((resolve) => {
			const timer = setInterval(() => { if (output.length === expectedLength) { clearInterval(timer); resolve(); } }, 5);
		}), 5_000);
		assert.ok(output.startsWith("A🪨B"));
		assert.equal(output.length, expectedLength);
	} finally {
		child.kill(); socket?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
