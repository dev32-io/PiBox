import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionScratchNotes, restoreSessionScratchWorkspace, type SessionScratchBinding } from "../../session-scratch/workspace.js";
import { listScratchDirectory, readScratchFile, scratchPath, scratchWatchDirectory } from "../../session-scratch/explorer.js";
import type { VisualCompanionViewer } from "../backend.mjs";

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
const ASSETS = new Map<string, string>([ ["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/styles.css", "styles.css"], ["/markdown.js", "markdown.js"], ["/webawesome.min.js", "webawesome.min.js"],
	...[
		"arrow-down", "arrow-up", "chevron-down", "chevron-left", "chevron-right", "file-code", "file-cog", "file-image", "file-json", "file-text", "file-warning", "file", "folder-open", "folder", "grip-vertical", "lock", "panel-left-close", "panel-left-open", "panel-left", "pin", "refresh-cw", "search", "x",
	].map((name): [string, string] => [`/icons/${name}.svg`, `icons/${name}.svg`]),
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
	response.end(JSON.stringify(value));
}

function allowRead(request: IncomingMessage, response: ServerResponse, url: URL, backendUrl: string, keys: string[] = []): boolean {
	if (request.method !== "GET") {
		response.setHeader("allow", "GET");
		json(response, 405, { error: "Read-only resource." });
		return false;
	}
	// Both notes and notifications are private, same-origin resources. No CORS opt-in.
	const origin = new URL(backendUrl);
	if (request.headers.host !== origin.host || (request.headers.origin && request.headers.origin !== origin.origin)
		|| request.headers["sec-fetch-site"] === "cross-site") {
		json(response, 403, { error: "Same-origin access required." });
		return false;
	}
	if ([...url.searchParams.keys()].some((key) => !keys.includes(key)) || (keys.length === 0 && url.search)) {
		json(response, 400, { error: "This resource accepts no parameters." });
		return false;
	}
	return true;
}

const identity = (binding: SessionScratchBinding) => createHash("sha256").update(`${binding.sessionId}\0${binding.workspaceId}`).digest("hex");
const failure = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "blocked";

/** The owner supplies a current-session binding, never a browser-selected path or session id. */
export function createScratchViewer(
	getBinding: () => SessionScratchBinding | undefined,
	watchSource = { directory: scratchWatchDirectory, watch },
): VisualCompanionViewer & { refreshBinding(): void } {
	let closed = false;
	const subscriptions = new Map<() => void, SessionScratchBinding>();
	const stillCurrent = (binding: SessionScratchBinding) => {
		const current = closed ? undefined : getBinding();
		return current?.sessionId === binding.sessionId && current.workspaceId === binding.workspaceId;
	};
	const invalidate = () => { for (const stop of subscriptions.keys()) stop(); };
	const pruneSubscriptions = () => {
		for (const [stop, binding] of subscriptions) if (!stillCurrent(binding)) stop();
	};
	return {
		id: "scratch",
		refreshBinding: pruneSubscriptions,
		async isAvailable() { pruneSubscriptions(); return true; },
		resolveAsset(route) {
			const name = ASSETS.get(route);
			return name ? { path: join(ASSETS_DIR, name), headers: { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } } : undefined;
		},
		handlers: {
			"/api/notes": async (request, response, { backend, url }) => {
				if (!allowRead(request, response, url, backend.url)) return;
				pruneSubscriptions();
				try {
					const binding = closed ? undefined : getBinding();
					if (!binding) return json(response, 404, { error: "Session scratch unavailable." });
					const notes = await readSessionScratchNotes(binding);
					if (!stillCurrent(binding)) return json(response, 404, { error: "Session scratch unavailable." });
					json(response, 200, notes);
				} catch { json(response, 404, { error: "Session scratch unavailable." }); }
			},
			"/api/tree": async (request, response, { backend, url }) => {
				if (!allowRead(request, response, url, backend.url, ["path", "cursor"])) return;
				if (url.searchParams.getAll("path").length !== 1 || url.searchParams.getAll("cursor").length > 1 || !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get("cursor") ?? "0") || Number(url.searchParams.get("cursor") ?? 0) > 4096) return json(response, 400, { error: "Invalid query." });
				const path = url.searchParams.get("path")!;
				try { scratchPath(path, true); } catch { return json(response, 400, { error: "Invalid path." }); }
				const binding = closed ? undefined : getBinding();
				if (!binding) return json(response, 200, { identity: null, kind: "unavailable" });
				try {
					const result = await listScratchDirectory(binding, path, Number(url.searchParams.get("cursor") ?? 0));
					if (!stillCurrent(binding)) return json(response, 409, { identity: null, kind: "stale" });
					json(response, 200, { identity: identity(binding), ...result });
				} catch (error) {
					if (!stillCurrent(binding)) return json(response, 409, { identity: null, kind: "stale" });
					json(response, 200, { identity: identity(binding), kind: path === "" ? "unavailable" : failure(error) });
				}
			},
			"/api/file": async (request, response, { backend, url }) => {
				if (!allowRead(request, response, url, backend.url, ["path"])) return;
				if (url.searchParams.getAll("path").length !== 1) return json(response, 400, { error: "Invalid query." });
				const path = url.searchParams.get("path")!;
				try { if (!scratchPath(path).length) throw new Error(); } catch { return json(response, 400, { error: "Invalid path." }); }
				const binding = closed ? undefined : getBinding();
				if (!binding) return json(response, 200, { identity: null, kind: "unavailable" });
				try {
					const result = await readScratchFile(binding, path);
					if (!stillCurrent(binding)) return json(response, 409, { identity: null, kind: "stale" });
					const { data, ...fields } = result;
					json(response, 200, { identity: identity(binding), ...fields, ...(result.kind === "image" ? { url: `/v/scratch/api/image?path=${encodeURIComponent(path)}&version=${encodeURIComponent(result.version)}&identity=${identity(binding)}` } : {}) });
				} catch (error) {
					if (!stillCurrent(binding)) return json(response, 409, { identity: null, kind: "stale" });
					json(response, 200, { identity: identity(binding), kind: failure(error) });
				}
			},
			"/api/image": async (request, response, { backend, url }) => {
				if (!allowRead(request, response, url, backend.url, ["path", "version", "identity"])) return;
				if (url.searchParams.getAll("path").length !== 1 || url.searchParams.getAll("version").length !== 1 || url.searchParams.getAll("identity").length !== 1 || !url.searchParams.get("version")) return json(response, 400, { error: "Invalid query." });
				const path = url.searchParams.get("path")!;
				try { if (!scratchPath(path).length) throw new Error(); } catch { return json(response, 400, { error: "Invalid path." }); }
				const binding = closed ? undefined : getBinding();
				if (!binding || url.searchParams.get("identity") !== identity(binding)) return json(response, 409, { error: "Stale scratch binding." });
				try {
					const result = await readScratchFile(binding, path);
					if (!stillCurrent(binding)) return json(response, 409, { error: "Stale scratch binding." });
					if (result.kind !== "image" || result.version !== url.searchParams.get("version")) return json(response, 404, { error: "Image unavailable." });
					response.writeHead(200, { "content-type": result.type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
					response.end(result.data);
				} catch { json(response, stillCurrent(binding) ? 404 : 409, { error: "Image unavailable." }); }
			},
			"/events": async (request, response, { backend, url }) => {
				if (!allowRead(request, response, url, backend.url, ["dir", "file"])) return;
				const dirs = url.searchParams.getAll("dir"), files = url.searchParams.getAll("file");
				if (dirs.length > 32 || files.length > 64 || dirs.some((p) => { try { scratchPath(p, true); return false; } catch { return true; } })
					|| files.some((p) => { try { return !scratchPath(p).length; } catch { return true; } })) return json(response, 400, { error: "Invalid subscription." });
				pruneSubscriptions();
				if (subscriptions.size >= 16) return json(response, 429, { error: "Too many subscriptions." });
				const binding = closed ? undefined : getBinding();
				if (!binding) return json(response, 404, { error: "Session scratch unavailable." });
				const watchers: FSWatcher[] = [];
				let timer: ReturnType<typeof setTimeout> | undefined;
				let stopped = false;
				const cleanup = () => { if (stopped) return; stopped = true; clearTimeout(timer); watchers.forEach((w) => w.close()); subscriptions.delete(stop); };
				const stop = () => { if (stopped) return; cleanup(); if (!response.destroyed) {
					if (response.headersSent) response.end("event: unavailable\ndata: {}\n\n");
					else json(response, 409, { error: "Stale scratch binding." });
				} };
				response.once("close", cleanup);
				// Reserve before first await; pending setups count against the same stream limit.
				subscriptions.set(stop, binding);
				let streaming = false;
				let pendingChange = false;
				try {
					await restoreSessionScratchWorkspace(binding);
					if (stopped || response.destroyed) return;
					if (!stillCurrent(binding)) return json(response, 409, { error: "Stale scratch binding." });
					const paths = new Set(["", ...dirs]);
					for (const file of files) paths.add(file.split("/").slice(0, -1).join("/"));
					for (const path of [...paths]) {
						const parts = scratchPath(path, true);
						for (let n = 0; n < parts.length; n++) paths.add(parts.slice(0, n).join("/"));
					}
					if (paths.size > 128) return json(response, 400, { error: "Too many watched directories." });
					for (const path of paths) {
						if (stopped || response.destroyed || closed) return;
						let directory: string;
						try { directory = await watchSource.directory(binding, path); }
						catch { if (stopped || response.destroyed || closed) return; if (!stillCurrent(binding)) return stop(); continue; } // Parent watches detect missing directory recreation.
						if (stopped || response.destroyed || closed) return;
						if (!stillCurrent(binding)) return stop();
						const watcher = watchSource.watch(directory, { persistent: false }, () => {
							if (stopped) return;
							if (!streaming) { pendingChange = true; return; }
							clearTimeout(timer);
							timer = setTimeout(() => {
								if (!stillCurrent(binding)) return stop();
								if (!response.write("event: changed\ndata: {}\n\n")) stop();
							}, 60);
							timer.unref();
						});
						watcher.once("error", stop);
						watchers.push(watcher);
					}
					if (stopped || response.destroyed || closed) return;
					if (!stillCurrent(binding)) return stop();
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
					response.write("event: ready\ndata: {}\n\n");
					streaming = true;
					if (pendingChange && !response.write("event: changed\ndata: {}\n\n")) stop();
				} catch {
					if (!stopped && !response.destroyed) json(response, 404, { error: "Session scratch unavailable." });
				} finally { if (!streaming) cleanup(); }
			},
		},
		close() { closed = true; invalidate(); },
	};
}
