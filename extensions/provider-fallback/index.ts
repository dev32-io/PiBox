import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One concrete route within an already-selected capability tier. */
export interface ProviderRoute {
	provider: string;
	model: string;
	effort: string;
}

export type ProviderFailureKind = "rate_limit" | "capacity" | "auth" | "transport" | "server" | "non_recoverable";

export interface ProviderFailure {
	kind: ProviderFailureKind;
	cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
	if (typeof value !== "string") return undefined;
	const seconds = Number(value.trim());
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_COOLDOWN_MS, seconds * 1_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.min(MAX_COOLDOWN_MS, Math.max(0, date - now)) : undefined;
}

function eventErrorText(events: readonly unknown[]): string {
	const errors: string[] = [];
	for (const raw of events) {
		if (!raw || typeof raw !== "object") continue;
		const event = raw as { type?: string; error?: unknown; message?: { role?: string; stopReason?: string; errorMessage?: string } };
		if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
			if (event.message.errorMessage) errors.push(event.message.errorMessage);
		} else if (event.type === "error") {
			errors.push(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
		}
	}
	return errors.join("\n");
}

/** Classify only provider failures for which trying another configured route is safe. */
export function classifyProviderFailure(
	result: { exitCode: number; stderr?: string; events?: readonly unknown[] },
	signal?: AbortSignal,
): ProviderFailure {
	if (signal?.aborted) return { kind: "non_recoverable" };
	const text = `${result.stderr ?? ""}\n${eventErrorText(result.events ?? [])}`.toLowerCase();
	if (!text.trim()) return { kind: "non_recoverable" };
	const retry = text.match(/retry-after\s*[:=]\s*([^\s,;}]+)/i)?.[1];
	const cooldownMs = retryAfterMs(retry) ?? DEFAULT_COOLDOWN_MS;

	if (/(context.{0,24}(window|length|overflow|exceeded)|prompt.{0,20}too long|maximum context)/i.test(text)) return { kind: "non_recoverable" };
	if (/(cancelled|canceled|aborted|sigterm|protocol[_ -]?failed)/i.test(text)) return { kind: "non_recoverable" };
	if (/(\b429\b|rate.?limit|too many requests|usage limit|subscription limit|quota|resource exhausted)/i.test(text)) return { kind: "rate_limit", cooldownMs };
	if (/(capacity|overloaded|temporarily unavailable|model.{0,20}(not found|unavailable)|unknown model)/i.test(text)) return { kind: "capacity", cooldownMs };
	if (/(\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication failed|invalid (api )?key|no api key|api key.{0,20}not found|expired token|login required|missing credentials|credentials.{0,20}missing)/i.test(text)) return { kind: "auth", cooldownMs };
	if (/(econnreset|etimedout|eai_again|enotfound|network error|fetch failed|socket hang up|connection reset|connection timed out)/i.test(text)) return { kind: "transport", cooldownMs };
	if (/(\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway timeout)/i.test(text)) return { kind: "server", cooldownMs };
	return { kind: "non_recoverable" };
}

export class ProviderCooldowns {
	private readonly until = new Map<string, number>();

	mark(provider: string, durationMs = DEFAULT_COOLDOWN_MS, now = Date.now()): void {
		this.until.set(provider, now + Math.min(MAX_COOLDOWN_MS, Math.max(0, durationMs)));
	}

	available(provider: string, now = Date.now()): boolean {
		return (this.until.get(provider) ?? 0) <= now;
	}

	clear(provider: string): void {
		this.until.delete(provider);
	}

	clearAll(): void {
		this.until.clear();
	}
}

const COOLDOWNS_KEY = Symbol.for("pibox:provider-cooldowns");
type CooldownGlobal = typeof globalThis & { [COOLDOWNS_KEY]?: ProviderCooldowns };
const sharedGlobal = globalThis as CooldownGlobal;
export const defaultProviderCooldowns = sharedGlobal[COOLDOWNS_KEY] ??= new ProviderCooldowns();

export function isFallbackEligible(failure: ProviderFailure): boolean {
	return failure.kind !== "non_recoverable";
}

export function observeProviderResponse(
	provider: string,
	response: { status?: number; headers?: Record<string, string> },
	cooldowns = defaultProviderCooldowns,
): void {
	if (response.status !== 429) return;
	const retryAfter = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	cooldowns.mark(provider, retryAfterMs(retryAfter) ?? DEFAULT_COOLDOWN_MS);
}

/** Observe main-session provider limits so later subagent routes can skip a known-limited provider. */
export default function providerFallback(pi: ExtensionAPI): void {
	pi.on("session_start", () => defaultProviderCooldowns.clearAll());
	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider) observeProviderResponse(provider, event);
	});
}
