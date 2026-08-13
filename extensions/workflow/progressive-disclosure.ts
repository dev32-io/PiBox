import { createHash } from "node:crypto";
import { HarnessError } from "./errors.js";

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const DEFAULT_TEXT_LIMIT = 4_000;
const MAX_TEXT_LIMIT = 12_000;
const FIND_CONTEXT = 240;
const MAX_FIND_MATCHES = 10;

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function encodeCursor(value: { offset: number; snapshot: string; query: string }): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string): { offset: number; snapshot: string; query: string } {
	if (cursor.length > 2_048) throw new HarnessError("INVALID_ARTIFACT", "Workflow cursor is too long");
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
		if (!Number.isInteger(value.offset) || (value.offset as number) < 0 || typeof value.snapshot !== "string" || typeof value.query !== "string") throw new Error("invalid cursor fields");
		return value as { offset: number; snapshot: string; query: string };
	} catch {
		throw new HarnessError("INVALID_ARTIFACT", "Workflow cursor is invalid; restart from the first page");
	}
}

export interface CatalogPage<T> {
	items: T[];
	page: {
		snapshot: string;
		offset: number;
		limit: number;
		returned: number;
		total: number;
		hasMore: boolean;
		nextCursor?: string;
	};
}

/** Return a stable, bounded catalog page. A cursor cannot be reused after the catalog changes. */
export function paginateCatalog<T>(
	items: T[],
	options: { cursor?: string; limit?: number; query?: string; searchableText?: (item: T) => string } = {},
): CatalogPage<T> {
	const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new HarnessError("INVALID_ARTIFACT", `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
	const query = (options.query ?? "").trim().toLowerCase();
	const filtered = query
		? items.filter((item) => (options.searchableText?.(item) ?? JSON.stringify(item)).toLowerCase().includes(query))
		: items;
	const snapshot = digest(filtered);
	const decoded = options.cursor ? decodeCursor(options.cursor) : undefined;
	if (decoded && (decoded.snapshot !== snapshot || decoded.query !== query)) throw new HarnessError("CONTEXT_REFRESH_REQUIRED", "Workflow catalog changed while paging; restart from the first page", { currentSnapshot: snapshot });
	const offset = decoded?.offset ?? 0;
	if (offset > filtered.length) throw new HarnessError("INVALID_ARTIFACT", "Workflow cursor offset is outside the catalog");
	const pageItems = filtered.slice(offset, offset + limit);
	const nextOffset = offset + pageItems.length;
	const hasMore = nextOffset < filtered.length;
	return {
		items: pageItems,
		page: {
			snapshot,
			offset,
			limit,
			returned: pageItems.length,
			total: filtered.length,
			hasMore,
			...(hasMore ? { nextCursor: encodeCursor({ offset: nextOffset, snapshot, query }) } : {}),
		},
	};
}

export interface TextSlice {
	mode: "range" | "find";
	text: string;
	page: {
		totalCharacters: number;
		offset?: number;
		limit: number;
		returnedCharacters: number;
		hasMore?: boolean;
		nextOffset?: number;
		matches?: number;
	};
}

/** Bound a large canonical representation by character range or matching passages. */
export function sliceText(text: string, options: { offset?: number; limit?: number; findText?: string } = {}): TextSlice {
	const limit = options.limit ?? DEFAULT_TEXT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TEXT_LIMIT) throw new HarnessError("INVALID_ARTIFACT", `limit must be an integer from 1 to ${MAX_TEXT_LIMIT}`);
	if (options.findText !== undefined) {
		const needle = options.findText.trim();
		if (!needle) throw new HarnessError("INVALID_ARTIFACT", "findText must not be blank");
		if (needle.length > 500) throw new HarnessError("INVALID_ARTIFACT", "findText must be at most 500 characters");
		const lower = text.toLowerCase();
		const query = needle.toLowerCase();
		const offsets: number[] = [];
		let cursor = 0;
		while (offsets.length < MAX_FIND_MATCHES) {
			const found = lower.indexOf(query, cursor);
			if (found < 0) break;
			offsets.push(found);
			cursor = found + Math.max(1, query.length);
		}
		const passages: string[] = [];
		let used = 0;
		for (const found of offsets) {
			const start = Math.max(0, found - FIND_CONTEXT);
			const end = Math.min(text.length, found + query.length + FIND_CONTEXT);
			const passage = `[match at ${found}; range ${start}-${end}]\n${text.slice(start, end)}`;
			if (passages.length > 0 && used + passage.length + 6 > limit) break;
			passages.push(passage);
			used += passage.length + 6;
		}
		const rendered = passages.length ? passages.join("\n\n---\n\n") : `No matches for ${JSON.stringify(needle)}.`;
		return { mode: "find", text: rendered, page: { totalCharacters: text.length, limit, returnedCharacters: rendered.length, matches: offsets.length } };
	}
	const offset = options.offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new HarnessError("INVALID_ARTIFACT", "offset must be an integer within the resource content");
	const value = text.slice(offset, offset + limit);
	const nextOffset = offset + value.length;
	const hasMore = nextOffset < text.length;
	return { mode: "range", text: value, page: { totalCharacters: text.length, offset, limit, returnedCharacters: value.length, hasMore, ...(hasMore ? { nextOffset } : {}) } };
}
