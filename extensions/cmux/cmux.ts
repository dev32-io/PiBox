import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LogicalAgentSnapshot, SubagentEvent } from "../subagent/api.js";

const ACTIVE_STATES = new Set(["launching", "running", "stopping"]);
const MAX_CHANNEL_BYTES = 64 * 1024;
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
}

export interface ViewerTransport {
	command(key: string, onUnexpectedClose: () => void): string;
	write(key: string, text: string): void;
	close(key: string): Promise<void>;
	abandon(key: string): void;
	shutdown(): Promise<void>;
}

export interface CmuxPaneAdapterOptions {
	readonly mainSurfaceId: string;
	readonly client: CmuxClient;
	readonly viewers: ViewerTransport;
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

export function splitIsViable(pane: CmuxPane, direction = splitDirection(pane)): boolean {
	if (direction === "right") {
		if (pane.columns !== undefined && pane.rows !== undefined) return Math.floor(pane.columns / 3) >= 20 && pane.rows >= 5;
		return pane.width / 3 >= 160 && pane.height >= 80;
	}
	if (pane.columns !== undefined && pane.rows !== undefined) return Math.floor(pane.rows / 3) >= 5 && pane.columns >= 20;
	return pane.height / 3 >= 80 && pane.width >= 160;
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
			if (agent.attemptId && ACTIVE_STATES.has(agent.state)) this.ensureAttempt(agent.handle.agentId, agent.attemptId, agent);
		}
	}

	handle(event: SubagentEvent, snapshot?: LogicalAgentSnapshot): void {
		if (this.closed) return;
		const key = attemptKey(event.agentId, event.attemptId);
		if (event.type === "attempt_started") this.ensureAttempt(event.agentId, event.attemptId, snapshot);
		const view = this.attempts.get(key);
		if (!view || view.userClosed) return;
		if (event.type === "message_delta" && typeof event.data?.text === "string") {
			this.options.viewers.write(key, sanitizeTerminalText(event.data.text));
		} else if (event.type === "tool_activity") {
			const tool = typeof event.data?.tool === "string" ? sanitizeTerminalText(event.data.tool) : "tool";
			const state = event.data?.active === true ? "started" : "finished";
			const errors = Number.isSafeInteger(event.data?.toolErrors) && Number(event.data?.toolErrors) > 0 ? ` · ${event.data?.toolErrors} errors` : "";
			this.options.viewers.write(key, `\n[tool] ${tool} ${state}${errors}\n`);
		} else if (event.type === "output_drained") {
			view.drained = true;
			if (view.terminal) this.enqueue(() => this.closeAttempt(view));
		} else if (event.type === "terminal") {
			view.terminal = true;
			const status = typeof event.data?.status === "string" ? sanitizeTerminalText(event.data.status) : "settled";
			this.options.viewers.write(key, `\n[${status}]\n`);
			if (view.drained || event.data?.spawned === false) this.enqueue(() => this.closeAttempt(view));
		}
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

	private ensureAttempt(agentId: string, attemptId: string, snapshot?: LogicalAgentSnapshot): void {
		const key = attemptKey(agentId, attemptId);
		if (this.attempts.has(key)) return;
		const view: AttemptView = { key, agentId, attemptId, opening: true, terminal: false, drained: false, userClosed: false };
		this.attempts.set(key, view);
		const label = snapshot ? `${snapshot.agent}${snapshot.title ? ` · ${snapshot.title}` : ""}` : `Subagent ${agentId}`;
		const command = this.options.viewers.command(key, () => this.viewerClosed(view));
		this.options.viewers.write(key, `[${sanitizeTerminalText(label)} — running]\n\n`);
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
			const source = this.ownedSurfaceIds.size > 0
				? chooseLargestOwnedPane(panes, this.ownedSurfaceIds)
				: panes.find((pane) => pane.surfaceIds.includes(this.options.mainSurfaceId));
			if (!source) return this.skip(view);
			const direction = splitDirection(source);
			if (!splitIsViable(source, direction)) return this.skip(view);
			const sourceSurface = this.ownedSurfaceIds.size > 0
				? source.surfaceIds.filter((id) => this.ownedSurfaceIds.has(id)).sort()[0]
				: this.options.mainSurfaceId;
			if (!sourceSurface) return this.skip(view);
			const split = await this.options.client.split(direction, sourceSurface, command);
			view.paneId = split.paneId;
			view.surfaceId = split.surfaceId;
			this.ownedSurfaceIds.add(split.surfaceId);
			const afterSplit = await this.waitForPane(split.surfaceId);
			if (!afterSplit) return this.rollback(view);
			const sourceAfter = afterSplit.panes.find((pane) => pane.surfaceIds.includes(sourceSurface));
			if (!sourceAfter || sourceAfter.paneId === afterSplit.pane.paneId) return this.rollback(view);
			const amount = Math.max(1, Math.round((direction === "right" ? source.width : source.height) / 6));
			await this.options.client.resizeSource(sourceAfter.paneId, direction, amount);
			const resized = await this.waitForResize(sourceSurface, direction, sourceAfter);
			if (!resized) return this.rollback(view);
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
}

interface ViewerChannel {
	readonly token: string;
	readonly onUnexpectedClose: () => void;
	socket?: Socket;
	buffer: string;
	bytes: number;
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
		this.channels.set(key, { token, onUnexpectedClose, buffer: "", bytes: 0, closing: false });
		const viewer = fileURLToPath(new URL("./viewer.mjs", import.meta.url));
		return [process.execPath, viewer, this.socketPath, token].map(shellQuote).join(" ");
	}

	write(key: string, text: string): void {
		const channel = this.channels.get(key);
		if (!channel || channel.closing || !text) return;
		const frame = `${JSON.stringify({ type: "text", text })}\n`;
		const bytes = Buffer.byteLength(frame);
		if (bytes > MAX_CHANNEL_BYTES || channel.bytes + bytes > MAX_CHANNEL_BYTES) return;
		channel.bytes += bytes;
		if (channel.socket && channel.socket.writableLength + bytes <= MAX_CHANNEL_BYTES) channel.socket.write(frame, () => { channel.bytes = Math.max(0, channel.bytes - bytes); });
		else if (!channel.socket) channel.buffer += frame;
		else channel.bytes -= bytes;
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
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(); } };
			channel.drained = finish;
			socket.write(`${JSON.stringify({ type: "close" })}\n`);
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
					if (channel.buffer) {
						const buffer = channel.buffer;
						const bytes = Buffer.byteLength(buffer);
						const connectedChannel = channel;
						channel.buffer = "";
						socket.write(buffer, () => { connectedChannel.bytes = Math.max(0, connectedChannel.bytes - bytes); });
					}
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
