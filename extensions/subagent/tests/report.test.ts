import assert from "node:assert/strict";
import test from "node:test";
import { readReportPage } from "../report.js";
import { normalizeSubagentTitle } from "../presentation.js";

test("report paging is Unicode-safe, bounded and reconstructs the original without overlap", () => {
	const text = "🙂中\nα".repeat(5_000);
	let offset = 0;
	let actual = "";
	for (;;) {
		const page = readReportPage(text, offset, 7_003);
		actual += page.text;
		assert.ok(Buffer.byteLength(page.text) <= 48_000);
		if (page.nextOffset === undefined) break;
		offset = page.nextOffset;
	}
	assert.equal(actual, text);
	assert.equal(readReportPage("", 0).count, 0);
	assert.equal(readReportPage(text, 20_000).text, "");
	assert.throws(() => readReportPage("x", 2), /exceeds/);
	for (const offset of [-1, 1.2, Infinity]) assert.throws(() => readReportPage("x", offset), /offset/);
	for (const limit of [0, 12_001, NaN]) assert.throws(() => readReportPage("x", 0, limit), /limit/);
});

test("display-only titles strip terminal controls and remain Unicode-safe and bounded", () => {
	assert.equal(normalizeSubagentTitle(undefined), undefined);
	assert.equal(normalizeSubagentTitle(" \n\t"), undefined);
	assert.equal(normalizeSubagentTitle("\u001b]0;evil title\u0007Fix\n RTL \u001b[31mbubbles\u001b[0m"), "Fix RTL bubbles");
	assert.equal(Array.from(normalizeSubagentTitle("🙂".repeat(100))!).length, 80);
});
