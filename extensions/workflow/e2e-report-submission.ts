import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseE2e } from "./authored-markdown.js";
import { validateEvidenceSource } from "./work-items.js";

const ATTEMPT_TOKEN = /^[A-Za-z0-9_-]+$/;
const SUBMISSION_DIRECTORY_PREFIX = "workflow-e2e-report-";
const writeQueues = new Map<string, Promise<void>>();

export type WorkflowE2eVerdict = "passed" | "failed" | "blocked";
export type WorkflowE2eFindingSeverity = "minor" | "major" | "critical";

export interface WorkflowE2eCaseInput {
	case: string;
	verdict: WorkflowE2eVerdict;
	steps?: string[];
	expected?: string;
	observed?: string;
	evidence?: string[];
	notes?: string;
}

export interface WorkflowE2eFindingInput { summary: string; severity?: WorkflowE2eFindingSeverity }
export interface WorkflowE2eReportInput { cases: WorkflowE2eCaseInput[]; summary?: string; findings?: WorkflowE2eFindingInput[] }

export interface CanonicalE2eCaseResult {
	caseId: string;
	status: WorkflowE2eVerdict;
	executedActions: string[];
	observations: string[];
	evidenceRefs: string[];
	expected?: string;
	notes?: string;
}

export interface CanonicalE2eReport {
	schemaVersion: 1;
	result: "passed" | "repairable" | "critical" | "needs_user";
	summary?: string;
	caseResults: CanonicalE2eCaseResult[];
	findings?: WorkflowE2eFindingInput[];
}

export interface E2eReportPublishSource { sourcePath: string; storyRelativePath: string }
export interface E2eReportSubmission {
	report: CanonicalE2eReport;
	reportRef: string;
	publishSources: E2eReportPublishSource[];
}

export interface SubmitE2eReportOptions {
	reportPath: string;
	repositoryRoot: string;
	attemptToken: string;
	storyE2e: string;
	submission: WorkflowE2eReportInput;
}

export function canonicalE2eReportRef(attemptToken: string): string {
	validateAttemptToken(attemptToken);
	return `evidence/e2e-${attemptToken}/report.json`;
}

export async function submitE2eReport(options: SubmitE2eReportOptions): Promise<void> {
	const directory = submissionDirectory(options.reportPath, options.attemptToken);
	const operation = (writeQueues.get(directory) ?? Promise.resolve())
		.catch(() => undefined)
		.then(() => submitOnce(options, directory));
	writeQueues.set(directory, operation);
	try { await operation; }
	finally { if (writeQueues.get(directory) === operation) writeQueues.delete(directory); }
}

async function submitOnce(options: SubmitE2eReportOptions, directory: string): Promise<void> {
	await assertPrivateAttemptDirectory(dirname(directory));
	const normalized = validateInput(options.submission, parseE2e(options.storyE2e).cases.map((entry) => entry.id));
	await ensurePrivateSubmissionDirectory(directory);
	const candidateToken = randomUUID();
	const candidatePaths: string[] = [];
	const temporaryReport = join(directory, `.report-${candidateToken}.tmp`);
	let published = false;
	try {
		const caseResults: CanonicalE2eCaseResult[] = [];
		let evidenceIndex = 0;
		for (const item of normalized.cases) {
			const evidenceRefs: string[] = [];
			for (const source of item.evidence ?? []) {
				const captured = await readValidatedEvidence(options.repositoryRoot, source);
				const name = `evidence-${candidateToken}-${String(++evidenceIndex).padStart(3, "0")}${safeExtension(captured.path)}`;
				const destination = join(directory, name);
				await writeFile(destination, captured.contents, { flag: "wx", mode: 0o600 });
				candidatePaths.push(destination);
				await chmod(destination, 0o600);
				await assertPrivateOwnedRegularFile(await lstat(destination), destination);
				evidenceRefs.push(`evidence/e2e-${options.attemptToken}/${name}`);
			}
			caseResults.push({
				caseId: item.case,
				status: item.verdict,
				executedActions: [...(item.steps ?? [])],
				observations: item.observed === undefined ? [] : [item.observed],
				evidenceRefs,
				...(item.expected === undefined ? {} : { expected: item.expected }),
				...(item.notes === undefined ? {} : { notes: item.notes }),
			});
		}
		const report: CanonicalE2eReport = {
			schemaVersion: 1,
			result: overallResult(normalized),
			...(normalized.summary === undefined ? {} : { summary: normalized.summary }),
			caseResults,
			...(normalized.findings === undefined ? {} : { findings: normalized.findings.map((finding) => ({ ...finding })) }),
		};
		validateCanonicalReport(report, options.attemptToken);
		const reportBytes = Buffer.from(`${JSON.stringify(report)}\n`);
		await writeFile(temporaryReport, reportBytes, { flag: "wx", mode: 0o600 });
		await chmod(temporaryReport, 0o600);
		await assertPrivateOwnedRegularFile(await lstat(temporaryReport), temporaryReport);
		await validateEvidenceSource(options.repositoryRoot, temporaryReport, reportBytes);
		await rename(temporaryReport, join(directory, "report.json"));
		published = true;
	} finally {
		await rm(temporaryReport, { force: true }).catch(() => undefined);
		if (!published) await Promise.all(candidatePaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
	}
}

export async function readE2eReportSubmission(reportPath: string, attemptToken: string): Promise<E2eReportSubmission | undefined> {
	const directory = submissionDirectory(reportPath, attemptToken);
	await assertPrivateAttemptDirectory(dirname(directory));
	let directoryStats: Stats;
	try { directoryStats = await lstat(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (!directoryStats.isDirectory()) throw new Error(`E2E report submission path is not a directory: ${directory}`);
	assertOwned(directoryStats, directory);
	if ((directoryStats.mode & 0o077) !== 0) throw new Error(`E2E report submission directory permissions are not private: ${directory}`);
	const reportFile = join(directory, "report.json");
	let parsed: unknown;
	try { parsed = await readPrivateJson(reportFile); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	const report = validateCanonicalReport(parsed, attemptToken);
	const reportRef = canonicalE2eReportRef(attemptToken);
	const publishSources: E2eReportPublishSource[] = [{ sourcePath: reportFile, storyRelativePath: reportRef }];
	for (const reference of report.caseResults.flatMap((item) => item.evidenceRefs)) {
		const name = basename(reference);
		const sourcePath = join(directory, name);
		if (dirname(sourcePath) !== directory || relative(directory, sourcePath) !== name) throw new Error(`E2E evidence reference escapes submission directory: ${reference}`);
		await readPrivateFile(sourcePath);
		publishSources.push({ sourcePath, storyRelativePath: reference });
	}
	return { report, reportRef, publishSources };
}

export async function e2eReportPublishSources(reportPath: string, attemptToken: string): Promise<E2eReportPublishSource[]> {
	return (await readE2eReportSubmission(reportPath, attemptToken))?.publishSources ?? [];
}

function submissionDirectory(reportPath: string, attemptToken: string): string {
	validateAttemptToken(attemptToken);
	if (!isAbsolute(reportPath) || basename(reportPath) !== "report.md") throw new Error("E2E report submission requires absolute harness report.md path");
	const attemptDirectory = dirname(resolve(reportPath));
	const name = `${SUBMISSION_DIRECTORY_PREFIX}${attemptToken}`;
	const directory = resolve(attemptDirectory, name);
	if (dirname(directory) !== attemptDirectory || relative(attemptDirectory, directory) !== name) throw new Error("E2E report submission path escapes attempt report directory");
	return directory;
}

function validateAttemptToken(value: string): void {
	if (!ATTEMPT_TOKEN.test(value)) throw new Error("E2E report attempt token is invalid");
}

function validateInput(value: unknown, requiredCaseIds: readonly string[]): WorkflowE2eReportInput {
	const record = object(value, "E2E report");
	exactKeys(record, ["cases", "summary", "findings"], "E2E report");
	if (!Array.isArray(record.cases)) throw new Error("E2E report cases must be an array");
	const seen = new Set<string>();
	const cases = record.cases.map((item, index) => {
		const entry = object(item, `E2E report cases[${index}]`);
		exactKeys(entry, ["case", "verdict", "steps", "expected", "observed", "evidence", "notes"], `E2E report cases[${index}]`);
		const caseId = nonEmpty(entry.case, `E2E report cases[${index}].case`);
		if (seen.has(caseId)) throw new Error(`E2E report contains duplicate case ${caseId}`);
		seen.add(caseId);
		if (entry.verdict !== "passed" && entry.verdict !== "failed" && entry.verdict !== "blocked") throw new Error(`E2E report cases[${index}].verdict must be passed, failed, or blocked`);
		const verdict: WorkflowE2eVerdict = entry.verdict;
		const steps = optionalStrings(entry.steps, `E2E report cases[${index}].steps`);
		const evidence = optionalStrings(entry.evidence, `E2E report cases[${index}].evidence`, true);
		return {
			case: caseId, verdict,
			...(steps === undefined ? {} : { steps }),
			...(optionalString(entry.expected, `E2E report cases[${index}].expected`) === undefined ? {} : { expected: entry.expected as string }),
			...(optionalString(entry.observed, `E2E report cases[${index}].observed`) === undefined ? {} : { observed: entry.observed as string }),
			...(evidence === undefined ? {} : { evidence }),
			...(optionalString(entry.notes, `E2E report cases[${index}].notes`) === undefined ? {} : { notes: entry.notes as string }),
		};
	});
	const missing = requiredCaseIds.filter((id) => !seen.has(id));
	if (missing.length) throw new Error(`E2E report must include every required case; missing: ${missing.join(", ")}`);
	const summary = optionalString(record.summary, "E2E report summary");
	let findings: WorkflowE2eFindingInput[] | undefined;
	if (record.findings !== undefined) {
		if (!Array.isArray(record.findings)) throw new Error("E2E report findings must be an array");
		findings = record.findings.map((item, index) => {
			const finding = object(item, `E2E report findings[${index}]`);
			exactKeys(finding, ["summary", "severity"], `E2E report findings[${index}]`);
			const findingSummary = nonEmpty(finding.summary, `E2E report findings[${index}].summary`);
			if (finding.severity !== undefined && finding.severity !== "minor" && finding.severity !== "major" && finding.severity !== "critical") throw new Error(`E2E report findings[${index}].severity must be minor, major, or critical`);
			return { summary: findingSummary, ...(finding.severity === undefined ? {} : { severity: finding.severity }) };
		});
	}
	return { cases, ...(summary === undefined ? {} : { summary }), ...(findings === undefined ? {} : { findings }) };
}

function overallResult(report: WorkflowE2eReportInput): CanonicalE2eReport["result"] {
	if (report.findings?.some((finding) => finding.severity === "critical")) return "critical";
	if (report.cases.some((item) => item.verdict === "failed") || report.findings?.some((finding) => (finding.severity ?? "major") === "major")) return "repairable";
	if (report.cases.some((item) => item.verdict === "blocked")) return "needs_user";
	return "passed";
}

function validateCanonicalReport(value: unknown, attemptToken: string): CanonicalE2eReport {
	const record = object(value, "Canonical E2E report");
	exactKeys(record, ["schemaVersion", "result", "summary", "caseResults", "findings"], "Canonical E2E report");
	if (record.schemaVersion !== 1 || !["passed", "repairable", "critical", "needs_user"].includes(record.result as string) || !Array.isArray(record.caseResults)) throw new Error("Canonical E2E report has invalid schema, result, or caseResults");
	const input: WorkflowE2eReportInput = {
		cases: record.caseResults.map((item, index) => {
			const entry = object(item, `Canonical E2E report caseResults[${index}]`);
			exactKeys(entry, ["caseId", "status", "executedActions", "observations", "evidenceRefs", "expected", "notes"], `Canonical E2E report caseResults[${index}]`);
			if (!Array.isArray(entry.observations) || entry.observations.some((text) => typeof text !== "string" || text.includes("\0"))) throw new Error(`Canonical E2E report caseResults[${index}].observations must be strings`);
			if (entry.observations.length > 1) throw new Error(`Canonical E2E report caseResults[${index}].observations has unsupported shape`);
			const refs = optionalStrings(entry.evidenceRefs, `Canonical E2E report caseResults[${index}].evidenceRefs`, true) ?? [];
			for (const reference of refs) if (!new RegExp(`^evidence/e2e-${escapeRegex(attemptToken)}/evidence-(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-)?[0-9]{3,}(?:\\.[A-Za-z0-9]+)?$`, "i").test(reference)) throw new Error(`Canonical E2E report has invalid generated evidence reference: ${reference}`);
			return { case: nonEmpty(entry.caseId, `Canonical E2E report caseResults[${index}].caseId`), verdict: entry.status as WorkflowE2eVerdict, steps: optionalStrings(entry.executedActions, `Canonical E2E report caseResults[${index}].executedActions`) ?? [], ...(entry.expected === undefined ? {} : { expected: optionalString(entry.expected, "expected")! }), ...(entry.observations.length ? { observed: entry.observations[0] as string } : {}), evidence: refs, ...(entry.notes === undefined ? {} : { notes: optionalString(entry.notes, "notes")! }) };
		}),
		...(record.summary === undefined ? {} : { summary: optionalString(record.summary, "Canonical E2E report summary")! }),
		...(record.findings === undefined ? {} : { findings: record.findings as WorkflowE2eFindingInput[] }),
	};
	const normalized = validateInput(input, []);
	if (overallResult(normalized) !== record.result) throw new Error("Canonical E2E report result does not match case and finding results");
	return record as unknown as CanonicalE2eReport;
}

async function readValidatedEvidence(repositoryRoot: string, supplied: string): Promise<{ path: string; contents: Buffer }> {
	const paths = evidenceCandidatePaths(repositoryRoot, supplied);
	let handle;
	let openedPath = paths[0]!;
	for (const path of paths) {
		try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); openedPath = path; break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== paths.at(-1)) continue;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Evidence file does not exist: ${supplied}`, { cause: error });
			throw new Error(`E2E evidence must be an existing regular file: ${supplied}`, { cause: error });
		}
	}
	if (!handle) throw new Error(`Evidence file does not exist: ${supplied}`);
	try {
		const openedStats = await handle.stat();
		assertRegularEvidence(openedStats, supplied);
		const resolvedPath = await realpath(openedPath);
		const resolvedStats = await stat(resolvedPath);
		if (openedStats.dev !== resolvedStats.dev || openedStats.ino !== resolvedStats.ino) throw new Error(`E2E evidence path changed while opening: ${supplied}`);
		await assertContainedEvidencePath(repositoryRoot, resolvedPath, supplied);
		const contents = await handle.readFile();
		const finalStats = await handle.stat();
		assertRegularEvidence(finalStats, supplied);
		if (openedStats.dev !== finalStats.dev || openedStats.ino !== finalStats.ino) throw new Error(`E2E evidence file changed while reading: ${supplied}`);
		const validated = await validateEvidenceSource(repositoryRoot, supplied, contents);
		return { path: validated, contents };
	} finally { await handle.close(); }
}

function evidenceCandidatePaths(repositoryRoot: string, supplied: string): string[] {
	const exact = resolve(repositoryRoot, supplied);
	const withoutRanges = supplied.replace(/:(?:L?\d+(?:-L?\d+)?)(?:,(?:L?\d+(?:-L?\d+)?))*$/, "");
	return withoutRanges === supplied ? [exact] : [exact, resolve(repositoryRoot, withoutRanges)];
}

async function assertContainedEvidencePath(repositoryRoot: string, path: string, supplied: string): Promise<void> {
	const allowedRoots = await Promise.all([repositoryRoot, tmpdir(), "/tmp"].map((root) => realpath(root).catch(() => resolve(root))));
	if (!allowedRoots.some((root) => path !== root && path.startsWith(`${root}${sep}`))) throw new Error(`Evidence source resolves outside the repository or operating-system temporary directory: ${supplied}`);
}

async function readPrivateJson(path: string): Promise<unknown> {
	const contents = await readPrivateFile(path);
	try { return JSON.parse(contents.toString("utf8")); }
	catch { throw new Error(`E2E report submission is malformed JSON: ${path}`); }
}

async function readPrivateFile(path: string): Promise<Buffer> {
	let handle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`E2E report submission file must not be a symbolic link: ${path}`); throw error; }
	try {
		await assertPrivateOwnedRegularFile(await handle.stat(), path);
		const contents = await handle.readFile();
		await assertPrivateOwnedRegularFile(await handle.stat(), path);
		return contents;
	} finally { await handle.close(); }
}

async function assertPrivateAttemptDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (!stats.isDirectory()) throw new Error(`E2E attempt path is not a directory: ${path}`);
	assertOwned(stats, path);
	if ((stats.mode & 0o077) !== 0) throw new Error(`E2E attempt directory permissions are not private: ${path}`);
}

async function ensurePrivateSubmissionDirectory(path: string): Promise<void> {
	try { await mkdir(path, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	await assertPrivateAttemptDirectory(path);
}

function assertRegularEvidence(stats: Stats, source: string): void {
	if (!stats.isFile()) throw new Error(`E2E evidence is not a regular file: ${source}`);
}

function assertPrivateOwnedRegularFile(stats: Stats, path: string): void {
	if (!stats.isFile()) throw new Error(`E2E report submission is not a regular file: ${path}`);
	assertOwned(stats, path);
	if (stats.nlink !== 1) throw new Error(`E2E report submission must have one filesystem link: ${path}`);
	if ((stats.mode & 0o077) !== 0) throw new Error(`E2E report submission permissions are not private: ${path}`);
}

function assertOwned(stats: Stats, path: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error(`E2E report path is not owned by current user: ${path}`);
}

function safeExtension(path: string): string {
	const extension = extname(path);
	return /^\.[A-Za-z0-9]+$/.test(extension) ? extension : "";
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unsupported.length) throw new Error(`${label} contains unsupported fields: ${unsupported.join(", ")}`);
}

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	assertNoNul(value, label);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	assertNoNul(value, label);
	return value;
}

function optionalStrings(value: unknown, label: string, nonEmptyItems = false): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((item, index) => {
		if (typeof item !== "string" || (nonEmptyItems && !item.trim())) throw new Error(`${label}[${index}] must be ${nonEmptyItems ? "a non-empty string" : "a string"}`);
		assertNoNul(item, `${label}[${index}]`);
		return item;
	});
}

function assertNoNul(value: string, label: string): void {
	if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
