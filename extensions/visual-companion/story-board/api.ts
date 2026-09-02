import { constants } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VisualCompanionRouteHandler, VisualCompanionViewer } from "../backend.mjs";
import { StoryBoardCache } from "./cache.js";
import type { CurrentStateObservation } from "./current-reader.js";
import { resolveCurrentEvidenceMember, resolveEvidenceMember } from "./evidence.js";
import { sanitizeMarkdown } from "./markdown-policy.js";
import type { DocumentDetail, ReportDetail, StoryWorkspace, TaskDetail } from "./models.js";
import { projectDeliveryHistory, StoryBoardReader } from "./reader.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "assets");
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const EVIDENCE_TYPES: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".yaml": "application/yaml; charset=utf-8", ".yml": "application/yaml; charset=utf-8", ".log": "text/plain; charset=utf-8",
};

export const STORY_BOARD_ROUTES = {
	catalog: "/api/catalog", workspace: "/api/workspace", task: "/api/task", document: "/api/document", report: "/api/report",
	refresh: "/api/refresh", diagnostics: "/api/diagnostics", evidence: "/api/evidence",
} as const;

type Reader = Pick<StoryBoardReader, "readCatalog" | "readWorkspace" | "readTaskDetail" | "readDocumentDetail" | "readReportDetail"> & {
	observeWorkspace?(storyId: string): Promise<CurrentStateObservation | undefined>;
};
export interface StoryBoardDiagnostics { state: "idle" | "active" | "closed"; catalogRequests: number; catalogReads: number; refreshes: number; completedEntries: number; inFlightEntries: number }
export interface StoryBoardViewerOptions {
	repositoryRoot: string;
	reader?: Reader;
	onCatalogRead?: () => void;
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
	response.end(JSON.stringify(value));
}
function notModified(response: ServerResponse, etag: string): void {
	response.writeHead(304, { etag, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end();
}
function matchesEtag(request: IncomingMessage, etag: string): boolean {
	const values = Array.isArray(request.headers["if-none-match"]) ? request.headers["if-none-match"] : [request.headers["if-none-match"]];
	const target = etag.replace(/^W\//, "");
	return values.flatMap((value) => value?.split(",") ?? []).some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === target);
}
function error(response: ServerResponse, status: number, message: string): void { json(response, status, { error: message }); }
function allowed(request: IncomingMessage, response: ServerResponse, method: "GET" | "POST"): boolean {
	if (request.method === method) return true;
	response.setHeader("allow", method); error(response, 405, "Method not allowed"); return false;
}
function parameter(url: URL, name: string): string | undefined { return url.searchParams.get(name) ?? url.searchParams.get(`${name}Id`) ?? undefined; }
function idParameter(url: URL, name: string): string | undefined { const value = parameter(url, name); return value && ID.test(value) ? value : undefined; }

function safeTask(detail: TaskDetail): TaskDetail {
	const { deliveryHistory: rawDeliveryHistory, ...safe } = detail;
	const deliveryHistory = projectDeliveryHistory(rawDeliveryHistory);
	return { ...safe, ...(safe.brief ? { brief: sanitizeMarkdown(safe.brief) } : {}), ...(safe.scope ? { scope: sanitizeMarkdown(safe.scope) } : {}), ...(safe.delivery ? { delivery: sanitizeMarkdown(safe.delivery) } : {}), ...(safe.acceptance ? { acceptance: sanitizeMarkdown(safe.acceptance) } : {}), ...(deliveryHistory ? { deliveryHistory } : {}) };
}
function safeDocument(detail: DocumentDetail): DocumentDetail { return { ...detail, ...(detail.body ? { body: sanitizeMarkdown(detail.body) } : {}) }; }
function safeReport(detail: ReportDetail, storyId: string): ReportDetail {
	const context = { storyId, evaluationId: detail.id, evidence: detail.evidence };
	return {
		...detail,
		...(detail.body ? { body: sanitizeMarkdown(detail.body, context) } : {}),
		findings: detail.findings.map((finding) => ({ ...finding, summary: sanitizeMarkdown(finding.summary, context) })),
		...(detail.riskAcceptance ? { riskAcceptance: sanitizeMarkdown(detail.riskAcceptance, context) } : {}),
		history: detail.history.map((attempt) => ({ ...attempt, ...(attempt.body ? { body: sanitizeMarkdown(attempt.body, context) } : {}) })),
	};
}

export function createStoryBoardViewer(options: StoryBoardViewerOptions): VisualCompanionViewer & { diagnostics(): StoryBoardDiagnostics } {
	const defaultReader = options.reader ? undefined : new StoryBoardReader(options.repositoryRoot);
	const reader: Reader = options.reader ?? defaultReader!;
	const observeWorkspace = reader.observeWorkspace?.bind(reader) ?? (defaultReader ? defaultReader.current.observeWorkspace.bind(defaultReader.current) : undefined);
	const cache = new StoryBoardCache();
	const observationSecret = randomBytes(32);
	const observedVersions = new Map<string, string | undefined>();
	let state: StoryBoardDiagnostics["state"] = "idle";
	let catalogRequests = 0;
	let catalogReads = 0;
	let refreshes = 0;

	const catalog = () => cache.read("catalog", async () => {
		state = "active"; catalogReads += 1; options.onCatalogRead?.(); return reader.readCatalog();
	});
	const wrap = (operation: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>): VisualCompanionRouteHandler => async (request, response, { url }) => {
		try { await operation(request, response, url); }
		catch { if (!response.headersSent) error(response, 500, "Story Board resource could not be loaded"); else response.end(); }
	};
	const handlers: Record<string, VisualCompanionRouteHandler> = {
		[STORY_BOARD_ROUTES.catalog]: wrap(async (request, response) => {
			if (!allowed(request, response, "GET")) return; catalogRequests += 1; json(response, 200, { stories: await catalog() });
		}),
		[STORY_BOARD_ROUTES.workspace]: wrap(async (request, response, url) => {
			if (!allowed(request, response, "GET")) return; const story = idParameter(url, "story"); if (!story) return error(response, 400, "A valid story id is required");
			const before = await observeWorkspace?.(story); const previouslyObserved = observedVersions.has(story); const previousVersion = observedVersions.get(story);
			if (previouslyObserved && previousVersion !== before?.versionSeed) cache.invalidate();
			observedVersions.set(story, before?.versionSeed);
			if (!before) {
				const value = await cache.read(`workspace:${story}`, () => reader.readWorkspace(story)); const after = await observeWorkspace?.(story);
				if (after) { cache.invalidate(); observedVersions.set(story, after.versionSeed); return json(response, 409, { retry: true }); }
				return value ? json(response, 200, { workspace: value }) : error(response, 404, "Story not found");
			}
			const revision = createHmac("sha256", observationSecret).update(before.versionSeed).digest("base64url"); const etag = `W/"${revision}"`;
			if (previouslyObserved && matchesEtag(request, etag)) return notModified(response, etag);
			const value = await cache.read(`workspace:${story}`, () => reader.readWorkspace(story));
			const after = await observeWorkspace?.(story);
			if (!after || after.versionSeed !== before.versionSeed) {
				cache.invalidate(); observedVersions.set(story, after?.versionSeed); return json(response, 409, { retry: true });
			}
			if (!value) return error(response, 404, "Story not found");
			json(response, 200, { workspace: value, observation: { revision, status: after.status, ...(after.outcomeStatus ? { outcomeStatus: after.outcomeStatus } : {}) } }, { etag });
		}),
		[STORY_BOARD_ROUTES.task]: wrap(async (request, response, url) => {
			if (!allowed(request, response, "GET")) return; const story = idParameter(url, "story"); const task = idParameter(url, "task"); if (!story || !task) return error(response, 400, "Valid story and task ids are required");
			const value = await cache.read(`task:${story}:${task}`, () => reader.readTaskDetail(story, task)); value ? json(response, 200, { task: safeTask(value) }) : error(response, 404, "Task not found");
		}),
		[STORY_BOARD_ROUTES.document]: wrap(async (request, response, url) => {
			if (!allowed(request, response, "GET")) return; const story = idParameter(url, "story"); const document = idParameter(url, "document"); if (!story || !document) return error(response, 400, "Valid story and document ids are required");
			const value = await cache.read(`document:${story}:${document}`, () => reader.readDocumentDetail(story, document)); value ? json(response, 200, { document: safeDocument(value) }) : error(response, 404, "Document not found");
		}),
		[STORY_BOARD_ROUTES.report]: wrap(async (request, response, url) => {
			if (!allowed(request, response, "GET")) return; const story = idParameter(url, "story"); const report = idParameter(url, "report"); if (!story || !report) return error(response, 400, "Valid story and report ids are required");
			const value = await cache.read(`report:${story}:${report}`, () => reader.readReportDetail(story, report)); value ? json(response, 200, { report: safeReport(value, story) }) : error(response, 404, "Report not found");
		}),
		[STORY_BOARD_ROUTES.refresh]: wrap(async (request, response) => {
			if (!allowed(request, response, "POST")) return; refreshes += 1; cache.invalidate(); observedVersions.clear(); const replacement = catalog(); void replacement.catch(() => {}); json(response, 202, { accepted: true });
		}),
		[STORY_BOARD_ROUTES.diagnostics]: wrap(async (request, response) => {
			if (!allowed(request, response, "GET")) return; json(response, 200, diagnostics());
		}),
		[STORY_BOARD_ROUTES.evidence]: wrap(async (request, response, url) => {
			if (!allowed(request, response, "GET")) return; const story = idParameter(url, "story"); const evaluation = idParameter(url, "evaluation"); const memberPath = url.searchParams.get("path");
			if (!story || !evaluation || !memberPath) return error(response, 400, "Valid story, evaluation, and evidence path are required");
			// Reading the selected report validates legacy catalog membership or current state authority.
			const report = await cache.read(`report:${story}:${evaluation}`, () => reader.readReportDetail(story, evaluation));
			const metadata = report?.evidence.find((item) => item.memberPath === memberPath || item.path === `agent-artifacts/${story}/evidence/${evaluation}/${memberPath}`);
			if (!metadata?.manifestMember || !metadata.available || !metadata.supported || !metadata.mediaType) return error(response, 404, "Evidence not available");
			const path = metadata.memberPath ? await resolveCurrentEvidenceMember(options.repositoryRoot, story, memberPath) : await resolveEvidenceMember(options.repositoryRoot, story, evaluation, memberPath); if (!path) return error(response, 404, "Evidence not available");
			const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const info = await handle.stat(); if (!info.isFile()) return error(response, 404, "Evidence not available"); if (info.size > MAX_EVIDENCE_BYTES) return error(response, 413, "Evidence is too large");
				let bytes = await handle.readFile(); const extension = extname(path).toLowerCase(); const type = EVIDENCE_TYPES[extension]; if (!type) return error(response, 415, "Evidence type is unsupported");
				if ([".md", ".txt", ".log"].includes(extension)) bytes = Buffer.from(sanitizeMarkdown(bytes.toString("utf8")));
				response.writeHead(200, { "content-type": type, "content-length": bytes.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" }); response.end(bytes);
			} finally { await handle.close(); }
		}),
	};
	function diagnostics(): StoryBoardDiagnostics { return { state, catalogRequests, catalogReads, refreshes, completedEntries: cache.size, inFlightEntries: cache.pending }; }
	return { id: "story-board", assetsDir: ASSETS_DIR, handlers, diagnostics, close() { state = "closed"; cache.close(); } };
}
