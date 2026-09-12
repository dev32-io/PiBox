import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	isLedgerWriterAction,
	readLedgerSubmission,
	writeLedgerSubmission,
} from "../ledger-submission.js";

async function fixture(t: test.TestContext): Promise<{ root: string; reportPath: string; ledgerPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "pibox-ledger-submission-"));
	await chmod(root, 0o700);
	t.after(() => rm(root, { recursive: true, force: true }));
	const reportPath = join(root, "report.md");
	return { root, reportPath, ledgerPath: join(root, "workflow-ledger.json") };
}

test("ledger writer action allowlist excludes evaluators and custom actions", () => {
	for (const action of ["task-launch", "task-repair", "integration-repair", "verification-repair", "review-fix", "final-review-fix", "e2e-fix"]) assert.equal(isLedgerWriterAction(action), true, action);
	for (const action of ["review", "final-review", "e2e", "standalone", "custom", "custom-fix", "task-launch-custom", ""]) assert.equal(isLedgerWriterAction(action), false, action);
});

test("submission preserves large Unicode prose and supports idempotent exact duplicate", async (t) => {
	const { reportPath, ledgerPath } = await fixture(t);
	const submission = { summary: `finding 🧪 ${"界🙂".repeat(20_000)}`, evidence: ["src/例.ts:9 — доказательство", "✅ test"] };
	await writeLedgerSubmission(reportPath, submission);
	await writeLedgerSubmission(reportPath, submission);
	assert.deepEqual(await readLedgerSubmission(reportPath), submission);
	assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
});

test("concurrent identical submissions are race-safe and idempotent", async (t) => {
	const { reportPath } = await fixture(t);
	const submission = { summary: "shared finding", evidence: ["proof"] };
	await Promise.all(Array.from({ length: 20 }, () => writeLedgerSubmission(reportPath, submission)));
	assert.deepEqual(await readLedgerSubmission(reportPath), submission);
});

test("concurrent conflicting submissions preserve exactly one entry", async (t) => {
	const { reportPath } = await fixture(t);
	const settled = await Promise.allSettled([
		writeLedgerSubmission(reportPath, { summary: "first" }),
		writeLedgerSubmission(reportPath, { summary: "second" }),
	]);
	assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(settled.filter((result) => result.status === "rejected" && /conflicting submission/.test(String(result.reason))).length, 1);
	assert.deepEqual(await readLedgerSubmission(reportPath), { summary: "first" });
});

test("conflicting second submission is rejected without overwriting first", async (t) => {
	const { reportPath } = await fixture(t);
	await writeLedgerSubmission(reportPath, { summary: "first" });
	await assert.rejects(writeLedgerSubmission(reportPath, { summary: "second" }), /conflicting submission/);
	assert.deepEqual(await readLedgerSubmission(reportPath), { summary: "first" });
});

test("missing submission alone returns undefined", async (t) => {
	const { reportPath } = await fixture(t);
	assert.equal(await readLedgerSubmission(reportPath), undefined);
});

test("reader refuses symlink, non-regular, public, multiply-linked, and malformed files", async (t) => {
	await t.test("symlink", async (t) => {
		const { root, reportPath, ledgerPath } = await fixture(t);
		const target = join(root, "target"); await writeFile(target, '{"summary":"safe"}\n', { mode: 0o600 }); await symlink(target, ledgerPath);
		await assert.rejects(readLedgerSubmission(reportPath), /symbolic link/);
	});
	await t.test("non-regular", async (t) => {
		const { reportPath, ledgerPath } = await fixture(t); await mkdir(ledgerPath, { mode: 0o700 });
		await assert.rejects(readLedgerSubmission(reportPath), /not a regular file/);
	});
	await t.test("permissions", async (t) => {
		const { reportPath, ledgerPath } = await fixture(t); await writeFile(ledgerPath, '{"summary":"safe"}\n', { mode: 0o644 });
		await assert.rejects(readLedgerSubmission(reportPath), /permissions are not private/);
	});
	await t.test("hard link", async (t) => {
		const { root, reportPath, ledgerPath } = await fixture(t); await writeFile(ledgerPath, '{"summary":"safe"}\n', { mode: 0o600 }); await link(ledgerPath, join(root, "other"));
		await assert.rejects(readLedgerSubmission(reportPath), /one filesystem link/);
	});
	await t.test("malformed", async (t) => {
		const { reportPath, ledgerPath } = await fixture(t); await writeFile(ledgerPath, "not json", { mode: 0o600 });
		await assert.rejects(readLedgerSubmission(reportPath), /malformed JSON/);
	});
});

test("real FIFO is rejected promptly without blocking on open", async (t) => {
	const { reportPath, ledgerPath } = await fixture(t);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("mkfifo", ["-m", "600", ledgerPath]);
		child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)));
	});
	const moduleUrl = new URL("../ledger-submission.ts", import.meta.url).href;
	const script = `import { readLedgerSubmission } from ${JSON.stringify(moduleUrl)}; await readLedgerSubmission(${JSON.stringify(reportPath)});`;
	const outcome = await new Promise<{ timedOut: boolean; code: number | null; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timedOut: true, code: null, stderr }); }, 2_000);
		child.once("exit", (code) => { clearTimeout(timer); resolve({ timedOut: false, code, stderr }); });
	});
	assert.equal(outcome.timedOut, false, `FIFO read hung; stderr: ${outcome.stderr}`);
	assert.notEqual(outcome.code, 0);
	assert.match(outcome.stderr, /not a regular file/);
});

test("structural validation rejects empty, NUL, and unknown content", async (t) => {
	for (const [value, pattern] of [
		[{ summary: " " }, /summary must be non-empty/],
		[{ summary: "bad\0note" }, /must not contain NUL/],
		[{ summary: "ok", evidence: [""] }, /evidence\[0\] must be non-empty/],
		[{ summary: "ok", evidence: ["bad\0ref"] }, /must not contain NUL/],
		[{ summary: "ok", extra: true }, /unsupported fields/],
	] as const) {
		const { reportPath, ledgerPath } = await fixture(t);
		await writeFile(ledgerPath, JSON.stringify(value), { mode: 0o600 });
		await assert.rejects(readLedgerSubmission(reportPath), pattern);
	}
});

test("report path must target report.md in private non-symlinked attempt directory", async (t) => {
	const { root } = await fixture(t);
	await assert.rejects(readLedgerSubmission(join(root, "other.md")), /report\.md/);
	await chmod(root, 0o755);
	await assert.rejects(readLedgerSubmission(join(root, "report.md")), /directory permissions are not private/);
});
