import { watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionScratchNotes, restoreSessionScratchWorkspace, type SessionScratchBinding } from "../../session-scratch/workspace.js";
import type { VisualCompanionViewer } from "../backend.mjs";

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
const ASSETS = new Map([ ["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/styles.css", "styles.css"], ["/markdown.js", "markdown.js"] ]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
	response.end(JSON.stringify(value));
}

function allowRead(request: IncomingMessage, response: ServerResponse, url: URL, backendUrl: string): boolean {
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
	if (url.search) {
		json(response, 400, { error: "This resource accepts no parameters." });
		return false;
	}
	return true;
}

/** The owner supplies a current-session binding, never a browser-selected path or session id. */
export function createScratchViewer(getBinding: () => SessionScratchBinding | undefined): VisualCompanionViewer & { refreshBinding(): void } {
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
		async isAvailable() {
			pruneSubscriptions();
			try {
				const binding = closed ? undefined : getBinding();
				if (!binding) return false;
				await restoreSessionScratchWorkspace(binding);
				return stillCurrent(binding);
			} catch { invalidate(); return false; }
		},
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
			"/events": async (request, response, { backend, url }) => {
				if (!allowRead(request, response, url, backend.url)) return;
				pruneSubscriptions();
				let watcher: FSWatcher | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let stopped = false;
				const cleanup = () => {
					stopped = true;
					clearTimeout(timer);
					watcher?.close();
					subscriptions.delete(stop);
				};
				const stop = () => {
					if (stopped) return;
					cleanup();
					response.end("event: unavailable\ndata: {}\n\n");
				};
				response.once("close", cleanup);
				try {
					const binding = closed ? undefined : getBinding();
					if (!binding) return json(response, 404, { error: "Session scratch unavailable." });
					const workspace = await restoreSessionScratchWorkspace(binding);
					if (stopped || response.destroyed) return;
					if (!stillCurrent(binding)) return json(response, 404, { error: "Session scratch unavailable." });
					// Watch the directory, not the note inode: editors commonly save by rename.
					// Only invalidations cross SSE; all content goes through the bounded notes API.
					watcher = watch(workspace.paths.root, { persistent: false }, (_event, filename) => {
						if (stopped) return;
						if (filename && !["plan.md", "ledger.md", "meta.json", basename(workspace.paths.root)].includes(filename.toString())) return;
						clearTimeout(timer);
						timer = setTimeout(() => {
							if (!stillCurrent(binding)) return stop();
							if (!response.write("event: changed\ndata: {}\n\n")) stop();
						}, 60);
						timer.unref();
					});
					watcher.once("error", stop);
					subscriptions.set(stop, binding);
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "keep-alive" });
					response.write("event: ready\ndata: {}\n\n");
				} catch {
					cleanup();
					if (!response.destroyed) json(response, 404, { error: "Session scratch unavailable." });
				}
			},
		},
		close() { closed = true; invalidate(); },
	};
}
