import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LogicalAgentSnapshot, SubagentEvent } from "../subagent/api.js";
import type { SubagentDisplayEvent, SubagentDisplayFrame } from "../subagent/display.js";
import { shortSubagentTitle } from "../subagent/presentation.js";

const ACTIVE_STATES = new Set(["launching", "running", "stopping"]);
const MAX_CHANNEL_BYTES = 64 * 1024;
const MAX_VIEWER_FRAME_BYTES = 16 * 1024;
const CLI_TIMEOUT_MS = 750;
const UI_READY_MS = 1_500;
const VIEWER_CONNECT_MS = 4_000;
const VIEWER_DRAIN_MS = 300;

export interface CmuxPane {
	readonly paneId: string;
	readonly surfaceIds: readonly string[];
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly columns?: number;
	readonly rows?: number;
	readonly cellWidth?: number;
	readonly cellHeight?: number;
}

export interface CmuxSplit {
	readonly paneId: string;
	readonly surfaceId: string;
}

export interface CmuxClient {
	listPanes(): Promise<readonly CmuxPane[]>;
	split(direction: "right" | "down", sourceSurfaceId: string, command: string): Promise<CmuxSplit>;
	resizeSource(paneId: string, direction: "right" | "down", amount: number): Promise<void>;
	closeSurface(surfaceId: string): Promise<void>;
	renameTab?(surfaceId: string, title: string): Promise<void>;
}

export type ViewerFrame =
	| { type: "init"; title: string; cwd?: string; limited?: boolean }
	| { type: "usage"; inputTokens?: number; outputTokens?: number }
	| { type: "status"; text: string }
	| { type: "text"; text: string }
	| { type: "display"; frame: SubagentDisplayFrame }
	| { type: "notice"; text: string }
	| { type: "close" };

export interface ViewerTransport {
	command(key: string, onUnexpectedClose: () => void): string;
	send(key: string, frame: ViewerFrame): void;
	write(key: string, text: string): void;
	close(key: string): Promise<void>;
	abandon(key: string): void;
	shutdown(): Promise<void>;
}

export interface CmuxPaneAdapterOptions {
	readonly mainSurfaceId: string;
	readonly client: CmuxClient;
	readonly viewers: ViewerTransport;
	readonly limited?: boolean;
}

interface AttemptView {
	readonly key: string;
	readonly agentId: string;
	readonly attemptId: string;
	paneId?: string;
	surfaceId?: string;
	opening: boolean;
	terminal: boolean;
	drained: boolean;
	userClosed: boolean;
	richReady: boolean;
	readonly title: string;
}

/** Plain terminal text only. Removing every control introducer makes chunk boundaries irrelevant. */
export function sanitizeTerminalText(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function splitDirection(pane: CmuxPane): "right" | "down" {
	return pane.width >= pane.height ? "right" : "down";
}

export function splitIsViable(pane: CmuxPane, direction = splitDirection(pane), divisor: 2 | 3 = 3): boolean {
	if (direction === "right") {
		if (pane.columns !== undefined && pane.rows !== undefined) return Math.floor(pane.columns / divisor) >= 20 && pane.rows >= 5;
		return pane.width / divisor >= 160 && pane.height >= 80;
	}
	if (pane.columns !== undefined && pane.rows !== undefined) return Math.floor(pane.rows / divisor) >= 5 && pane.columns >= 20;
	return pane.height / divisor >= 80 && pane.width >= 160;
}

export function chooseLargestOwnedPane(panes: readonly CmuxPane[], ownedSurfaceIds: ReadonlySet<string>): CmuxPane | undefined {
	return panes
		.filter((pane) => pane.surfaceIds.some((id) => ownedSurfaceIds.has(id)))
		.sort((left, right) => right.width * right.height - left.width * left.height || left.paneId.localeCompare(right.paneId))[0];
}

export class CmuxPaneAdapter {
	private readonly attempts = new Map<string, AttemptView>();
	private readonly ownedSurfaceIds = new Set<string>();
	private readonly pendingClosures = new Set<string>();
	private queue = Promise.resolve();
	private closed = false;

	constructor(private readonly options: CmuxPaneAdapterOptions) {}

	seed(agents: readonly LogicalAgentSnapshot[]): void {
		for (const agent of [...agents].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.handle.agentId.localeCompare(b.handle.agentId))) {
			if (agent.attemptId && ACTIVE_STATES.has(agent.state)) this.ensureAttempt(agent.handle.agentId, agent.attemptId, agent, true);
		}
	}

	handle(event: SubagentEvent, snapshot?: LogicalAgentSnapshot): void {
		if (this.closed) return;
		const key = attemptKey(event.agentId, event.attemptId);
		if (event.type === "attempt_started") this.ensureAttempt(event.agentId, event.attemptId, snapshot);
		const view = this.attempts.get(key);
		if (!view || view.userClosed) return;
		if (event.type === "message_delta" && typeof event.data?.text === "string") {
			this.options.viewers.send(key, { type: "text", text: sanitizeTerminalText(event.data.text) });
		} else if (event.type === "usage") {
			const inputTokens = count(event.data?.inputTokens);
			const outputTokens = count(event.data?.outputTokens);
			this.options.viewers.send(key, { type: "usage", ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) });
		} else if (event.type === "tool_activity" && !view.richReady) {
			const tool = typeof event.data?.tool === "string" ? sanitizeTerminalText(event.data.tool) : "tool";
			const state = event.data?.active === true ? "started" : "finished";
			const errors = Number.isSafeInteger(event.data?.toolErrors) && Number(event.data?.toolErrors) > 0 ? ` · ${event.data?.toolErrors} errors` : "";
			this.options.viewers.send(key, { type: "notice", text: `${tool} ${state}${errors}` });
		} else if (event.type === "output_drained") {
			view.drained = true;
			if (view.terminal) this.enqueue(() => this.closeAttempt(view));
		} else if (event.type === "terminal") {
			view.terminal = true;
			const status = typeof event.data?.status === "string" ? sanitizeTerminalText(event.data.status) : "settled";
			this.options.viewers.send(key, { type: "status", text: status });
			if (view.drained || event.data?.spawned === false) this.enqueue(() => this.closeAttempt(view));
		}
	}

	handleDisplay(event: SubagentDisplayEvent): void {
		if (this.closed) return;
		const view = this.attempts.get(attemptKey(event.agentId, event.attemptId));
		if (!view || view.userClosed) return;
		if (event.frame.type === "display_ready") view.richReady = true;
		this.options.viewers.send(view.key, { type: "display", frame: event.frame });
	}

	async idle(): Promise<void> {
		await this.queue;
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		await this.enqueue(async () => {
			await Promise.all([...this.attempts.values()].map((view) => this.closeAttempt(view)));
			for (let retry = 0; retry < 2 && this.pendingClosures.size > 0; retry++) {
				await Promise.all([...this.pendingClosures].map((surfaceId) => this.closeSurface(surfaceId)));
			}
		});
		await this.options.viewers.shutdown().catch(() => undefined);
		this.attempts.clear();
		this.ownedSurfaceIds.clear();
		this.pendingClosures.clear();
	}

	private ensureAttempt(agentId: string, attemptId: string, snapshot?: LogicalAgentSnapshot, reloaded = false): void {
		const key = attemptKey(agentId, attemptId);
		if (this.attempts.has(key)) return;
		const rawTitle = sanitizeTerminalText(snapshot ? `${snapshot.agent}${snapshot.title ? ` · ${snapshot.title}` : ""}` : `Subagent ${agentId}`);
		const title = shortSubagentTitle(rawTitle) ?? "Subagent";
		const view: AttemptView = { key, agentId, attemptId, opening: true, terminal: false, drained: false, userClosed: false, richReady: false, title };
		this.attempts.set(key, view);
		const command = this.options.viewers.command(key, () => this.viewerClosed(view));
		const limited = this.options.limited === true || reloaded;
		this.options.viewers.send(key, { type: "init", title, ...(limited ? { limited: true } : {}) });
		this.options.viewers.send(key, { type: "status", text: "running" });
		const progress = snapshot?.progress;
		if (progress && progress.turns > 0) this.options.viewers.send(key, { type: "usage", ...(progress.inputTokens === undefined ? {} : { inputTokens: progress.inputTokens }), outputTokens: progress.outputTokens });
		if (reloaded) this.options.viewers.send(key, { type: "notice", text: "Earlier rich detail unavailable after reload." });
		this.enqueue(() => this.openAttempt(view, command));
	}

	private viewerClosed(view: AttemptView): void {
		if (view.terminal || this.closed) return;
		view.userClosed = true;
		this.options.viewers.abandon(view.key);
		if (!view.surfaceId) return;
		const surfaceId = view.surfaceId;
		this.pendingClosures.add(surfaceId);
		this.enqueue(() => this.closeSurface(surfaceId));
	}

	private async openAttempt(view: AttemptView, command: string): Promise<void> {
		if (this.closed || view.userClosed || view.terminal) return this.options.viewers.abandon(view.key);
		try {
			const panes = await this.readyPanes();
			if (!panes) return this.skip(view);
			const splitMain = this.ownedSurfaceIds.size === 0;
			const source = splitMain
				? panes.find((pane) => pane.surfaceIds.includes(this.options.mainSurfaceId))
				: chooseLargestOwnedPane(panes, this.ownedSurfaceIds);
			if (!source) return this.skip(view);
			const direction = splitDirection(source);
			if (!splitIsViable(source, direction, splitMain ? 3 : 2)) return this.skip(view);
			const sourceSurface = !splitMain
				? source.surfaceIds.filter((id) => this.ownedSurfaceIds.has(id)).sort()[0]
				: this.options.mainSurfaceId;
			if (!sourceSurface) return this.skip(view);
			const split = await this.options.client.split(direction, sourceSurface, command);
			view.paneId = split.paneId;
			view.surfaceId = split.surfaceId;
			this.ownedSurfaceIds.add(split.surfaceId);
			const afterSplit = await this.waitForPane(split.surfaceId);
			if (!afterSplit) return this.rollback(view);
			await this.options.client.renameTab?.(split.surfaceId, view.title).catch(() => undefined);
			const sourceAfter = afterSplit.panes.find((pane) => pane.surfaceIds.includes(sourceSurface));
			if (!sourceAfter || sourceAfter.paneId === afterSplit.pane.paneId) return this.rollback(view);
			// Preserve two thirds for main; cmux's equal split already balances agent siblings.
			if (splitMain) {
				const amount = Math.max(1, Math.round((direction === "right" ? source.width : source.height) / 6));
				await this.options.client.resizeSource(sourceAfter.paneId, direction, amount);
				const resized = await this.waitForResize(sourceSurface, direction, sourceAfter);
				if (!resized) return this.rollback(view);
			}
			view.opening = false;
			if (view.terminal) await this.closeAttempt(view);
		} catch {
			await this.rollback(view);
		}
	}

	private async readyPanes(): Promise<readonly CmuxPane[] | undefined> {
		let panes = await this.options.client.listPanes();
		for (const surface of [...this.pendingClosures]) {
			if (panes.some((pane) => pane.surfaceIds.includes(surface))) await this.closeSurface(surface);
			else this.forgetSurface(surface);
		}
		if (this.pendingClosures.size > 0) return undefined;
		panes = await this.options.client.listPanes();
		for (const surface of [...this.ownedSurfaceIds]) {
			if (!panes.some((pane) => pane.surfaceIds.includes(surface))) this.ownedSurfaceIds.delete(surface);
		}
		return panes;
	}

	private async waitForPane(surfaceId: string): Promise<{ panes: readonly CmuxPane[]; pane: CmuxPane } | undefined> {
		return this.poll(async () => {
			const panes = await this.options.client.listPanes();
			const pane = panes.find((candidate) => candidate.surfaceIds.includes(surfaceId));
			return pane ? { panes, pane } : undefined;
		});
	}

	private async waitForResize(sourceSurface: string, direction: "right" | "down", before: CmuxPane): Promise<boolean> {
		return Boolean(await this.poll(async () => {
			const pane = (await this.options.client.listPanes()).find((candidate) => candidate.surfaceIds.includes(sourceSurface));
			if (!pane) return undefined;
			return (direction === "right" ? pane.width > before.width : pane.height > before.height) || undefined;
		}));
	}

	private async poll<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
		const deadline = Date.now() + UI_READY_MS;
		do {
			try {
				const value = await read();
				if (value !== undefined) return value;
			} catch { return undefined; }
			await new Promise((resolve) => setTimeout(resolve, 50));
		} while (Date.now() < deadline);
		return undefined;
	}

	private skip(view: AttemptView): void {
		view.opening = false;
		view.userClosed = true;
		this.options.viewers.abandon(view.key);
	}

	private async rollback(view: AttemptView): Promise<void> {
		if (view.surfaceId) {
			this.pendingClosures.add(view.surfaceId);
			await this.closeSurface(view.surfaceId);
		}
		this.skip(view);
	}

	private async closeAttempt(view: AttemptView): Promise<void> {
		await this.options.viewers.close(view.key).catch(() => undefined);
		if (view.surfaceId && !view.userClosed) {
			this.pendingClosures.add(view.surfaceId);
			await this.closeSurface(view.surfaceId);
		}
		view.userClosed = true;
	}

	private async closeSurface(surfaceId: string): Promise<void> {
		await this.options.client.closeSurface(surfaceId).catch(() => undefined);
		const gone = await this.poll(async () => !(await this.options.client.listPanes()).some((pane) => pane.surfaceIds.includes(surfaceId)) || undefined);
		if (gone) this.forgetSurface(surfaceId);
	}

	private forgetSurface(surfaceId: string): void {
		this.pendingClosures.delete(surfaceId);
		this.ownedSurfaceIds.delete(surfaceId);
	}

	private enqueue(operation: () => Promise<void> | void): Promise<void> {
		const next = this.queue.then(operation, operation).catch(() => undefined);
		this.queue = next;
		return next;
	}
}

export class CmuxCli implements CmuxClient {
	async listPanes(): Promise<readonly CmuxPane[]> {
		const value = await runCmux(["list-panes"]);
		const candidates: Record<string, unknown>[] = [];
		walkObjects(value, (object) => { if (frame(object.pixel_frame)) candidates.push(object); });
		return candidates.map(parsePane).filter((pane): pane is CmuxPane => pane !== undefined);
	}

	async split(direction: "right" | "down", sourceSurfaceId: string, command: string): Promise<CmuxSplit> {
		const value = await runCmux(["new-split", direction, "--surface", sourceSurfaceId, "--focus", "false", "--command", command]);
		let found: CmuxSplit | undefined;
		walkObjects(value, (object) => {
			const paneId = identifier(object.pane_id ?? object.paneId);
			const surfaceId = identifier(object.surface_id ?? object.surfaceId);
			if (!found && paneId && surfaceId) found = { paneId, surfaceId };
		});
		if (!found) throw new Error("cmux split response omitted pane/surface IDs");
		return found;
	}

	async resizeSource(paneId: string, direction: "right" | "down", amount: number): Promise<void> {
		await runCmux(["resize-pane", "--pane", paneId, direction === "right" ? "-R" : "-D", "--amount", String(Math.max(1, Math.round(amount)))]);
	}

	async closeSurface(surfaceId: string): Promise<void> {
		await runCmux(["close-surface", "--surface", surfaceId]);
	}

	async renameTab(surfaceId: string, title: string): Promise<void> {
		await runCmux(["rename-tab", "--surface", surfaceId, "--title", title]);
	}
}

interface QueuedViewerFrame {
	readonly frame: ViewerFrame;
	readonly line: string;
	readonly bytes: number;
}

interface ViewerChannel {
	readonly token: string;
	readonly onUnexpectedClose: () => void;
	socket?: Socket;
	queue: QueuedViewerFrame[];
	bytes: number;
	writing: boolean;
	omissionPending: boolean;
	closing: boolean;
	connected?: () => void;
	drained?: () => void;
}

export class SocketViewerTransport implements ViewerTransport {
	private readonly channels = new Map<string, ViewerChannel>();
	private readonly sockets = new Set<Socket>();
	private constructor(private readonly directory: string, private readonly socketPath: string, private readonly server: Server) {}

	static async create(): Promise<SocketViewerTransport> {
		const directory = await mkdtemp(join(tmpdir(), "pibox-cmux-"));
		await chmod(directory, 0o700);
		const socketPath = join(directory, "viewer.sock");
		const server = createServer();
		const transport = new SocketViewerTransport(directory, socketPath, server);
		server.on("connection", (socket) => transport.accept(socket));
		server.on("error", () => undefined);
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => { server.off("error", reject); resolve(); });
			});
			return transport;
		} catch (error) {
			await closeServer(server);
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	command(key: string, onUnexpectedClose: () => void): string {
		const token = randomUUID();
		this.channels.set(key, { token, onUnexpectedClose, queue: [], bytes: 0, writing: false, omissionPending: false, closing: false });
		const viewer = fileURLToPath(new URL("./viewer.mjs", import.meta.url));
		return [process.execPath, viewer, this.socketPath, token].map(shellQuote).join(" ");
	}

	send(key: string, frame: ViewerFrame): void {
		const channel = this.channels.get(key);
		if (!channel || channel.closing || (frame.type === "text" && !frame.text)) return;
		this.enqueueFrame(channel, frame);
		this.pump(channel);
	}

	write(key: string, text: string): void {
		this.send(key, { type: "text", text });
	}

	async close(key: string): Promise<void> {
		const channel = this.channels.get(key);
		if (!channel) return;
		channel.closing = true;
		if (!channel.socket) {
			await new Promise<void>((resolve) => {
				channel.connected = resolve;
				setTimeout(resolve, VIEWER_CONNECT_MS).unref();
			});
		}
		const socket = channel.socket;
		if (!socket) return this.abandon(key);
		this.enqueueOmissionNotice(channel);
		this.enqueueFrame(channel, { type: "close" }, true);
		if (channel.omissionPending && channel.queue.at(-1)?.frame.type === "close") {
			const close = channel.queue.pop()!; channel.bytes -= close.bytes;
			this.enqueueOmissionNotice(channel);
			this.enqueueFrame(channel, { type: "close" }, true);
		}
		this.pump(channel);
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(); } };
			channel.drained = finish;
			setTimeout(finish, VIEWER_DRAIN_MS).unref();
		});
		socket.end();
		await Promise.race([
			new Promise<void>((resolve) => socket.once("close", resolve)),
			new Promise<void>((resolve) => setTimeout(resolve, VIEWER_DRAIN_MS)),
		]);
		if (!socket.destroyed) socket.destroy();
		this.channels.delete(key);
	}

	abandon(key: string): void {
		const channel = this.channels.get(key);
		if (!channel) return;
		channel.closing = true;
		channel.connected?.();
		channel.socket?.destroy();
		this.channels.delete(key);
	}

	async shutdown(): Promise<void> {
		for (const key of [...this.channels.keys()]) this.abandon(key);
		for (const socket of this.sockets) socket.destroy();
		await closeServer(this.server);
		await rm(this.directory, { recursive: true, force: true });
	}

	private enqueueFrame(channel: ViewerChannel, input: ViewerFrame, force = false): void {
		const frame = constrainViewerFrame(input);
		if (frame.type === "text") {
			for (const part of splitViewerText(frame.text)) this.enqueueTextFrame(channel, part);
			return;
		}
		const queued = encodeViewerFrame(frame);
		if (queued.bytes > MAX_VIEWER_FRAME_BYTES) {
			channel.omissionPending = true;
			return;
		}
		this.enqueueQueuedFrame(channel, queued, force);
	}

	private enqueueTextFrame(channel: ViewerChannel, frame: Extract<ViewerFrame, { type: "text" }>): void {
		const tail = channel.queue.at(-1);
		if (tail?.frame.type === "text") {
			const combined = encodeViewerFrame({ type: "text", text: tail.frame.text + frame.text });
			if (combined.bytes <= MAX_VIEWER_FRAME_BYTES) {
				channel.queue.pop(); channel.bytes -= tail.bytes;
				this.enqueueQueuedFrame(channel, combined);
				return;
			}
		}
		this.enqueueQueuedFrame(channel, encodeViewerFrame(frame));
	}

	private enqueueQueuedFrame(channel: ViewerChannel, queued: QueuedViewerFrame, force = false): void {
		const replaceable = queued.frame.type === "init" || queued.frame.type === "usage" || queued.frame.type === "status";
		if (replaceable) {
			const index = channel.queue.findIndex((candidate) => candidate.frame.type === queued.frame.type);
			if (index >= 0) { channel.bytes -= channel.queue[index]!.bytes; channel.queue.splice(index, 1); }
		}
		while (channel.bytes + queued.bytes > MAX_CHANNEL_BYTES) {
			const index = channel.queue.findIndex((candidate) => candidate.frame.type === "text" || candidate.frame.type === "display" || candidate.frame.type === "notice");
			if (index < 0) break;
			const [removed] = channel.queue.splice(index, 1);
			channel.bytes -= removed!.bytes;
			if (removed!.frame.type !== "notice") channel.omissionPending = true;
		}
		if (channel.bytes + queued.bytes > MAX_CHANNEL_BYTES && !force) {
			if (!replaceable) channel.omissionPending = true;
			return;
		}
		if (channel.bytes + queued.bytes > MAX_CHANNEL_BYTES) return;
		channel.queue.push(queued);
		channel.bytes += queued.bytes;
	}

	private enqueueOmissionNotice(channel: ViewerChannel): void {
		if (!channel.omissionPending) return;
		const notice = encodeViewerFrame({ type: "notice", text: "Live detail omitted while viewer was slow." });
		if (channel.bytes + notice.bytes > MAX_CHANNEL_BYTES) return;
		channel.queue.push(notice);
		channel.bytes += notice.bytes;
		channel.omissionPending = false;
	}

	private pump(channel: ViewerChannel): void {
		if (!channel.socket || channel.writing) return;
		if (!channel.queue.some((queued) => queued.frame.type === "close")) this.enqueueOmissionNotice(channel);
		const queued = channel.queue.shift();
		if (!queued) return;
		channel.writing = true;
		channel.socket.write(queued.line, () => {
			channel.writing = false;
			channel.bytes = Math.max(0, channel.bytes - queued.bytes);
			this.pump(channel);
		});
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		let input = "";
		let channel: ViewerChannel | undefined;
		const reject = () => socket.destroy();
		const timer = setTimeout(reject, 1_000);
		timer.unref();
		socket.on("data", (chunk) => {
			input += chunk;
			if (input.length > 4_096) return reject();
			for (;;) {
				const end = input.indexOf("\n");
				if (end < 0) return;
				const line = input.slice(0, end); input = input.slice(end + 1);
				let message: unknown;
				try { message = JSON.parse(line); } catch { return reject(); }
				if (!message || typeof message !== "object" || Array.isArray(message)) return reject();
				const frame = message as { type?: unknown; token?: unknown };
				if (!channel) {
					if (frame.type !== "hello" || typeof frame.token !== "string") return reject();
					channel = [...this.channels.values()].find((candidate) => candidate.token === frame.token);
					if (!channel || channel.socket) return reject();
					clearTimeout(timer);
					channel.socket = socket;
					this.pump(channel);
					channel.connected?.();
				} else if (frame.type === "drained") channel.drained?.();
			}
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
			clearTimeout(timer);
			if (!channel) return;
			channel.connected?.();
			channel.drained?.();
			const expected = channel.closing;
			const entry = [...this.channels.entries()].find(([, candidate]) => candidate === channel);
			if (entry) this.channels.delete(entry[0]);
			if (!expected) channel.onUnexpectedClose();
		});
		socket.on("error", () => undefined);
	}
}

function encodeViewerFrame(frame: ViewerFrame): QueuedViewerFrame {
	const line = `${JSON.stringify(frame)}\n`;
	return { frame, line, bytes: Buffer.byteLength(line) };
}

function splitViewerText(text: string): Array<Extract<ViewerFrame, { type: "text" }>> {
	const frames: Array<Extract<ViewerFrame, { type: "text" }>> = [];
	let offset = 0;
	while (offset < text.length) {
		let low = 1;
		let high = Math.min(text.length - offset, MAX_VIEWER_FRAME_BYTES);
		while (low < high) {
			const length = Math.ceil((low + high) / 2);
			const end = safeUtf16End(text, offset + length);
			if (encodeViewerFrame({ type: "text", text: text.slice(offset, end) }).bytes <= MAX_VIEWER_FRAME_BYTES) low = length;
			else high = length - 1;
		}
		let end = safeUtf16End(text, offset + low);
		while (end > offset && encodeViewerFrame({ type: "text", text: text.slice(offset, end) }).bytes > MAX_VIEWER_FRAME_BYTES) end = safeUtf16End(text, end - 1);
		if (end <= offset) end = Math.min(text.length, offset + 1);
		frames.push({ type: "text", text: text.slice(offset, end) });
		offset = end;
	}
	return frames;
}

function safeUtf16End(value: string, end: number): number {
	return end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!) ? end - 1 : end;
}

function constrainViewerFrame(frame: ViewerFrame): ViewerFrame {
	if (frame.type === "init") return { ...frame, title: codePointPrefix(frame.title, 80), ...(frame.cwd === undefined ? {} : { cwd: codePointPrefix(frame.cwd, 1_024) }) };
	if (frame.type === "status" || frame.type === "notice") return { ...frame, text: codePointPrefix(frame.text, 2_000) };
	return frame;
}

function codePointPrefix(value: string, maximum: number): string {
	return Array.from(value.slice(0, maximum * 2)).slice(0, maximum).join("");
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function attemptKey(agentId: string, attemptId: string): string {
	return `${agentId}\0${attemptId}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await Promise.race([
		new Promise<void>((resolve) => server.close(() => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, VIEWER_DRAIN_MS)),
	]);
}

function runCmux(args: readonly string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile("cmux", ["--json", "--id-format", "both", ...args], { timeout: CLI_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) return reject(error);
			try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); }
			catch (parseError) { reject(parseError); }
		});
	});
}

function walkObjects(value: unknown, visit: (object: Record<string, unknown>) => void): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) { for (const item of value) walkObjects(item, visit); return; }
	const object = value as Record<string, unknown>;
	visit(object);
	for (const nested of Object.values(object)) walkObjects(nested, visit);
}

function identifier(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (!value || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	return identifier(object.uuid) ?? identifier(object.id);
}

function frame(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	const x = number(object.x), y = number(object.y), width = number(object.width), height = number(object.height);
	return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePane(object: Record<string, unknown>): CmuxPane | undefined {
	const pixel = frame(object.pixel_frame);
	const paneId = identifier(object.id ?? object.pane_id);
	const rawSurfaces = object.surface_ids ?? object.surfaceIds;
	const surfaceIds = Array.isArray(rawSurfaces) ? rawSurfaces.map(identifier).filter((id): id is string => id !== undefined) : [];
	if (!pixel || !paneId || surfaceIds.length === 0) return undefined;
	const cell = frame(object.cell_frame);
	const columns = number(object.columns) ?? number(object.cols) ?? cell?.width;
	const rows = number(object.rows) ?? cell?.height;
	const cellWidth = number(object.cell_width) ?? (columns ? pixel.width / columns : undefined);
	const cellHeight = number(object.cell_height) ?? (rows ? pixel.height / rows : undefined);
	return { paneId, surfaceIds, ...pixel, ...(columns === undefined ? {} : { columns }), ...(rows === undefined ? {} : { rows }), ...(cellWidth === undefined ? {} : { cellWidth }), ...(cellHeight === undefined ? {} : { cellHeight }) };
}
