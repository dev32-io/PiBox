import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STORE_KEY = Symbol.for("pibox.system-prompt-contributions.v1");
const MARKER_TYPE = "pibox-system-prompt-request";
const BLOCK_START = "<pibox-system-prompt-contributions>";
const BLOCK_END = "</pibox-system-prompt-contributions>";

export interface SystemPromptContribution {
	id: string;
	order: number;
	render(ctx: ExtensionContext): string | undefined | Promise<string | undefined>;
}

interface SessionContributions {
	marker: string;
	contributions: Map<string, SystemPromptContribution>;
}

interface Store {
	sessions: Map<string, SessionContributions>;
	inactiveSessions: Set<string>;
	installed: WeakSet<object>;
}

function store(): Store {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
	return root[STORE_KEY] ??= { sessions: new Map(), inactiveSessions: new Set(), installed: new WeakSet() };
}

function sessionContributions(shared: Store, sessionId: string): SessionContributions {
	let session = shared.sessions.get(sessionId);
	if (!session) {
		session = { marker: `pibox-request-${randomBytes(32).toString("base64url")}`, contributions: new Map() };
		shared.sessions.set(sessionId, session);
	}
	return session;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function anthropicCacheControl(value: unknown): Record<string, unknown> {
	const control = record(value);
	if (!control || control.type !== "ephemeral" || !Object.keys(control).every((key) => key === "type" || key === "ttl") || (control.ttl !== undefined && control.ttl !== "5m" && control.ttl !== "1h")) {
		throw new Error("Unsupported Anthropic cache_control shape");
	}
	return control;
}

function markerBlock(value: unknown, marker: string, anthropic = false): boolean {
	const block = record(value);
	if (block?.text !== marker || !Object.keys(block).every((key) => key === "text" || key === "type" || (anthropic && key === "cache_control"))) return false;
	if (block.cache_control !== undefined) anthropicCacheControl(block.cache_control);
	return block.type === undefined || block.type === "text" || block.type === "input_text";
}

function containsExactMarker(value: unknown, marker: string): boolean {
	if (value === marker) return true;
	if (Array.isArray(value)) return value.some((item) => containsExactMarker(item, marker));
	const object = record(value);
	return object ? Object.values(object).some((item) => containsExactMarker(item, marker)) : false;
}

function removeMarkerMessages(value: unknown, marker: string, contentKey: "content" | "parts" = "content", anthropic = false): unknown[] | undefined {
	if (!Array.isArray(value)) return undefined;
	let found = 0;
	let markerCache: Record<string, unknown> | undefined;
	const messages = value.flatMap((item) => {
		const message = record(item);
		if (!message || (message.role !== "user" && message.role !== "custom")) return [item];
		const content = message[contentKey];
		if (content === marker) {
			found++;
			return [];
		}
		if (!Array.isArray(content)) return [item];
		const filtered = content.filter((block) => {
			if (!markerBlock(block, marker, anthropic)) return true;
			const entry = record(block);
			if (entry?.cache_control !== undefined) markerCache = anthropicCacheControl(entry.cache_control);
			found++;
			return false;
		});
		if (filtered.length === content.length) return [item];
		return filtered.length > 0 ? [{ ...message, [contentKey]: filtered }] : [];
	});
	if (found > 1) throw new Error("PiBox system-prompt request marker appeared more than once");
	if (found !== 1) return undefined;
	if (markerCache) {
		for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
			const message = record(messages[messageIndex]);
			const content = message?.role === "user" ? message[contentKey] : undefined;
			if (!Array.isArray(content) || content.length === 0) continue;
			const last = record(content[content.length - 1]);
			if (last) messages[messageIndex] = { ...message, [contentKey]: [...content.slice(0, -1), { ...last, cache_control: markerCache }] };
			break;
		}
	}
	return messages;
}

function stripBlock(text: string): string {
	const blockStart = text.indexOf(BLOCK_START);
	if (blockStart < 0) return text;
	if (blockStart > 0 && text.slice(blockStart - 2, blockStart) !== "\n\n") throw new Error("Malformed PiBox system-prompt contribution block");
	const end = text.indexOf(BLOCK_END, blockStart);
	if (end < 0 || text.indexOf(BLOCK_START, blockStart + BLOCK_START.length) >= 0) {
		throw new Error("Malformed PiBox system-prompt contribution block");
	}
	const start = blockStart === 0 ? 0 : blockStart - 2;
	return `${text.slice(0, start)}${text.slice(end + BLOCK_END.length)}`;
}

export function formatSystemPromptContributions(contributions: readonly { id: string; text: string }[]): string {
	return `${BLOCK_START}\n${contributions.map(({ id, text }) => `<pibox-contribution id="${id}">\n${text}\n</pibox-contribution>`).join("\n")}\n${BLOCK_END}`;
}

export function replaceSystemPromptContributions(base: string, contributions: readonly { id: string; text: string }[]): string {
	const clean = stripBlock(base);
	return contributions.length === 0 ? clean : `${clean}\n\n${formatSystemPromptContributions(contributions)}`;
}

function appendBlock(base: string, block: string): string {
	return `${stripBlock(base)}\n\n${block}`;
}

function replaceMessageSystem(messages: unknown[], block: string): unknown[] {
	let found = false;
	const next = messages.map((item) => {
		const message = record(item);
		if (!message || (message.role !== "system" && message.role !== "developer")) return item;
		if (found || typeof message.content !== "string") throw new Error("Unsupported system message shape");
		found = true;
		return { ...message, content: appendBlock(message.content, block) };
	});
	if (!found) throw new Error("Provider payload has no system message");
	return next;
}

function replaceBlockSystem(value: unknown, block: string): unknown[] {
	if (!Array.isArray(value)) throw new Error("Provider payload has no system blocks");
	const next = value.flatMap((item) => {
		const entry = record(item);
		if (!entry || typeof entry.text !== "string") return [item];
		const text = stripBlock(entry.text);
		return text ? [{ ...entry, text }] : [];
	});
	next.push({ text: block });
	return next;
}

function replaceAnthropicSystem(value: unknown, block: string): unknown[] {
	if (!Array.isArray(value)) throw new Error("Provider payload has no system blocks");
	let cachedIndex = -1;
	let cacheControl: Record<string, unknown> | undefined;
	for (let index = 0; index < value.length; index++) {
		const entry = record(value[index]);
		if (typeof entry?.text === "string" && entry.cache_control !== undefined) {
			cachedIndex = index;
			cacheControl = anthropicCacheControl(entry.cache_control);
		}
	}
	const next = value.flatMap((item, index) => {
		const entry = record(item);
		if (!entry || typeof entry.text !== "string") return [item];
		const text = stripBlock(entry.text);
		if (index !== cachedIndex) return text ? [{ ...entry, text }] : [];
		const { cache_control: _cacheControl, ...rest } = entry;
		return text ? [{ ...rest, text }] : [];
	});
	next.push({ type: "text", text: block, ...(cacheControl ? { cache_control: cacheControl } : {}) });
	return next;
}

/** Testable payload transformer used by the extension hook. Returns undefined for non-agent requests. */
export function applySystemPromptContributions(payload: unknown, api: string, marker: string, contributions: readonly { id: string; text: string }[]): unknown | undefined {
	const body = record(payload);
	if (!body) {
		if (containsExactMarker(payload, marker)) throw new Error(`Unsupported ${api} provider payload`);
		return undefined;
	}
	const block = formatSystemPromptContributions(contributions);
	let messages: unknown[] | undefined;
	let next: Record<string, unknown>;

	switch (api) {
		case "openai-completions":
		case "mistral-conversations":
			messages = removeMarkerMessages(body.messages, marker);
			if (!messages) break;
			next = { ...body, messages: replaceMessageSystem(messages, block) };
			return next;
		case "openai-responses":
		case "azure-openai-responses":
			messages = removeMarkerMessages(body.input, marker);
			if (!messages) break;
			return { ...body, input: replaceMessageSystem(messages, block) };
		case "openai-codex-responses":
			messages = removeMarkerMessages(body.input, marker);
			if (!messages) break;
			if (typeof body.instructions !== "string") throw new Error("Codex payload has no instructions");
			return { ...body, input: messages, instructions: replaceSystemPromptContributions(body.instructions, contributions) };
		case "anthropic-messages":
			messages = removeMarkerMessages(body.messages, marker, "content", true);
			if (!messages) break;
			return { ...body, messages, system: replaceAnthropicSystem(body.system, block) };
		case "bedrock-converse-stream":
			messages = removeMarkerMessages(body.messages, marker);
			if (!messages) break;
			return { ...body, messages, system: replaceBlockSystem(body.system, block) };
		case "google-generative-ai":
		case "google-vertex": {
			messages = removeMarkerMessages(body.contents, marker, "parts");
			if (!messages) break;
			const config = record(body.config);
			if (!config || typeof config.systemInstruction !== "string") throw new Error("Google payload has no systemInstruction");
			return { ...body, contents: messages, config: { ...config, systemInstruction: appendBlock(config.systemInstruction, block) } };
		}
		case "pi-messages": {
			const context = record(body.context);
			messages = removeMarkerMessages(context?.messages, marker);
			if (!messages) break;
			if (!context || typeof context.systemPrompt !== "string") throw new Error("pi-messages payload has no systemPrompt");
			return { ...body, context: { ...context, messages, systemPrompt: appendBlock(context.systemPrompt, block) } };
		}
	}

	if (containsExactMarker(payload, marker)) throw new Error(`Unsupported ${api} provider payload shape`);
	return undefined;
}

// Pi logs and swallows extension-hook throws. Replace request with an invalid provider payload so authority loss fails closed instead.
function failurePayload(error: unknown): Record<string, string> {
	return { __pibox_system_prompt_error: error instanceof Error ? error.message : String(error) };
}

/** Register one session-scoped true-system contribution. Lower orders render first; mode uses 100 and workspace uses 200. */
export function registerSystemPromptContribution(pi: ExtensionAPI, contribution: SystemPromptContribution): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/u.test(contribution.id)) throw new Error(`Invalid system-prompt contribution id: ${contribution.id}`);
	if (!Number.isFinite(contribution.order)) throw new Error(`Invalid system-prompt contribution order: ${contribution.order}`);
	const shared = store();
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		shared.inactiveSessions.delete(sessionId);
		sessionContributions(shared, sessionId).contributions.set(contribution.id, contribution);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const session = shared.sessions.get(sessionId);
		if (session?.contributions.get(contribution.id) === contribution) session.contributions.delete(contribution.id);
		if (session?.contributions.size === 0) shared.sessions.delete(sessionId);
		shared.inactiveSessions.add(sessionId);
	});
	if (shared.installed.has(pi as object)) return;
	shared.installed.add(pi as object);

	pi.on("context", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (shared.inactiveSessions.has(sessionId)) return;
		const session = shared.sessions.get(sessionId) ?? sessionContributions(shared, sessionId);
		if (!session.contributions.has(contribution.id)) session.contributions.set(contribution.id, contribution);
		const messages = event.messages.filter((message: any) => !(message?.role === "custom" && message?.customType === MARKER_TYPE));
		let insertion = messages.length;
		for (let index = messages.length - 1; index >= 0; index--) if ((messages[index] as any)?.role === "user") { insertion = index; break; }
		messages.splice(insertion, 0, { role: "custom", customType: MARKER_TYPE, content: session.marker, display: false, timestamp: 0 });
		return { messages };
	});
	pi.on("before_provider_request", async (event, ctx) => {
		try {
			const session = shared.sessions.get(ctx.sessionManager.getSessionId());
			if (!session || !containsExactMarker(event.payload, session.marker)) return;
			const contributions: Array<{ id: string; text: string }> = [];
			for (const current of [...session.contributions.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
				const text = (await current.render(ctx))?.trim();
				if (text) contributions.push({ id: current.id, text });
			}
			return applySystemPromptContributions(event.payload, ctx.model?.api ?? "unknown", session.marker, contributions);
		} catch (error) {
			return failurePayload(error);
		}
	});
}
