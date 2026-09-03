import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSubagentRuntime } from "../core/runtime-role.js";
import { currentWorkMode } from "../work-mode/runtime.js";
import {
	createSessionScratchWorkspace,
	purgeSessionScratchWorkspace,
	restoreSessionScratchWorkspace,
	WorkspaceValidationError,
	type SessionScratchBinding,
	type SessionScratchWorkspace,
} from "./workspace.js";

const ENTRY_TYPE = "pibox-session-scratch-v1";
const STATUS_KEY = "pibox-session-scratch";

interface ScratchEntry {
	schemaVersion: 1;
	binding: SessionScratchBinding | null;
}

function parseEntry(value: unknown): ScratchEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ScratchEntry>;
	if (candidate.schemaVersion !== 1) return undefined;
	if (candidate.binding === null) return { schemaVersion: 1, binding: null };
	const binding = candidate.binding as Partial<SessionScratchBinding> | undefined;
	if (!binding || typeof binding.workspaceId !== "string" || typeof binding.sessionId !== "string") return undefined;
	return { schemaVersion: 1, binding: { workspaceId: binding.workspaceId, sessionId: binding.sessionId } };
}

function restoreEntry(ctx: ExtensionContext): ScratchEntry {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const parsed = parseEntry(entry.data);
		if (parsed) return parsed;
	}
	return { schemaVersion: 1, binding: null };
}

function workspaceSummary(workspace: SessionScratchWorkspace, note?: string): string {
	return [
		note,
		"Session scratch is private, temporary, and non-authoritative. /tmp retention is best effort only.",
		`Root: ${workspace.paths.root}`,
		`Plan: ${workspace.paths.plan}`,
		`Ledger: ${workspace.paths.ledger}`,
		`Scripts: ${workspace.paths.scripts}`,
		`Results: ${workspace.paths.results}`,
	].filter(Boolean).join("\n");
}

export default function sessionScratchExtension(pi: ExtensionAPI): void {
	if (isSubagentRuntime(process.env)) return;

	let sessionCtx: ExtensionContext | undefined;
	let entry: ScratchEntry = { schemaVersion: 1, binding: null };
	let workspace: SessionScratchWorkspace | undefined;
	let unavailable: string | undefined;
	let continuityNote: string | undefined;
	let runUsesScratch = false;

	const sessionId = () => {
		if (!sessionCtx) throw new Error("Session scratch is not bound to an active Pi session");
		return sessionCtx.sessionManager.getSessionId();
	};
	const persist = (binding: SessionScratchBinding | null) => {
		entry = { schemaVersion: 1, binding };
		pi.appendEntry(ENTRY_TYPE, entry);
		if (sessionCtx?.hasUI) sessionCtx.ui.setStatus(STATUS_KEY, binding ? "scratch:ready" : undefined);
	};
	const createFresh = async (note?: string) => {
		workspace = await createSessionScratchWorkspace(sessionId());
		unavailable = undefined;
		continuityNote = note;
		persist(workspace.binding);
		return workspace;
	};
	const attach = async (createWhenAbsent: boolean): Promise<SessionScratchWorkspace | undefined> => {
		if (workspace) return workspace;
		const binding = entry.binding;
		if (!binding) return createWhenAbsent ? createFresh() : undefined;
		if (binding.sessionId !== sessionId()) {
			return createWhenAbsent
				? createFresh("This session inherited a mode selection but not its parent session's mutable scratch; a distinct workspace was created.")
				: undefined;
		}
		try {
			workspace = await restoreSessionScratchWorkspace(binding);
			unavailable = undefined;
			return workspace;
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
			if (createWhenAbsent) return undefined;
			return undefined;
		}
	};
	const reset = async () => {
		const old = await attach(false);
		if (old) await purgeSessionScratchWorkspace(old.binding);
		workspace = undefined;
		unavailable = undefined;
		return createFresh(old ? "The previous scratch workspace was purged and replaced." : "The prior scratch binding was unavailable; a fresh workspace was created without claiming continuity.");
	};

	pi.registerTool({
		name: "scratch_workspace",
		label: "Session Scratch",
		description: "Inspect or initialize this Pi session's private, non-authoritative /tmp scratch workspace.",
		promptSnippet: "Inspect or initialize private session scratch",
		promptGuidelines: [
			"Scratch is optional in Agent mode and mandatory working memory in Orchestrator mode.",
			"Never treat scratch as workflow authority or durable repository state.",
			"If prior scratch is missing or invalid, report the lost continuity before initializing a replacement.",
		],
		parameters: Type.Object({ action: StringEnum(["status", "init"] as const) }),
		async execute(_toolCallId, input) {
			const existing = await attach(false);
			if (input.action === "status") {
				const text = existing
					? workspaceSummary(existing, continuityNote)
					: unavailable
						? `The saved scratch workspace is missing or invalid: ${unavailable}\nContinuity was not silently recreated. Use action=init to create a fresh workspace.`
						: entry.binding && entry.binding.sessionId !== sessionId()
							? "This fork does not share its parent session's mutable scratch. Use action=init to create a distinct workspace."
							: "No session scratch workspace exists. Use action=init when scratch would help.";
				return { content: [{ type: "text", text }], details: { available: Boolean(existing) } };
			}
			const created = existing ?? await createFresh(unavailable
				? "The saved scratch workspace was missing or invalid. A fresh workspace was created without claiming continuity."
				: entry.binding?.sessionId !== sessionId()
					? "This fork received a distinct mutable scratch workspace."
					: undefined);
			return { content: [{ type: "text", text: workspaceSummary(created, continuityNote) }], details: { available: true } };
		},
	});

	pi.registerCommand("scratch", {
		description: "Show, reset, or purge the private session scratch workspace",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				const current = await attach(false);
				ctx.ui.notify(current ? workspaceSummary(current, continuityNote) : unavailable ? `Scratch unavailable: ${unavailable}` : "No session scratch workspace exists.", unavailable ? "warning" : "info");
				return;
			}
			if (action !== "reset" && action !== "purge") {
				ctx.ui.notify("Usage: /scratch [status|reset|purge]", "warning");
				return;
			}
			await ctx.waitForIdle();
			const confirmed = await ctx.ui.confirm(action === "purge" ? "Purge session scratch?" : "Reset session scratch?", action === "purge"
				? "This permanently removes the current private scratch workspace."
				: "This permanently removes a valid current workspace and creates an empty replacement. An unavailable binding will be replaced without claiming continuity.");
			if (!confirmed) return;
			if (action === "reset") {
				const fresh = await reset();
				ctx.ui.notify(workspaceSummary(fresh, continuityNote), "info");
				return;
			}
			const current = await attach(false);
			if (!current) {
				ctx.ui.notify(unavailable ? `Scratch cannot be safely purged because validation failed: ${unavailable}` : "No scratch workspace exists.", unavailable ? "error" : "info");
				return;
			}
			await purgeSessionScratchWorkspace(current.binding);
			workspace = undefined;
			unavailable = undefined;
			continuityNote = undefined;
			persist(null);
			ctx.ui.notify("Session scratch workspace purged.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		entry = restoreEntry(ctx);
		workspace = undefined;
		unavailable = undefined;
		continuityNote = undefined;
		runUsesScratch = false;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, entry.binding ? "scratch:saved" : undefined);
	});
	pi.on("session_tree", (_event, ctx) => {
		sessionCtx = ctx;
		entry = restoreEntry(ctx);
		workspace = undefined;
		unavailable = undefined;
		continuityNote = undefined;
		runUsesScratch = false;
	});
	pi.on("before_agent_start", () => {
		const mode = currentWorkMode();
		runUsesScratch = mode === "orchestrator" || mode === "agent" && Boolean(entry.binding || workspace);
	});
	pi.on("context", async (event) => {
		if (!runUsesScratch) return;
		const mandatory = currentWorkMode() === "orchestrator";
		let current: SessionScratchWorkspace | undefined;
		try {
			current = await attach(mandatory);
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
		}
		const content = current
			? workspaceSummary(current, continuityNote)
			: unavailable
				? `Session scratch is unavailable: ${unavailable}\nContinuity was not silently recreated. Initialize a fresh workspace explicitly before relying on scratch.`
				: entry.binding && entry.binding.sessionId !== sessionId()
					? "This fork does not share its parent session's mutable scratch. Initialize a distinct workspace before relying on scratch."
					: "This session has no scratch workspace.";
		const messages = event.messages.filter((message: any) => !(message?.role === "custom" && message?.customType === "pibox-session-scratch"));
		let insertion = messages.length;
		for (let index = messages.length - 1; index >= 0; index--) if ((messages[index] as any)?.role === "user") { insertion = index; break; }
		messages.splice(insertion, 0, { role: "custom", customType: "pibox-session-scratch", content, display: false, timestamp: Date.now() });
		return { messages };
	});
	pi.on("agent_settled", () => { runUsesScratch = false; });
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		sessionCtx = undefined;
		entry = { schemaVersion: 1, binding: null };
		workspace = undefined;
		unavailable = undefined;
		continuityNote = undefined;
		runUsesScratch = false;
	});
}

export { ENTRY_TYPE as SESSION_SCRATCH_ENTRY_TYPE };
