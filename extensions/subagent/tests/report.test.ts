import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readReportPage, readTerminalReport } from "../report.js";
import { normalizeSubagentTitle } from "../presentation.js";

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function terminal(reportPath: string, text: string, sha256 = digest(text)) {
	return { reportPath, reportBytes: Buffer.byteLength(text), reportSha256: sha256, text, status: "completed" } as any;
}

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

test("compatibility report reads prefer the validated advertised file and fail explicitly when it disappears", async (t) => {
	const directory = await mkdtemp("/tmp/pibox-report-reader-");
	t.after(() => rm(directory, { recursive: true, force: true }));
	const reportPath = join(directory, "report.md");
	await writeFile(reportPath, "same report", { mode: 0o600 });
	const advertised = { ...terminal(reportPath, "in-memory copy", digest("same report")), reportBytes: 11 };
	assert.equal(await readTerminalReport(advertised), "same report");
	await rm(reportPath);
	await assert.rejects(readTerminalReport(advertised), /report file is missing/i);
	assert.equal(await readTerminalReport({ text: "legacy", status: "completed" } as any), "legacy");
});

test("report reads reject same-length mutation, symlink replacement, and public mode changes", async (t) => {
	const directory = await mkdtemp("/tmp/pibox-report-integrity-");
	t.after(() => rm(directory, { recursive: true, force: true }));
	const reportPath = join(directory, "report.md");
	const original = "captured-A";
	await writeFile(reportPath, original, { mode: 0o600 });
	const captured = terminal(reportPath, original);

	await writeFile(reportPath, "captured-B", { mode: 0o600 });
	await assert.rejects(readTerminalReport(captured), /content changed/i);

	const target = join(directory, "target.md");
	await writeFile(target, original, { mode: 0o600 });
	await rm(reportPath);
	await symlink(target, reportPath);
	await assert.rejects(readTerminalReport(captured), /symbolic link/i);

	await rm(reportPath);
	await writeFile(reportPath, original, { mode: 0o600 });
	await chmod(reportPath, 0o644);
	await assert.rejects(readTerminalReport(captured), /permissions are not private/i);
});

test("logical titles strip terminal controls without shortening stored text", () => {
	assert.equal(normalizeSubagentTitle(undefined), undefined);
	assert.equal(normalizeSubagentTitle(" \n\t"), undefined);
	assert.equal(normalizeSubagentTitle("\u001b]0;evil title\u0007Fix\n RTL \u001b[31mbubbles\u001b[0m"), "Fix RTL bubbles");
	assert.equal(Array.from(normalizeSubagentTitle("🙂".repeat(100))!).length, 100);
});
