import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import type { VisualCompanionRouteHandler } from "./backend.mjs";
import { createVisualCompanionBackend } from "./backend.mjs";
import { StoryBoardReader } from "./story-board/reader.js";
import { createStoryBoardViewer } from "./story-board/api.js";
import { ASSISTED_FIXTURE_MARKER, RECOVERY_STORY_ID } from "./story-board/fixtures.js";
import { createArchitectureViewer } from "../../skills/architecture-visualizer/scripts/server.mjs";

const MAX_DELAY_MS = 10_000;
const DIAGNOSTICS_ROUTE = "/__assisted/diagnostics";
const RECOVERY_ROUTE = "/__assisted/recover";
const CLOSE_ROUTE = "/__assisted/close";

export const ASSISTED_PRODUCTION_COMPOSITION = Object.freeze({
	backendFactory: createVisualCompanionBackend,
	storyBoardFactory: createStoryBoardViewer,
	storyBoardReader: StoryBoardReader,
	architectureFactory: createArchitectureViewer,
});

export interface AssistedLaunchOptions {
	repositoryRoot: string;
	architectureArtifactPath?: string;
	discoveryDelayMs?: number;
	host?: string;
	port?: number;
}
export interface AssistedDiagnostics {
	schemaVersion: 1; backendCount: 1; state: "running" | "closing" | "closed"; viewers: readonly ["story-board", "architecture"];
	storyBoard: { discovery: "not-started" | "delayed" | "complete"; discoveryStarts: number; delayMs: number; catalogRequests: number; catalogReads: number; refreshes: number };
	recovery: { enabled: boolean; applied: boolean; resource: typeof RECOVERY_STORY_ID };
}
export interface AssistedVisualCompanion {
	host: string; port: number; url: string; architectureUrl: string; diagnosticsUrl: string; recoveryUrl?: string; closeUrl: string;
	diagnostics(): AssistedDiagnostics; recoverMalformedResource(): Promise<boolean>; close(): Promise<void>;
}

async function fixtureMarker(repositoryRoot: string): Promise<boolean> {
	try {
		const [root, temporaryRoot] = await Promise.all([realpath(repositoryRoot), realpath(tmpdir())]);
		const fromTemporary = relative(temporaryRoot, root);
		if (!fromTemporary || fromTemporary === ".." || fromTemporary.startsWith(`..${sep}`) || !basename(root).startsWith("visual-companion-e2e-")) return false;
		const value = JSON.parse(await readFile(resolve(root, ASSISTED_FIXTURE_MARKER), "utf8"));
		return value?.schemaVersion === 1 && Array.isArray(value.cases);
	} catch { return false; }
}
function send(response: Parameters<VisualCompanionRouteHandler>[1], status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value));
}

/** Launch the real production backend and viewer factories without starting Pi or a TUI. */
export async function launchAssistedVisualCompanion(options: AssistedLaunchOptions): Promise<AssistedVisualCompanion> {
	const repositoryRoot = resolve(options.repositoryRoot);
	const delayMs = options.discoveryDelayMs ?? 0;
	if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new Error(`discoveryDelayMs must be an integer from 0 through ${MAX_DELAY_MS}.`);
	const fixture = await fixtureMarker(repositoryRoot);
	if (delayMs && !fixture) throw new Error("Delayed discovery is available only for a disposable assisted fixture repository.");
	let discovery: AssistedDiagnostics["storyBoard"]["discovery"] = "not-started";
	let discoveryStarts = 0;
	let recoveryApplied = false;
	let state: AssistedDiagnostics["state"] = "running";
	let closePromise: Promise<void> | undefined;
	let backend: Awaited<ReturnType<typeof createVisualCompanionBackend>>;
	const productionReader = new StoryBoardReader(repositoryRoot);
	const delayedReader = {
		async readCatalog() {
			discoveryStarts += 1; discovery = delayMs ? "delayed" : "complete";
			if (delayMs) await new Promise<void>((done) => { const timer = setTimeout(done, delayMs); timer.unref?.(); });
			const result = await productionReader.readCatalog(); discovery = "complete"; return result;
		},
		readWorkspace: productionReader.readWorkspace.bind(productionReader), readTaskDetail: productionReader.readTaskDetail.bind(productionReader),
		readDocumentDetail: productionReader.readDocumentDetail.bind(productionReader), readReportDetail: productionReader.readReportDetail.bind(productionReader),
	};
	const storyBoard = createStoryBoardViewer({ repositoryRoot, reader: delayedReader });
	const architecture = createArchitectureViewer();
	const diagnostics = (): AssistedDiagnostics => {
		const viewer = storyBoard.diagnostics();
		return { schemaVersion: 1, backendCount: 1, state, viewers: ["story-board", "architecture"], storyBoard: { discovery, discoveryStarts, delayMs, catalogRequests: viewer.catalogRequests, catalogReads: viewer.catalogReads, refreshes: viewer.refreshes }, recovery: { enabled: fixture, applied: recoveryApplied, resource: RECOVERY_STORY_ID } };
	};
	const recoverMalformedResource = async (): Promise<boolean> => {
		if (!fixture || recoveryApplied) return false;
		const recoveryRoot = resolve(repositoryRoot, "agent-artifacts", RECOVERY_STORY_ID);
		const valid = await readFile(resolve(recoveryRoot, "index.valid.yaml"), "utf8");
		await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(recoveryRoot, "index.yaml"), valid)); recoveryApplied = true; return true;
	};
	const handlers: Record<string, VisualCompanionRouteHandler> = {
		[DIAGNOSTICS_ROUTE](request, response) { if (request.method !== "GET") return send(response, 405, { error: "Method not allowed" }); send(response, 200, diagnostics()); },
		async [RECOVERY_ROUTE](request, response) { if (request.method !== "POST") return send(response, 405, { error: "Method not allowed" }); if (!fixture) return send(response, 404, { error: "Recovery is unavailable" }); send(response, 200, { applied: await recoverMalformedResource(), resource: RECOVERY_STORY_ID }); },
		[CLOSE_ROUTE](request, response) { if (request.method !== "POST") return send(response, 405, { error: "Method not allowed" }); send(response, 202, { closing: true }); queueMicrotask(() => { void close(); }); },
	};
	backend = await createVisualCompanionBackend({ viewers: [storyBoard, architecture], host: options.host ?? "127.0.0.1", port: options.port ?? 0, commonHandlers: handlers });
	if (backend.viewers.length !== 2 || backend.viewers[0] !== storyBoard.id || backend.viewers[1] !== architecture.id) { await backend.close(); throw new Error("Assisted launcher production composition diverged from the approved viewers."); }
	if (options.architectureArtifactPath) backend.show({ viewerId: "architecture", artifactPath: resolve(options.architectureArtifactPath) });
	function close(): Promise<void> {
		if (closePromise) return closePromise;
		state = "closing"; closePromise = backend.close().finally(() => { state = "closed"; }); return closePromise;
	}
	return { host: backend.host, port: backend.port, url: `${backend.url}/story-board`, architectureUrl: `${backend.url}/architecture`, diagnosticsUrl: `${backend.url}${DIAGNOSTICS_ROUTE}`, ...(fixture ? { recoveryUrl: `${backend.url}${RECOVERY_ROUTE}` } : {}), closeUrl: `${backend.url}${CLOSE_ROUTE}`, diagnostics, recoverMalformedResource, close };
}
