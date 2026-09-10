import { marked, type Token, type Tokens } from "marked";
import type { EvidenceMetadata } from "./models.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MarkdownPolicyContext {
	storyId?: string;
	evaluationId?: string;
	evidence?: readonly EvidenceMetadata[];
	viewerBase?: string;
}

/** Only explicit external navigation is allowed without evidence authorization. */
export function safeMarkdownLink(value: string): string | undefined {
	const url = value.trim();
	return /^(?:https?:\/\/|mailto:)/i.test(url) && !/[\u0000-\u0020\\]/.test(url) ? url : undefined;
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

/** Keep the API Markdown-shaped, but serialize parsed syntax rather than regexing
 * source. Code tokens are opaque; references are resolved by the same GFM lexer
 * as the browser. Authored HTML becomes visible literal text, never markup.
 */
export function sanitizeMarkdown(markdown: string, context: MarkdownPolicyContext = {}): string {
	const textLiteral = (text: string) => text.replace(/[\\`*{}\[\]()#+.!_|~-]/g, "\\$&").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const literal = (text: string) => textLiteral(text.replace(/&/g, "&amp;"));
	const destination = (url: string) => `<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
	const render = (tokens: Token[]): string => tokens.map((value): string => {
		const token = value as Tokens.Generic;
		const children = () => render(token.tokens || []);
		switch (token.type) {
			case "space": return token.raw;
			case "code": return token.raw + "\n\n";
			case "codespan": return token.raw;
			case "html": return literal(token.text) + (token.block ? "\n\n" : "");
			case "def": return "";
			case "image": {
				const local = evidenceImage(token.href, context);
				const link = local || safeMarkdownLink(token.href);
				const label = literal(token.text || "Image unavailable");
				return link ? `${local ? "!" : ""}[${label}](${destination(link)})` : label;
			}
			case "link": {
				const link = evidenceImage(token.href, context) || safeMarkdownLink(token.href);
				const label = children();
				return link ? `[${label}](${destination(link)})` : label;
			}
			case "heading": return `${"#".repeat(token.depth)} ${children()}\n\n`;
			case "paragraph": return children() + "\n\n";
			case "text": return token.tokens ? children() + (token.raw.match(/\n+$/)?.[0] || "") : textLiteral(token.raw);
			case "checkbox": return "";
			case "strong": case "em": {
				// Retain each source delimiter, including in nested tokens: normalizing
				// adjacent *a*_b_ to *a**b* changes how Markdown parses the run.
				const marker = token.raw.slice(0, token.type === "strong" ? 2 : 1);
				return `${marker}${children()}${marker}`;
			}
			case "del": return `~~${children()}~~`;
			case "escape": case "br": case "hr": return token.raw;
			case "blockquote": return render(token.tokens || []).trimEnd().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
			case "list": return (token.items as Tokens.ListItem[]).map((item, index) => {
				const marker = token.ordered ? `${Number(token.start) + index}. ` : "- ";
				const body = `${item.task ? `[${item.checked ? "x" : " "}] ` : ""}${render(item.tokens).trimEnd()}`;
				return marker + body.replace(/\n/g, "\n" + " ".repeat(marker.length));
			}).join("\n") + "\n\n";
			case "table": {
				const table = value as Tokens.Table;
				const row = (cells: Tokens.TableCell[]) => "| " + cells.map((cell) => render(cell.tokens).replace(/(?<!\\)\|/g, "\\|")).join(" | ") + " |\n";
				return row(table.header) + "| " + table.align.map((align) => align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---").join(" | ") + " |\n" + table.rows.map(row).join("") + "\n";
			}
			default: return literal(token.raw);
		}
	}).join("");
	return render(marked.lexer(markdown, { gfm: true })).trimEnd();
}
