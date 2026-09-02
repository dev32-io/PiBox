import type { EvidenceMetadata } from "./models.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|file|blob):/i;

export interface MarkdownPolicyContext {
	storyId?: string;
	evaluationId?: string;
	evidence?: readonly EvidenceMetadata[];
	viewerBase?: string;
}

function normalizedUrl(value: string): string {
	return value.trim().replace(/&colon;/gi, ":").replace(/&#0*58;/gi, ":").replace(/[\u0000-\u0020]+/g, "");
}

/** URLs passed to the browser renderer must be navigable but never scriptable. */
export function safeMarkdownLink(value: string): string | undefined {
	const normalized = normalizedUrl(value);
	if (!normalized || UNSAFE_SCHEME.test(normalized)) return undefined;
	if (normalized.startsWith("//")) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !/^(?:https?|mailto):/i.test(normalized)) return undefined;
	return value.trim();
}

function relativeEvidencePath(value: string, evaluationId: string): string | undefined {
	let decoded: string;
	try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? ""); } catch { return undefined; }
	const prefixes = [`../../evidence/${evaluationId}/`, `../evidence/${evaluationId}/`, `evidence/${evaluationId}/`];
	const prefix = prefixes.find((item) => decoded.startsWith(item));
	const path = prefix ? decoded.slice(prefix.length) : undefined;
	if (!path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
	return path;
}

function evidenceImage(value: string, context: MarkdownPolicyContext): string | undefined {
	if (!context.storyId || !context.evaluationId || !ID.test(context.storyId) || !ID.test(context.evaluationId)) return undefined;
	const memberPath = relativeEvidencePath(value, context.evaluationId);
	if (!memberPath) return undefined;
	const projected = `agent-artifacts/${context.storyId}/evidence/${context.evaluationId}/${memberPath}`;
	const member = context.evidence?.find((item) => item.path === projected);
	if (!member?.manifestMember || !member.available || !member.supported || !member.mediaType?.startsWith("image/")) return undefined;
	const base = context.viewerBase ?? "/v/story-board";
	return `${base}/api/evidence?story=${encodeURIComponent(context.storyId)}&evaluation=${encodeURIComponent(context.evaluationId)}&path=${encodeURIComponent(memberPath)}`;
}

/**
 * Produces renderer-independent safe Markdown. Raw HTML is removed, unsafe
 * links become text, and only manifest-authorized companion images remain
 * images. Every other image is represented as an inert ordinary link/text.
 */
export function sanitizeMarkdown(markdown: string, context: MarkdownPolicyContext = {}): string {
	let safe = markdown.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "");
	safe = safe.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_match, alt: string, target: string) => {
		const local = evidenceImage(target, context);
		if (local) return `![${alt}](${local})`;
		const link = safeMarkdownLink(target);
		return link ? `[${alt || "External image"}](${link})` : (alt || "Image unavailable");
	});
	safe = safe.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_match, label: string, target: string) => {
		const link = safeMarkdownLink(target);
		return link ? `[${label}](${link})` : label;
	});
	return safe;
}
