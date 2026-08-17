import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearUsage, normalizeWindows, publishUsage, type UsageSnapshot, type UsageWindow } from "../shared/usage.js";

const PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Normalize account rate-limit data without assuming fixed window names or durations. */
export function normalizeCodexUsage(payload: unknown): UsageWindow[] {
	const body = record(payload);
	if (!body) return [];
	const rawRateLimit = body.rate_limit ?? body.rateLimit ?? body.rate_limits ?? body.rateLimits;
	if (Array.isArray(rawRateLimit)) return normalizeWindows(rawRateLimit);
	const rateLimit = record(rawRateLimit) ?? body;
	const ordered = [
		rateLimit.primary_window,
		rateLimit.primaryWindow,
		rateLimit.primary,
		rateLimit.secondary_window,
		rateLimit.secondaryWindow,
		rateLimit.secondary,
	].filter((value, index, values) => value !== undefined && values.indexOf(value) === index);
	if (ordered.length) return normalizeWindows(ordered);
	if (Array.isArray(body.windows)) return normalizeWindows(body.windows);
	return normalizeWindows([body]);
}

export async function fetchCodexUsage(
	auth: { apiKey: string; accountId?: string },
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<UsageWindow[]> {
	if (!auth.apiKey) return [];
	try {
		const headers: Record<string, string> = { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" };
		if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
		const response = await fetchImpl(USAGE_URL, { headers, ...(signal ? { signal } : {}) });
		if (!response.ok) return [];
		return normalizeCodexUsage(await response.json());
	} catch {
		return [];
	}
}

function accountId(headers: Record<string, string | null> | undefined): string | undefined {
	if (!headers) return undefined;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "chatgpt-account-id" && value) return value;
	}
	return undefined;
}

export default function codexUsage(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let controller: AbortController | undefined;
	let lastSnapshot: UsageSnapshot | undefined;
	let credentialFingerprint: string | undefined;
	let activeContext: ExtensionContext | undefined;

	const stop = (clear = false) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		controller?.abort();
		controller = undefined;
		if (clear && activeContext) clearUsage(activeContext, PROVIDER);
		activeContext = undefined;
	};

	const refresh = async (ctx: ExtensionContext) => {
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER || !ctx.modelRegistry.isUsingOAuth(model)) {
			lastSnapshot = undefined;
			credentialFingerprint = undefined;
			clearUsage(ctx, PROVIDER);
			return;
		}
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.apiKey) {
			lastSnapshot = undefined;
			credentialFingerprint = undefined;
			clearUsage(ctx, PROVIDER);
			return;
		}
		controller?.abort();
		controller = new AbortController();
		const resolvedAccountId = accountId(resolved.headers);
		const nextFingerprint = createHash("sha256").update(`${resolvedAccountId ?? ""}\0${resolved.apiKey}`).digest("hex");
		if (credentialFingerprint !== nextFingerprint) {
			lastSnapshot = undefined;
			clearUsage(ctx, PROVIDER);
			credentialFingerprint = nextFingerprint;
		}
		const windows = await fetchCodexUsage({ apiKey: resolved.apiKey, ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}) }, fetch, controller.signal);
		if (windows.length) {
			lastSnapshot = { provider: PROVIDER, windows, observedAt: Date.now() };
			publishUsage(ctx, lastSnapshot);
		} else if (lastSnapshot) {
			publishUsage(ctx, { ...lastSnapshot, stale: true });
		}
	};

	const activate = (ctx: ExtensionContext) => {
		stop(ctx.model?.provider !== PROVIDER);
		activeContext = ctx;
		if (ctx.model?.provider !== PROVIDER) return;
		void refresh(ctx);
		timer = setInterval(() => void refresh(ctx), REFRESH_MS);
	};

	pi.on("session_start", (_event, ctx) => activate(ctx));
	pi.on("model_select", (_event, ctx) => activate(ctx));
	pi.on("session_shutdown", (_event, ctx) => { stop(); clearUsage(ctx, PROVIDER); lastSnapshot = undefined; credentialFingerprint = undefined; });
}
