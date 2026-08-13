import assert from "node:assert/strict";
import test from "node:test";
import { paginateCatalog, sliceText } from "../progressive-disclosure.js";

test("pages a filtered catalog with a snapshot-pinned cursor", () => {
	const items = [
		{ ref: "work-item:alpha", title: "Alpha" },
		{ ref: "work-item:beta", title: "Beta" },
		{ ref: "work-item:alphabet", title: "Alphabet" },
	];
	const first = paginateCatalog(items, { query: "alpha", limit: 1 });
	assert.deepEqual(first.items.map((item) => item.ref), ["work-item:alpha"]);
	assert.equal(first.page.total, 2);
	assert.equal(first.page.hasMore, true);
	assert.ok(first.page.nextCursor);
	const second = paginateCatalog(items, { query: "alpha", limit: 1, cursor: first.page.nextCursor });
	assert.deepEqual(second.items.map((item) => item.ref), ["work-item:alphabet"]);
	assert.equal(second.page.hasMore, false);
	assert.throws(() => paginateCatalog([...items, { ref: "work-item:alphanumeric", title: "Alphanumeric" }], { query: "alpha", limit: 1, cursor: first.page.nextCursor! }), /catalog changed/i);
});

test("returns bounded ranges with an explicit continuation offset", () => {
	const result = sliceText("0123456789", { offset: 2, limit: 4 });
	assert.equal(result.text, "2345");
	assert.deepEqual(result.page, { totalCharacters: 10, offset: 2, limit: 4, returnedCharacters: 4, hasMore: true, nextOffset: 6 });
});

test("finds bounded passages without returning the whole resource", () => {
	const text = `${"x".repeat(1_000)}needle${"y".repeat(1_000)}`;
	const result = sliceText(text, { findText: "needle", limit: 600 });
	assert.equal(result.mode, "find");
	assert.match(result.text, /match at 1000/);
	assert.ok(result.text.length < text.length);
	assert.equal(result.page.matches, 1);
});
