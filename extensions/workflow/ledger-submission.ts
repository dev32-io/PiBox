import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const LEDGER_WRITER_ACTIONS = new Set([
	"task-launch",
	"task-repair",
	"integration-repair",
	"verification-repair",
	"review-fix",
	"final-review-fix",
	"e2e-fix",
]);
const LEDGER_SUBMISSION_FILE = "workflow-ledger.json";
const writeQueues = new Map<string, Promise<void>>();

export interface WorkflowLedgerSubmission {
	summary: string;
	evidence?: string[];
}

export function isLedgerWriterAction(action: string): boolean {
	return LEDGER_WRITER_ACTIONS.has(action);
}

function ledgerSubmissionPath(reportPath: string): string {
	if (!isAbsolute(reportPath) || basename(reportPath) !== "report.md") throw new Error("Ledger submission requires absolute harness report.md path");
	const directory = dirname(resolve(reportPath));
	const path = resolve(directory, LEDGER_SUBMISSION_FILE);
	if (dirname(path) !== directory || relative(directory, path) !== LEDGER_SUBMISSION_FILE) throw new Error("Ledger submission path escapes attempt report directory");
	return path;
}

function validateWorkflowLedgerSubmission(value: unknown): WorkflowLedgerSubmission {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ledger submission must be an object");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.some((key) => key !== "summary" && key !== "evidence")) throw new Error("Ledger submission contains unsupported fields");
	if (typeof record.summary !== "string" || !record.summary.trim()) throw new Error("Ledger submission summary must be non-empty");
	assertNoNul(record.summary, "summary");
	if (record.evidence !== undefined) {
		if (!Array.isArray(record.evidence)) throw new Error("Ledger submission evidence must be an array");
		for (const [index, item] of record.evidence.entries()) {
			if (typeof item !== "string" || !item.trim()) throw new Error(`Ledger submission evidence[${index}] must be non-empty`);
			assertNoNul(item, `evidence[${index}]`);
		}
	}
	return { summary: record.summary, ...(record.evidence === undefined ? {} : { evidence: [...record.evidence as string[]] }) };
}

export async function writeLedgerSubmission(reportPath: string, submission: WorkflowLedgerSubmission): Promise<void> {
	const normalized = validateWorkflowLedgerSubmission(submission);
	const path = ledgerSubmissionPath(reportPath);
	const operation = (writeQueues.get(path) ?? Promise.resolve())
		.catch(() => undefined)
		.then(() => writeLedgerSubmissionOnce(reportPath, path, normalized));
	writeQueues.set(path, operation);
	try { await operation; }
	finally { if (writeQueues.get(path) === operation) writeQueues.delete(path); }
}

async function writeLedgerSubmissionOnce(reportPath: string, path: string, normalized: WorkflowLedgerSubmission): Promise<void> {
	await assertPrivateAttemptDirectory(dirname(path));
	const temporary = join(dirname(path), `.${LEDGER_SUBMISSION_FILE}.tmp-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await chmod(temporary, 0o600);
		await assertPrivateOwnedRegularFile(await lstat(temporary), temporary);
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readLedgerSubmission(reportPath);
			if (!sameSubmission(existing, normalized)) throw new Error("workflow_ledger already has a conflicting submission for this attempt");
		}
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
	await assertPrivateAttemptDirectory(dirname(path));
	const persisted = await readLedgerSubmission(reportPath);
	if (!sameSubmission(persisted, normalized)) throw new Error("Ledger submission changed during atomic publication");
}

export async function readLedgerSubmission(reportPath: string): Promise<WorkflowLedgerSubmission | undefined> {
	const path = ledgerSubmissionPath(reportPath);
	await assertPrivateAttemptDirectory(dirname(path));
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") throw new Error(`Ledger submission must not be a symbolic link: ${path}`);
		throw error;
	}
	try {
		await assertPrivateOwnedRegularFile(await handle.stat(), path);
		const text = await handle.readFile("utf8");
		await assertPrivateOwnedRegularFile(await handle.stat(), path);
		let parsed: unknown;
		try { parsed = JSON.parse(text); }
		catch { throw new Error(`Ledger submission is malformed JSON: ${path}`); }
		return validateWorkflowLedgerSubmission(parsed);
	} finally {
		await handle.close();
	}
}

async function assertPrivateAttemptDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (!stats.isDirectory()) throw new Error(`Ledger attempt path is not a directory: ${path}`);
	assertOwned(stats, path);
	if ((stats.mode & 0o077) !== 0) throw new Error(`Ledger attempt directory permissions are not private: ${path}`);
	const canonical = await realpath(path);
	const target = join(canonical, LEDGER_SUBMISSION_FILE);
	if (dirname(target) !== canonical || relative(canonical, target) !== LEDGER_SUBMISSION_FILE) throw new Error(`Ledger submission path escapes attempt report directory: ${path}`);
}

async function assertPrivateOwnedRegularFile(stats: Stats, path: string): Promise<void> {
	if (!stats.isFile()) throw new Error(`Ledger submission is not a regular file: ${path}`);
	assertOwned(stats, path);
	if (stats.nlink !== 1) throw new Error(`Ledger submission must have one filesystem link: ${path}`);
	if ((stats.mode & 0o077) !== 0) throw new Error(`Ledger submission permissions are not private: ${path}`);
}

function assertOwned(stats: Stats, path: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error(`Ledger path is not owned by current user: ${path}`);
}

function assertNoNul(value: string, field: string): void {
	if (value.includes("\0")) throw new Error(`Ledger submission ${field} must not contain NUL`);
}

function sameSubmission(left: WorkflowLedgerSubmission | undefined, right: WorkflowLedgerSubmission): boolean {
	return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
