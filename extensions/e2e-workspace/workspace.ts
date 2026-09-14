import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { containsObviousSensitiveContent, looksSensitiveEvidenceName } from "../core/evidence-safety.js";

const ROOT = "/tmp";
const PREFIX = "pibox-e2e-workspace-";
const ID = /^[0-9a-f]{32}$/;
const RUN_ID = /^[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const META_BYTES = 16 * 1024;
const RECEIPT_NAME = "e2e-workspace-handoff.json";
const TYPES: Readonly<Record<string, string>> = {
	".txt": "text/plain", ".log": "text/plain", ".json": "application/json",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

export type E2eVerdict = "passed" | "failed" | "blocked";
export type E2eFindingSeverity = "minor" | "major" | "critical";
export interface E2eCaseInput { case: string; verdict: E2eVerdict; steps?: string[] | undefined; expected?: string | undefined; observed?: string | undefined; evidence?: string[] | undefined; notes?: string | undefined }
export interface E2eFindingInput { summary: string; severity?: E2eFindingSeverity | undefined }
export interface E2eReportInput { cases: E2eCaseInput[]; summary?: string | undefined; findings?: E2eFindingInput[] | undefined }
export interface E2eCaseResult { caseId: string; status: E2eVerdict; executedActions: string[]; observations: string[]; evidenceRefs: string[]; expected?: string; notes?: string }
export interface E2eReport { schemaVersion: 1; result: "passed" | "repairable" | "critical" | "needs_user"; summary?: string; caseResults: E2eCaseResult[]; findings?: E2eFindingInput[] }
export interface E2eWorkspaceReportReference { workspaceId: string; sessionId: string; runId: string; reportPath: string; reportSha256: string }
export interface E2eWorkspaceReportResult {
	reference: E2eWorkspaceReportReference; report: E2eReport; serializedJsonText: string; workspaceRoot: string; reportPath: string;
	evidence: Array<{ reference: string; absolutePath: string; sha256: string; bytes: number; mimeType: string }>;
}
export interface E2eWorkspaceBinding { workspaceId: string; sessionId: string }
export interface E2eWorkspace { binding: E2eWorkspaceBinding; root: string; metadataPath: string; evaluationsRoot: string }
export interface E2eEvaluation { workspace: E2eWorkspace; runId: string; root: string; outputDirectory: string; evidenceDirectory: string; reportPath: string }
export interface RetainedE2eEvidence { reference: string; absolutePath: string; sha256: string; bytes: number; mimeType: string; deduplicated: boolean; retainedFiles: number; retainedBytes: number }

interface Metadata { schemaVersion: 1; workspaceId: string; sessionId: string; createdAt: string }
interface Handoff { schemaVersion: 1; nativeReportPath: string; reference: E2eWorkspaceReportReference }
interface RetainedRecord { reference: string; absolutePath: string; sha256: string; bytes: number; mimeType: string; reasons: Set<string> }
const REQUIRED_CASES_PROVIDER = Symbol.for("pibox.e2e-workspace.required-cases-provider");
type ProviderProcess = NodeJS.Process & { [REQUIRED_CASES_PROVIDER]?: () => Promise<readonly string[]> };
const queues = new Map<string, Promise<unknown>>();
const retainedByEvaluation = new Map<string, Map<string, RetainedRecord>>();

/** Install child-process case policy across Pi's isolated extension module loaders. */
export function setE2eRequiredCasesProvider(provider: (() => Promise<readonly string[]>) | undefined): void {
	if (provider) (process as ProviderProcess)[REQUIRED_CASES_PROVIDER] = provider;
	else delete (process as ProviderProcess)[REQUIRED_CASES_PROVIDER];
}

function workspaceFor(binding: E2eWorkspaceBinding): E2eWorkspace {
	validateBinding(binding);
	const root = join(ROOT, `${PREFIX}${binding.workspaceId}`);
	return { binding: { ...binding }, root, metadataPath: join(root, "meta.json"), evaluationsRoot: join(root, "evaluations") };
}
function evaluationFor(workspace: E2eWorkspace, runId: string): E2eEvaluation {
	if (!RUN_ID.test(runId)) throw new Error("E2E evaluation run id is invalid");
	const root = join(workspace.evaluationsRoot, runId);
	return { workspace, runId, root, outputDirectory: join(root, "output"), evidenceDirectory: join(root, "evidence"), reportPath: join(root, "report.json") };
}
function validateBinding(binding: E2eWorkspaceBinding): void {
	if (!ID.test(binding.workspaceId)) throw new Error("E2E workspace id must be 32 lowercase hexadecimal characters");
	if (!binding.sessionId || binding.sessionId.includes("\0")) throw new Error("E2E workspace session id is invalid");
}
function owned(stats: Stats, path: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) throw new Error(`E2E workspace path is not owned by current user: ${path}`);
}
async function openPrivate(path: string, kind: "file" | "directory") {
	let handle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "directory" ? constants.O_DIRECTORY : constants.O_NONBLOCK)); }
	catch (error) { throw new Error(`E2E workspace ${kind} is missing or unsafe: ${path}`, { cause: error }); }
	try {
		const stats = await handle.stat();
		if ((kind === "file" ? !stats.isFile() || stats.nlink !== 1 : !stats.isDirectory()) || (stats.mode & 0o777) !== (kind === "file" ? FILE_MODE : DIRECTORY_MODE)) throw new Error(`E2E workspace ${kind} is invalid or not private: ${path}`);
		owned(stats, path);
		return handle;
	} catch (error) { await handle.close(); throw error; }
}
async function withPrivateDirectories<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
	const opened: Array<{ path: string; handle: Awaited<ReturnType<typeof openPrivate>>; stats: Stats }> = [];
	try {
		for (const path of paths) { const handle = await openPrivate(path, "directory"); opened.push({ path, handle, stats: await handle.stat() }); }
		const result = await operation();
		for (const entry of opened) {
			const [descriptor, current] = await Promise.all([entry.handle.stat(), lstat(entry.path)]);
			if (!current.isDirectory() || current.isSymbolicLink() || descriptor.dev !== entry.stats.dev || descriptor.ino !== entry.stats.ino || current.dev !== descriptor.dev || current.ino !== descriptor.ino) throw new Error(`E2E workspace directory changed during operation: ${entry.path}`);
		}
		return result;
	} finally { await Promise.all(opened.map((entry) => entry.handle.close().catch(() => undefined))); }
}
async function readPrivate(path: string, maxBytes?: number): Promise<Buffer> {
	const handle = await openPrivate(path, "file");
	try {
		const before = await handle.stat();
		if (maxBytes !== undefined && before.size > maxBytes) throw new Error(`E2E workspace file is too large: ${path}`);
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error(`E2E workspace file changed while reading: ${path}`);
		return bytes;
	} finally { await handle.close(); }
}
async function createDirectory(path: string): Promise<void> { await mkdir(path, { mode: DIRECTORY_MODE }); await chmod(path, DIRECTORY_MODE); }
async function publishExclusive(path: string, bytes: string | Buffer): Promise<void> {
	const temporary = join(dirname(path), `.${randomBytes(16).toString("hex")}.tmp`);
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
	try { await handle.writeFile(bytes); await handle.chmod(FILE_MODE); await handle.sync(); } finally { await handle.close(); }
	try { await link(temporary, path); } finally { await unlink(temporary).catch(() => undefined); }
}
async function atomicReplace(path: string, text: string): Promise<void> {
	const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
	try { await writeFile(temporary, text, { flag: "wx", mode: FILE_MODE }); await chmod(temporary, FILE_MODE); await rename(temporary, path); }
	finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
function parseObject(text: string, label: string): Record<string, unknown> {
	let value: unknown;
	try { value = JSON.parse(text); } catch (error) { throw new Error(`${label} is malformed JSON`, { cause: error }); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

/** Create one opaque, session-bound /tmp workspace. */
export async function createE2eWorkspace({ sessionId }: { sessionId: string }): Promise<E2eWorkspace> {
	validateBinding({ workspaceId: "0".repeat(32), sessionId });
	for (let attempt = 0; attempt < 32; attempt++) {
		const binding = { workspaceId: randomBytes(16).toString("hex"), sessionId };
		const workspace = workspaceFor(binding);
		try { await createDirectory(workspace.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
		try {
			await createDirectory(workspace.evaluationsRoot);
			const metadata: Metadata = { schemaVersion: 1, ...binding, createdAt: new Date().toISOString() };
			await publishExclusive(workspace.metadataPath, `${JSON.stringify(metadata)}\n`);
			return workspace;
		} catch (error) { await rm(workspace.root, { recursive: true, force: true }); throw error; }
	}
	throw new Error("Could not allocate E2E workspace");
}

/** Restore only exact opaque binding; never scans /tmp or recreates missing storage. */
export async function restoreE2eWorkspace({ binding }: { binding: E2eWorkspaceBinding }): Promise<E2eWorkspace> {
	const workspace = workspaceFor(binding);
	const root = await openPrivate(workspace.root, "directory");
	try {
		const metadata = parseObject((await readPrivate(workspace.metadataPath, META_BYTES)).toString("utf8"), "E2E workspace metadata");
		if (metadata.schemaVersion !== 1 || metadata.workspaceId !== binding.workspaceId || metadata.sessionId !== binding.sessionId) throw new Error("E2E workspace binding does not match metadata");
		const evaluations = await openPrivate(workspace.evaluationsRoot, "directory"); await evaluations.close();
		const [before, now] = await Promise.all([root.stat(), lstat(workspace.root)]);
		if (!now.isDirectory() || now.isSymbolicLink() || before.dev !== now.dev || before.ino !== now.ino) throw new Error("E2E workspace root changed during validation");
		return workspace;
	} finally { await root.close(); }
}

/** Start one immutable evaluation snapshot and return its owned capture directory. */
export async function createE2eEvaluation({ workspace }: { workspace: E2eWorkspace }): Promise<E2eEvaluation> {
	const restored = await restoreE2eWorkspace({ binding: workspace.binding });
	const evaluation = evaluationFor(restored, randomUUID());
	await withPrivateDirectories([restored.root, restored.evaluationsRoot], async () => { await createDirectory(evaluation.root); });
	try {
		await withPrivateDirectories([restored.root, restored.evaluationsRoot, evaluation.root], async () => { await createDirectory(evaluation.outputDirectory); await createDirectory(evaluation.evidenceDirectory); });
		await withPrivateDirectories([restored.root, restored.evaluationsRoot, evaluation.root, evaluation.outputDirectory, evaluation.evidenceDirectory], async () => undefined);
		retainedByEvaluation.set(evaluation.root, new Map());
		return evaluation;
	} catch (error) { await rm(evaluation.root, { recursive: true, force: true }); throw error; }
}

function assertPassiveContent(bytes: Buffer, mimeType: string): void {
	if (mimeType === "application/json") { try { JSON.parse(bytes.toString("utf8")); } catch { throw new Error("E2E JSON evidence is malformed"); } }
	if ((mimeType.startsWith("text/") || mimeType === "application/json") && (bytes.includes(0) || containsObviousSensitiveContent(bytes.subarray(0, 128 * 1024).toString("utf8")))) throw new Error("E2E evidence contains binary, credential, or private material; retain a sanitized witness instead");
	if (mimeType === "image/png" && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("E2E PNG evidence has invalid content");
	if (mimeType === "image/jpeg" && (bytes[0] !== 0xff || bytes[1] !== 0xd8)) throw new Error("E2E JPEG evidence has invalid content");
	if (mimeType === "image/webp" && (bytes.subarray(0,4).toString() !== "RIFF" || bytes.subarray(8,12).toString() !== "WEBP")) throw new Error("E2E WebP evidence has invalid content");
}
async function validateSource(evaluation: E2eEvaluation, sourcePath: string): Promise<{ bytes: Buffer; extension: string; mimeType: string }> {
	if (!sourcePath || sourcePath.includes("\0")) throw new Error("E2E evidence source path is invalid");
	const lexical = resolve(evaluation.outputDirectory, sourcePath.replace(/^@/, ""));
	if (dirname(lexical) !== evaluation.outputDirectory) throw new Error("E2E evidence must be one individual file directly inside the evaluation output directory");
	if (looksSensitiveEvidenceName(basename(lexical))) throw new Error("E2E evidence filename looks sensitive; create a sanitized minimal witness instead");
	const extension = extname(lexical).toLowerCase();
	const mimeType = TYPES[extension];
	if (!mimeType) throw new Error(`Unsupported E2E evidence type: ${extension || "no extension"}`);
	let handle;
	try { handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { throw new Error(`E2E evidence must be an existing non-symlink regular file: ${sourcePath}`, { cause: error }); }
	try {
		const before = await handle.stat(); owned(before, lexical);
		if (!before.isFile() || before.nlink !== 1) throw new Error(`E2E evidence is not a standalone regular file: ${sourcePath}`);
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error(`E2E evidence changed while reading: ${sourcePath}`);
		assertPassiveContent(bytes, mimeType);
		return { bytes, extension, mimeType };
	} finally { await handle.close(); }
}
function assertEvaluation(evaluation: E2eEvaluation, workspace: E2eWorkspace): void {
	const expected = evaluationFor(workspace, evaluation.runId);
	for (const key of ["root", "outputDirectory", "evidenceDirectory", "reportPath"] as const) if (evaluation[key] !== expected[key]) throw new Error("E2E evaluation paths do not match owned workspace");
}
function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(operation);
	queues.set(key, next);
	return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
}

/** Retain one supported sanitized file, deduplicated by content within this evaluation. */
export function retainE2eEvidence({ evaluation, sourcePath, reason }: { evaluation: E2eEvaluation; sourcePath: string; reason: string }): Promise<RetainedE2eEvidence> {
	return enqueue(evaluation.root, async () => {
		const workspace = await restoreE2eWorkspace({ binding: evaluation.workspace.binding });
		assertEvaluation(evaluation, workspace);
		if (!reason.trim() || reason.includes("\0")) throw new Error("E2E evidence requires a short retention reason");
		await withPrivateDirectories([workspace.root, workspace.evaluationsRoot, evaluation.root, evaluation.evidenceDirectory], async () => {
			try { await lstat(evaluation.reportPath); throw new Error("E2E evaluation is finalized; its evidence is immutable"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		});
		return withPrivateDirectories([workspace.root, workspace.evaluationsRoot, evaluation.root, evaluation.outputDirectory, evaluation.evidenceDirectory], async () => {
			const records = retainedByEvaluation.get(evaluation.root);
			if (!records) throw new Error("E2E evaluation retention capability is unavailable");
			const source = await validateSource(evaluation, sourcePath);
			const sha256 = createHash("sha256").update(source.bytes).digest("hex");
			const name = `${sha256}${source.extension}`;
			const reference = `evidence/${name}`;
			const absolutePath = join(evaluation.evidenceDirectory, name);
			let deduplicated = records.has(reference);
			if (!deduplicated) {
				try { await publishExclusive(absolutePath, source.bytes); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const existing = await readPrivate(absolutePath);
					if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("Retained E2E evidence hash collision");
				}
				records.set(reference, { reference, absolutePath, sha256, bytes: source.bytes.byteLength, mimeType: source.mimeType, reasons: new Set([reason]) });
			} else records.get(reference)!.reasons.add(reason);
			const retainedBytes = [...records.values()].reduce((sum, item) => sum + item.bytes, 0);
			return { reference, absolutePath, sha256, bytes: source.bytes.byteLength, mimeType: source.mimeType, deduplicated, retainedFiles: records.size, retainedBytes };
		});
	});
}

function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void { const extra = Object.keys(value).filter((key) => !keys.includes(key)); if (extra.length) throw new Error(`${label} contains unsupported fields: ${extra.join(", ")}`); }
function text(value: unknown, label: string, nonEmpty = false): string { if (typeof value !== "string" || value.includes("\0") || (nonEmpty && !value.trim())) throw new Error(`${label} must be ${nonEmpty ? "a non-empty " : "a "}string`); return value; }
function strings(value: unknown, label: string): string[] | undefined { if (value === undefined) return undefined; if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value.map((item, index) => text(item, `${label}[${index}]`)); }
function normalizeInput(value: unknown, required: readonly string[], allowedEvidence: ReadonlySet<string>): E2eReportInput {
	const report = object(value, "E2E report"); exact(report, ["cases","summary","findings"], "E2E report");
	if (!Array.isArray(report.cases)) throw new Error("E2E report cases must be an array");
	const seen = new Set<string>();
	const cases = report.cases.map((item, index) => {
		const entry = object(item, `E2E report cases[${index}]`); exact(entry, ["case","verdict","steps","expected","observed","evidence","notes"], `E2E report cases[${index}]`);
		const caseId = text(entry.case, `E2E report cases[${index}].case`, true); if (seen.has(caseId)) throw new Error(`E2E report contains duplicate case ${caseId}`); seen.add(caseId);
		if (entry.verdict !== "passed" && entry.verdict !== "failed" && entry.verdict !== "blocked") throw new Error(`E2E report cases[${index}].verdict must be passed, failed, or blocked`);
		const evidence = strings(entry.evidence, `E2E report cases[${index}].evidence`); for (const ref of evidence ?? []) if (!allowedEvidence.has(ref)) throw new Error("E2E report references evidence not retained by this evaluation");
		return { case: caseId, verdict: entry.verdict as E2eVerdict, ...(strings(entry.steps, `E2E report cases[${index}].steps`) ? { steps: strings(entry.steps, `E2E report cases[${index}].steps`)! } : {}), ...(entry.expected === undefined ? {} : { expected: text(entry.expected, "expected") }), ...(entry.observed === undefined ? {} : { observed: text(entry.observed, "observed") }), ...(evidence === undefined ? {} : { evidence }), ...(entry.notes === undefined ? {} : { notes: text(entry.notes, "notes") }) };
	});
	const missing = required.filter((id) => !seen.has(id)); if (missing.length) throw new Error(`E2E report must include every required case; missing: ${missing.join(", ")}`);
	let findings: E2eFindingInput[] | undefined;
	if (report.findings !== undefined) { if (!Array.isArray(report.findings)) throw new Error("E2E report findings must be an array"); findings = report.findings.map((item, index) => { const finding = object(item, `E2E report findings[${index}]`); exact(finding,["summary","severity"],`E2E report findings[${index}]`); if (finding.severity !== undefined && !["minor","major","critical"].includes(finding.severity as string)) throw new Error("E2E finding severity must be minor, major, or critical"); return { summary: text(finding.summary, "E2E finding summary", true), ...(finding.severity === undefined ? {} : { severity: finding.severity as E2eFindingSeverity }) }; }); }
	return { cases, ...(report.summary === undefined ? {} : { summary: text(report.summary, "E2E report summary") }), ...(findings === undefined ? {} : { findings }) };
}
function resultFor(input: E2eReportInput): E2eReport["result"] { if (input.findings?.some((f) => f.severity === "critical")) return "critical"; if (input.cases.some((c) => c.verdict === "failed") || input.findings?.some((f) => (f.severity ?? "major") === "major")) return "repairable"; if (input.cases.some((c) => c.verdict === "blocked")) return "needs_user"; return "passed"; }
function canonical(input: E2eReportInput): E2eReport { return { schemaVersion: 1, result: resultFor(input), ...(input.summary === undefined ? {} : { summary: input.summary }), caseResults: input.cases.map((item) => ({ caseId: item.case, status: item.verdict, executedActions: [...(item.steps ?? [])], observations: item.observed === undefined ? [] : [item.observed], evidenceRefs: [...(item.evidence ?? [])], ...(item.expected === undefined ? {} : { expected: item.expected }), ...(item.notes === undefined ? {} : { notes: item.notes }) })), ...(input.findings === undefined ? {} : { findings: input.findings.map((f) => ({...f})) }) }; }

/** Finalize report.json and optional invocation-private handoff. Failed validation leaves evaluation correctable. */
export function submitE2eWorkspaceReport({ evaluation, submission, requiredCaseIds, nativeReportPath }: { evaluation: E2eEvaluation; submission: E2eReportInput; requiredCaseIds?: readonly string[]; nativeReportPath?: string }): Promise<E2eWorkspaceReportResult> {
	return enqueue(evaluation.root, async () => {
		const workspace = await restoreE2eWorkspace({ binding: evaluation.workspace.binding });
		assertEvaluation(evaluation, workspace);
		await withPrivateDirectories([workspace.root, workspace.evaluationsRoot, evaluation.root, evaluation.evidenceDirectory], async () => {
			try { await lstat(evaluation.reportPath); throw new Error("E2E evaluation report is already finalized and immutable"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		});
		const records = retainedByEvaluation.get(evaluation.root);
		if (!records) throw new Error("E2E evaluation retention capability is unavailable");
		const reference = await withPrivateDirectories([workspace.root, workspace.evaluationsRoot, evaluation.root, evaluation.outputDirectory, evaluation.evidenceDirectory], async () => {
			const required = requiredCaseIds ?? await (process as ProviderProcess)[REQUIRED_CASES_PROVIDER]?.() ?? [];
			const report = canonical(normalizeInput(submission, required, new Set(records.keys())));
			const referenced = new Set(report.caseResults.flatMap((item) => item.evidenceRefs));
			for (const ref of referenced) {
				const retained = records.get(ref);
				if (!retained || !/^evidence\/[0-9a-f]{64}\.(txt|log|json|png|jpe?g|webp)$/.test(ref)) throw new Error("E2E report has invalid retained evidence reference");
				const bytes = await readPrivate(retained.absolutePath);
				if (createHash("sha256").update(bytes).digest("hex") !== retained.sha256 || bytes.byteLength !== retained.bytes) throw new Error("Retained E2E evidence content changed");
				assertPassiveContent(bytes, retained.mimeType);
			}
			const serializedJsonText = `${JSON.stringify(report)}\n`;
			if (containsObviousSensitiveContent(serializedJsonText)) throw new Error("E2E report contains obvious credential or private material");
			await publishExclusive(evaluation.reportPath, serializedJsonText);
			const result: E2eWorkspaceReportReference = { workspaceId: evaluation.workspace.binding.workspaceId, sessionId: evaluation.workspace.binding.sessionId, runId: evaluation.runId, reportPath: evaluation.reportPath, reportSha256: createHash("sha256").update(serializedJsonText).digest("hex") };
			if (nativeReportPath) {
				const path = validatedReceiptPath(nativeReportPath);
				const receipt: Handoff = { schemaVersion: 1, nativeReportPath: resolve(nativeReportPath), reference: result };
				try { await withPrivateDirectories([dirname(resolve(nativeReportPath))], async () => atomicReplace(path, `${JSON.stringify(receipt)}\n`)); } catch (error) { await rm(evaluation.reportPath, { force: true }); throw error; }
			}
			for (const [ref, retained] of records) if (!referenced.has(ref)) await unlink(retained.absolutePath);
			for (const name of await readdir(evaluation.evidenceDirectory)) if (!referenced.has(`evidence/${name}`)) await unlink(join(evaluation.evidenceDirectory, name)).catch(() => undefined);
			return result;
		});
		await rm(evaluation.outputDirectory, { recursive: true });
		retainedByEvaluation.delete(evaluation.root);
		return readE2eWorkspaceReport(reference);
	});
}
function validatedReceiptPath(nativeReportPath: string): string {
	const resolved = resolve(nativeReportPath);
	if (!nativeReportPath || basename(resolved) !== "report.md" || !resolved.startsWith(`${ROOT}${sep}`)) throw new Error("E2E workspace handoff requires absolute harness report.md path under /tmp");
	return join(dirname(resolved), RECEIPT_NAME);
}
function validateCanonical(value: unknown): E2eReport {
	const report = object(value, "E2E report snapshot"); exact(report,["schemaVersion","result","summary","caseResults","findings"],"E2E report snapshot");
	if (report.schemaVersion !== 1 || !["passed","repairable","critical","needs_user"].includes(report.result as string) || !Array.isArray(report.caseResults)) throw new Error("E2E report snapshot has invalid schema");
	const input: E2eReportInput = { cases: report.caseResults.map((item, index) => { const entry = object(item,`E2E caseResults[${index}]`); exact(entry,["caseId","status","executedActions","observations","evidenceRefs","expected","notes"],`E2E caseResults[${index}]`); const observations = strings(entry.observations,"observations") ?? []; if (observations.length > 1) throw new Error("E2E report observations shape is invalid"); return { case:text(entry.caseId,"caseId",true), verdict:entry.status as E2eVerdict, steps:strings(entry.executedActions,"executedActions") ?? [], evidence:strings(entry.evidenceRefs,"evidenceRefs") ?? [], ...(observations[0] === undefined ? {} : { observed:observations[0] }), ...(entry.expected === undefined ? {} : { expected:text(entry.expected,"expected") }), ...(entry.notes === undefined ? {} : { notes:text(entry.notes,"notes") }) }; }), ...(report.summary === undefined ? {} : { summary:text(report.summary,"summary") }), ...(report.findings === undefined ? {} : { findings:report.findings as E2eFindingInput[] }) };
	const normalized = normalizeInput(input, [], new Set(input.cases.flatMap((c) => c.evidence ?? []))); const expected = canonical(normalized);
	if (JSON.stringify(expected) !== JSON.stringify(value)) throw new Error("E2E report snapshot content or aggregate result is invalid");
	return value as E2eReport;
}

/** Read exact referenced bytes after binding, path, hash, ownership, and evidence validation. */
export async function readE2eWorkspaceReport(reference: E2eWorkspaceReportReference): Promise<E2eWorkspaceReportResult> {
	if (!reference || !RUN_ID.test(reference.runId) || !SHA256.test(reference.reportSha256)) throw new Error("E2E workspace report reference is invalid");
	const workspace = await restoreE2eWorkspace({ binding: { workspaceId: reference.workspaceId, sessionId: reference.sessionId } });
	const evaluation = evaluationFor(workspace, reference.runId);
	if (resolve(reference.reportPath) !== evaluation.reportPath) throw new Error("E2E workspace report reference points outside its evaluation");
	return withPrivateDirectories([workspace.root, workspace.evaluationsRoot, evaluation.root, evaluation.evidenceDirectory], async () => {
		const serialized = await readPrivate(evaluation.reportPath);
		const serializedJsonText = serialized.toString("utf8");
		if (createHash("sha256").update(serialized).digest("hex") !== reference.reportSha256) throw new Error("E2E workspace report content changed");
		const report = validateCanonical(parseObject(serializedJsonText, "E2E report snapshot"));
		const evidence = [] as E2eWorkspaceReportResult["evidence"];
		for (const ref of [...new Set(report.caseResults.flatMap((item) => item.evidenceRefs))]) {
			if (!/^evidence\/[0-9a-f]{64}\.(txt|log|json|png|jpe?g|webp)$/.test(ref)) throw new Error("E2E report has invalid evidence reference");
			const absolutePath = join(evaluation.root, ref); if (relative(evaluation.root, absolutePath).startsWith(`..${sep}`)) throw new Error("E2E evidence reference escapes evaluation");
			const bytes = await readPrivate(absolutePath); const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (basename(ref).slice(0,64) !== sha256) throw new Error("E2E evidence content changed");
			assertPassiveContent(bytes, TYPES[extname(ref).toLowerCase()]!);
			evidence.push({ reference: ref, absolutePath, sha256, bytes: bytes.byteLength, mimeType: TYPES[extname(ref).toLowerCase()]! });
		}
		return { reference: { ...reference }, report, serializedJsonText, workspaceRoot: workspace.root, reportPath: evaluation.reportPath, evidence };
	});
}

/** Read fixed invocation receipt beside native report.md; undefined means no submitted workspace report. */
export async function readE2eWorkspaceHandoff(nativeReportPath: string): Promise<E2eWorkspaceReportResult | undefined> {
	const receiptPath = validatedReceiptPath(nativeReportPath);
	return withPrivateDirectories([dirname(resolve(nativeReportPath))], async () => {
		let bytes: Buffer; try { bytes = await readPrivate(receiptPath, META_BYTES); } catch (error) { if ((error as Error).cause && ((error as Error).cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		const receipt = parseObject(bytes.toString("utf8"), "E2E workspace handoff"); exact(receipt,["schemaVersion","nativeReportPath","reference"],"E2E workspace handoff");
		if (receipt.schemaVersion !== 1 || receipt.nativeReportPath !== resolve(nativeReportPath)) throw new Error("E2E workspace handoff belongs to another invocation");
		return readE2eWorkspaceReport(receipt.reference as E2eWorkspaceReportReference);
	});
}
