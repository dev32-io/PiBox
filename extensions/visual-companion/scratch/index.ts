import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
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

/** The owner supplies a current-session binding, never a browser-selected path or session id. */
export function createScratchViewer(getBinding: () => SessionScratchBinding | undefined): VisualCompanionViewer {
	let closed = false;
	const stillCurrent = (binding: SessionScratchBinding) => {
		const current = closed ? undefined : getBinding();
		return current?.sessionId === binding.sessionId && current.workspaceId === binding.workspaceId;
	};
	return {
		id: "scratch",
		async isAvailable() {
			try {
				const binding = closed ? undefined : getBinding();
				if (!binding) return false;
				await restoreSessionScratchWorkspace(binding);
				return stillCurrent(binding);
			} catch { return false; }
		},
		resolveAsset(route) {
			const name = ASSETS.get(route);
			return name ? { path: join(ASSETS_DIR, name), headers: { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } } : undefined;
		},
		handlers: {
			"/api/notes": async (request, response, { backend, url }) => {
				if (request.method !== "GET") {
					response.setHeader("allow", "GET");
					return json(response, 405, { error: "Read-only resource." });
				}
				// Protect private notes against foreign origins and DNS rebinding. No CORS opt-in.
				const origin = new URL(backend.url);
				if (request.headers.host !== origin.host || (request.headers.origin && request.headers.origin !== origin.origin)
					|| request.headers["sec-fetch-site"] === "cross-site") {
					return json(response, 403, { error: "Same-origin access required." });
				}
				if (url.search) return json(response, 400, { error: "This resource accepts no parameters." });
				try {
					const binding = closed ? undefined : getBinding();
					if (!binding) return json(response, 404, { error: "Session scratch unavailable." });
					const notes = await readSessionScratchNotes(binding);
					if (!stillCurrent(binding)) return json(response, 404, { error: "Session scratch unavailable." });
					json(response, 200, notes);
				} catch { json(response, 404, { error: "Session scratch unavailable." }); }
			},
		},
		close() { closed = true; },
	};
}
