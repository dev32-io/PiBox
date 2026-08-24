import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { parseTaskManifest, parseWorkItemIndex } from "../../workflow/work-items.js";
import type { WorkItemIndex } from "../../workflow/types.js";
import { readEvidenceMetadata } from "./evidence.js";
import type { DeliveryHistory, Diagnostic, DocumentDetail, DocumentGroup, DocumentSummary, Finding, ReportDetail, ReportSummary, StorySummary, StoryWorkspace, TaskCard, TaskDetail } from "./models.js";
import { documentGroup, orderDocuments, orderReports, orderStorySummaries, orderTaskCards, projectStorySummary, projectTaskCard } from "./projector.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function diagnostic(path: string, message: string): Diagnostic { return { path, message }; }
function safePath(path: unknown): path is string {
	return typeof path === "string" && Boolean(path) && !isAbsolute(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function commit(value: unknown): string | undefined { return typeof value === "string" && /^[0-9a-f]{7,64}$/.test(value) ? value : undefined; }
export function projectDeliveryHistory(value: unknown): DeliveryHistory | undefined {
	const runtime = record(value); if (!runtime) return undefined;
	const executionMode = runtime.executionMode === "repository" || runtime.executionMode === "worktree" ? runtime.executionMode : undefined;
	const completedCommit = commit(runtime.completedCommit); const mergedCommit = commit(runtime.mergedCommit);
	return executionMode || completedCommit || mergedCommit ? { ...(executionMode ? { executionMode } : {}), ...(completedCommit ? { completedCommit } : {}), ...(mergedCommit ? { mergedCommit } : {}) } : undefined;
}
function excerpt(markdown: string): string {
	return markdown.replace(/<!--[^]*?-->/g, "").replace(/^#{1,6}\s+.*$/m, "").split(/\r?\n/).map((line) => line.replace(/^[-*>]\s*/, "").trim()).filter(Boolean).slice(0, 3).join(" ").replace(/[*_`[\]]/g, "").slice(0, 280);
}
function titleFromMarkdown(markdown: string, fallback: string): string { return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback; }

async function regularFile(path: string, root: string, repositoryRoot: string): Promise<boolean> {
	const info = await lstat(path).catch(() => undefined);
	if (!info?.isFile() || info.isSymbolicLink()) return false;
	const [actual, actualRoot, actualRepository] = await Promise.all([realpath(path).catch(() => undefined), realpath(root).catch(() => undefined), realpath(repositoryRoot).catch(() => undefined)]);
	return Boolean(actual && actualRoot && actualRepository && inside(actualRepository, actualRoot) && inside(actualRoot, actual));
}
async function containedDirectory(path: string, root: string, repositoryRoot: string): Promise<boolean> {
	const info = await lstat(path).catch(() => undefined);
	if (!info?.isDirectory() || info.isSymbolicLink()) return false;
	const [actual, actualRoot, actualRepository] = await Promise.all([realpath(path).catch(() => undefined), realpath(root).catch(() => undefined), realpath(repositoryRoot).catch(() => undefined)]);
	return Boolean(actual && actualRoot && actualRepository && inside(actualRepository, actualRoot) && inside(actualRoot, actual));
}
async function unsafeExistingTarget(path: string, repositoryRoot: string): Promise<boolean> {
	const info = await lstat(path).catch(() => undefined); if (!info) return false;
	const [actual, actualRepository] = await Promise.all([realpath(path).catch(() => undefined), realpath(repositoryRoot).catch(() => undefined)]);
	return info.isSymbolicLink() || !actual || !actualRepository || !inside(actualRepository, actual);
}
async function invalidExistingFile(path: string, root: string, repositoryRoot: string): Promise<boolean> {
	return Boolean(await lstat(path).catch(() => undefined)) && !(await regularFile(path, root, repositoryRoot));
}

interface IndexRead { value: RecordValue; strict?: WorkItemIndex; diagnostics: Diagnostic[] }

export class StoryBoardReader {
	readonly repositoryRoot: string;
	readonly artifactRoot: string;
	constructor(repositoryRoot: string) { this.repositoryRoot = resolve(repositoryRoot); this.artifactRoot = join(this.repositoryRoot, "agent-artifacts"); }

	private storyRoot(id: string): string | undefined { return ID.test(id) ? join(this.artifactRoot, id) : undefined; }
	private async containedStoryRoot(id: string): Promise<string | undefined> {
		const root = this.storyRoot(id); if (!root) return undefined;
		const [repositoryReal, artifactReal, storyReal, artifactInfo, storyInfo] = await Promise.all([
			realpath(this.repositoryRoot).catch(() => undefined), realpath(this.artifactRoot).catch(() => undefined), realpath(root).catch(() => undefined),
			lstat(this.artifactRoot).catch(() => undefined), lstat(root).catch(() => undefined),
		]);
		if (!repositoryReal || !artifactReal || !storyReal || !artifactInfo?.isDirectory() || artifactInfo.isSymbolicLink() || !storyInfo?.isDirectory() || storyInfo.isSymbolicLink()) return undefined;
		return inside(repositoryReal, artifactReal) && inside(artifactReal, storyReal) ? root : undefined;
	}
	private async containedEvaluationRoot(storyRoot: string, evaluationId: string): Promise<string | undefined> {
		if (!ID.test(evaluationId)) return undefined;
		const evaluationsRoot = join(storyRoot, "evaluations"); const evaluationRoot = join(evaluationsRoot, evaluationId);
		const [repositoryReal, storyReal, evaluationsReal, evaluationReal, evaluationsInfo, evaluationInfo] = await Promise.all([
			realpath(this.repositoryRoot).catch(() => undefined), realpath(storyRoot).catch(() => undefined), realpath(evaluationsRoot).catch(() => undefined), realpath(evaluationRoot).catch(() => undefined),
			lstat(evaluationsRoot).catch(() => undefined), lstat(evaluationRoot).catch(() => undefined),
		]);
		if (!repositoryReal || !storyReal || !evaluationsReal || !evaluationReal || !evaluationsInfo?.isDirectory() || evaluationsInfo.isSymbolicLink() || !evaluationInfo?.isDirectory() || evaluationInfo.isSymbolicLink()) return undefined;
		return inside(repositoryReal, storyReal) && inside(storyReal, evaluationsReal) && inside(evaluationsReal, evaluationReal) ? evaluationRoot : undefined;
	}
	private async readIndex(id: string, root: string): Promise<IndexRead> {
		const display = `agent-artifacts/${id}/index.yaml`;
		let content: string;
		const indexPath = join(root, "index.yaml");
		if (!(await regularFile(indexPath, root, this.repositoryRoot))) return { value: {}, diagnostics: [diagnostic(display, "Story index is missing or not a contained regular file")] };
		try { content = await readFile(indexPath, "utf8"); }
		catch { return { value: {}, diagnostics: [diagnostic(display, "Story index is missing or unreadable")] }; }
		let value: RecordValue = {};
		try { value = record(parse(content)) ?? {}; }
		catch {
			const recovered: RecordValue = {};
			for (const key of ["id", "title", "kind", "phase", "state"] as const) { const match = content.match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)`, "m")); if (match?.[1]) recovered[key] = match[1].trim(); }
			return { value: recovered, diagnostics: [diagnostic(display, "Story index is malformed; bounded metadata was recovered")] };
		}
		try {
			const strict = parseWorkItemIndex(content, display);
			if (strict.id !== id) return { value, diagnostics: [diagnostic(display, "Story index id does not match its canonical directory")] };
			return { value, strict, diagnostics: [] };
		} catch { return { value, diagnostics: [diagnostic(display, "Story index does not satisfy the current contract; compatible metadata was recovered")] }; }
	}

	private async summary(id: string, root: string): Promise<StorySummary> {
		const index = await this.readIndex(id, root);
		const value = index.value;
		const planning = record(value.planning);
		const listedTasks = Array.isArray(value.tasks) ? value.tasks.length : 0;
		const listedReports = Array.isArray(value.evaluations) ? value.evaluations.length : 0;
		let intentExcerpt = "";
		const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
		const intentEntry = artifacts.map(record).find((entry) => entry?.type === "intent");
		const intentPath = safePath(intentEntry?.path) ? intentEntry.path : "intent.md";
		if (safePath(intentPath)) {
			const candidate = join(root, intentPath);
			if (await regularFile(candidate, root, this.repositoryRoot)) intentExcerpt = await readFile(candidate, "utf8").then(excerpt, () => "");
		}
		return projectStorySummary({
			id, title: typeof value.title === "string" ? value.title : undefined, intentExcerpt,
			kind: typeof value.kind === "string" ? value.kind : undefined, phase: typeof value.phase === "string" ? value.phase : undefined,
			state: typeof value.state === "string" ? value.state : undefined,
			planningRevision: typeof planning?.revision === "number" ? planning.revision : undefined,
			taskCount: listedTasks, reportCount: listedReports, diagnostics: index.diagnostics,
		});
	}

	async readCatalog(): Promise<StorySummary[]> {
		const rootInfo = await lstat(this.artifactRoot).catch(() => undefined);
		const [repositoryReal, artifactReal] = await Promise.all([realpath(this.repositoryRoot).catch(() => undefined), realpath(this.artifactRoot).catch(() => undefined)]);
		if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !repositoryReal || !artifactReal || !inside(repositoryReal, artifactReal)) return [];
		const entries = await readdir(this.artifactRoot, { withFileTypes: true }).catch(() => []);
		const ids = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && ID.test(entry.name)).map((entry) => entry.name).sort();
		const roots = await Promise.all(ids.map(async (id) => ({ id, root: await this.containedStoryRoot(id) })));
		return orderStorySummaries(await Promise.all(roots.flatMap(({ id, root }) => root ? [this.summary(id, root)] : [])));
	}

	private catalogEntries(storyId: string, value: unknown, kind: "task" | "evaluation"): Array<{ id: string; path: string; diagnostics: Diagnostic[] }> {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		return value.flatMap((raw, index) => {
			const item = record(raw); const validId = typeof item?.id === "string" && ID.test(item.id); const id = validId ? item.id as string : `invalid-${kind}-${index + 1}`;
			if (seen.has(id)) return [];
			seen.add(id);
			const expected = kind === "task" ? `tasks/${id}/task.yaml` : `evaluations/${id}/evaluation.yaml`;
			const valid = validId && safePath(item?.path) && item.path === expected;
			return [{ id, path: valid ? item!.path as string : expected, diagnostics: valid ? [] : [diagnostic(`agent-artifacts/${storyId}/index.yaml`, `Invalid ${kind} catalog entry ${index + 1}`)] }];
		});
	}

	private async readTaskCard(storyId: string, root: string, entry: { id: string; path: string; diagnostics: Diagnostic[] }, reportIds: string[]): Promise<TaskCard> {
		const display = `agent-artifacts/${storyId}/${entry.path}`; const diagnostics = [...entry.diagnostics];
		let raw: RecordValue = {};
		try {
			const taskPath = join(root, entry.path);
			if (!(await regularFile(taskPath, root, this.repositoryRoot))) throw new Error("not regular");
			const content = await readFile(taskPath, "utf8"); raw = record(parse(content)) ?? {};
			try { const strict = parseTaskManifest(content, display); if (strict.id !== entry.id) throw new Error("id mismatch"); } catch { diagnostics.push(diagnostic(display, "Task manifest does not satisfy the current contract; compatible metadata was recovered")); }
		} catch { diagnostics.push(diagnostic(display, "Task manifest is missing, malformed, or not a contained regular file")); }
		const assembly = record(raw.assembly); const stage = typeof assembly?.stageId === "string" ? assembly.stageId : typeof assembly?.integrationUnit === "string" ? assembly.integrationUnit : undefined;
		return projectTaskCard({ id: entry.id, title: typeof raw.title === "string" ? raw.title : undefined, status: typeof raw.status === "string" ? raw.status : undefined, dependsOn: strings(raw.dependsOn), stage, relatedReportIds: reportIds, diagnostics });
	}

	private reportScope(raw: RecordValue): ReportSummary["scope"] {
		const scope = record(raw.scope);
		if (typeof scope?.task === "string") return { kind: "task", id: scope.task };
		if (typeof raw.stageId === "string") return { kind: "stage", id: raw.stageId };
		if (typeof scope?.integrationUnit === "string") return { kind: "stage", id: scope.integrationUnit };
		if (raw.checkpoint === "final-e2e" || raw.type === "e2e") return { kind: "e2e" };
		if (raw.checkpoint === "final-review") return { kind: "final" };
		if (typeof scope?.workItem === "string") return { kind: "story", id: scope.workItem };
		return { kind: "unknown" };
	}

	private async readReportSummary(storyId: string, root: string, entry: { id: string; path: string; diagnostics: Diagnostic[] }): Promise<{ summary: ReportSummary; raw: RecordValue; evaluationRoot?: string }> {
		const display = `agent-artifacts/${storyId}/${entry.path}`; const diagnostics = [...entry.diagnostics]; let raw: RecordValue = {};
		const evaluationRoot = await this.containedEvaluationRoot(root, entry.id);
		try {
			const evaluationPath = join(root, entry.path);
			if (!evaluationRoot || !(await regularFile(evaluationPath, evaluationRoot, this.repositoryRoot))) throw new Error("not regular");
			raw = record(parse(await readFile(evaluationPath, "utf8"))) ?? {};
		} catch { diagnostics.push(diagnostic(display, "Evaluation manifest is missing, malformed, or not a contained regular file")); }
		const valid = Boolean(raw.schemaVersion === 1 && raw.id === entry.id && typeof raw.type === "string" && typeof raw.status === "string" && record(raw.scope) && Number.isInteger(raw.attempt));
		if (!valid && Object.keys(raw).length) diagnostics.push(diagnostic(display, "Evaluation manifest does not satisfy the current contract; compatible metadata was recovered"));
		const result = record(raw.result); const scope = this.reportScope(raw); const riskPath = typeof result?.riskAcceptance === "string" ? result.riskAcceptance : undefined;
		return { raw, ...(evaluationRoot ? { evaluationRoot } : {}), summary: {
			id: entry.id, type: typeof raw.type === "string" ? raw.type : "unknown", status: typeof raw.status === "string" ? raw.status : "unknown",
			...(typeof result?.verdict === "string" ? { verdict: result.verdict } : {}), attempt: typeof raw.attempt === "number" ? raw.attempt : 0, scope,
			...(scope.kind === "task" && scope.id ? { taskId: scope.id } : {}), findingCount: Array.isArray(raw.findings) ? raw.findings.length : 0,
			hasRiskAcceptance: Boolean(riskPath), available: valid, diagnostics,
		} };
	}

	private async documents(storyId: string, root: string, raw: RecordValue): Promise<DocumentSummary[]> {
		if (!Array.isArray(raw.artifacts)) return [];
		const projected = raw.artifacts.flatMap((value): DocumentSummary[] => {
			const item = record(value); const type = typeof item?.type === "string" ? item.type : ""; const group = documentGroup(type); const id = typeof item?.id === "string" ? item.id : "invalid-document";
			if (!group) return [];
			const path = safePath(item?.path) ? item.path : ""; const diagnostics = path ? [] : [diagnostic(`agent-artifacts/${storyId}/index.yaml`, `Document ${id} has an unsafe path`)];
			return [{ id, title: id.replaceAll("-", " "), type, group, path: path ? `agent-artifacts/${storyId}/${path}` : "", status: typeof item?.status === "string" ? item.status : "unknown", available: Boolean(path), diagnostics }];
		});
		const checked = await Promise.all(projected.map(async (document) => {
			if (!document.path || await regularFile(join(this.repositoryRoot, document.path), root, this.repositoryRoot)) return document;
			return { ...document, available: false, diagnostics: [...document.diagnostics, diagnostic(document.path, "Document is missing or not a contained regular file")] };
		}));
		return orderDocuments(checked);
	}

	async readWorkspace(storyId: string): Promise<StoryWorkspace | undefined> {
		const root = await this.containedStoryRoot(storyId); if (!root) return undefined;
		const index = await this.readIndex(storyId, root); const story = await this.summary(storyId, root);
		const reportEntries = this.catalogEntries(storyId, index.value.evaluations, "evaluation");
		const reportReads = await Promise.all(reportEntries.map((entry) => this.readReportSummary(storyId, root, entry)));
		const reports = orderReports(reportReads.map((item) => item.summary));
		const reportTasks = new Map<string, string[]>(); for (const report of reports) if (report.taskId) reportTasks.set(report.taskId, [...(reportTasks.get(report.taskId) ?? []), report.id]);
		const taskEntries = this.catalogEntries(storyId, index.value.tasks, "task");
		const tasks = orderTaskCards(await Promise.all(taskEntries.map((entry) => this.readTaskCard(storyId, root, entry, reportTasks.get(entry.id) ?? []))));
		const columns = { "To do": [] as TaskCard[], "In progress": [] as TaskCard[], Done: [] as TaskCard[] }; for (const task of tasks) columns[task.column].push(task);
		const documents = await this.documents(storyId, root, index.value); const groups = new Map<DocumentGroup, DocumentSummary[]>(); for (const document of documents) groups.set(document.group, [...(groups.get(document.group) ?? []), document]);
		const documentGroups = (["Intent and scope", "Specifications", "Design", "Decisions", "Journey cases", "Outcome"] as DocumentGroup[]).flatMap((group) => groups.has(group) ? [{ group, documents: groups.get(group)! }] : []);
		return { story, columns, tasks, documentGroups, reports, diagnostics: [...index.diagnostics, ...tasks.flatMap((task) => task.diagnostics), ...reports.flatMap((report) => report.diagnostics), ...documents.flatMap((document) => document.diagnostics)] };
	}

	async readTaskDetail(storyId: string, taskId: string): Promise<TaskDetail | undefined> {
		if (!ID.test(taskId)) return undefined; const workspace = await this.readWorkspace(storyId); const card = workspace?.tasks.find((task) => task.id === taskId); if (!card) return undefined;
		const root = await this.containedStoryRoot(storyId); if (!root) return undefined;
		const entryPath = `tasks/${taskId}/task.yaml`; let raw: RecordValue = {};
		const taskPath = join(root, entryPath);
		if (await unsafeExistingTarget(taskPath, this.repositoryRoot)) return undefined;
		try { if (await regularFile(taskPath, root, this.repositoryRoot)) raw = record(parse(await readFile(taskPath, "utf8"))) ?? {}; } catch { /* card already carries diagnostic */ }
		const execution = record(raw.execution); const assignment = record(execution?.assignment); const verification = record(raw.verification);
		const readNarrative = async (name: string): Promise<string | undefined> => {
			const path = join(root, "tasks", taskId, name);
			return await regularFile(path, root, this.repositoryRoot) ? readFile(path, "utf8").catch(() => undefined) : undefined;
		};
		const [brief, acceptance] = await Promise.all([readNarrative("brief.md"), readNarrative("acceptance.md")]);
		const agent = typeof assignment?.agent === "string" ? assignment.agent : typeof assignment?.role === "string" ? assignment.role : undefined;
		const deliveryHistory = projectDeliveryHistory(raw.runtime);
		return { ...card, ...(brief ? { brief } : {}), ...(acceptance ? { acceptance } : {}), ...(agent ? { assignment: { agent, ...(typeof assignment?.tier === "string" ? { tier: assignment.tier } : {}), ...(typeof assignment?.rationale === "string" ? { rationale: assignment.rationale } : {}) } } : {}), verification: { methods: strings(verification?.methods), taskChecks: strings(verification?.taskChecks) }, ...(deliveryHistory ? { deliveryHistory } : {}) };
	}

	async readDocumentDetail(storyId: string, documentId: string): Promise<DocumentDetail | undefined> {
		const workspace = await this.readWorkspace(storyId); const summary = workspace?.documentGroups.flatMap((group) => group.documents).find((document) => document.id === documentId); if (!summary) return undefined;
		const root = await this.containedStoryRoot(storyId); if (!root) return undefined;
		const path = join(this.repositoryRoot, summary.path);
		if (summary.path && await unsafeExistingTarget(path, this.repositoryRoot)) return undefined;
		if (!summary.path || !(await regularFile(path, root, this.repositoryRoot))) return { ...summary, available: false, diagnostics: [...summary.diagnostics, diagnostic(summary.path || `agent-artifacts/${storyId}/index.yaml`, "Document is missing or not a contained regular file")] };
		const body = await readFile(path, "utf8"); return { ...summary, title: titleFromMarkdown(body, summary.title), body };
	}

	async readReportDetail(storyId: string, reportId: string): Promise<ReportDetail | undefined> {
		if (!ID.test(reportId)) return undefined; const root = await this.containedStoryRoot(storyId); if (!root) return undefined;
		const index = await this.readIndex(storyId, root); const entry = this.catalogEntries(storyId, index.value.evaluations, "evaluation").find((item) => item.id === reportId); if (!entry) return undefined;
		const { summary, raw, evaluationRoot } = await this.readReportSummary(storyId, root, entry); if (!evaluationRoot) return undefined;
		const evaluationManifest = join(root, entry.path); if (await invalidExistingFile(evaluationManifest, evaluationRoot, this.repositoryRoot)) return undefined;
		const result = record(raw.result);
		const reportName = safePath(result?.report) && !result.report.includes("/") ? result.report : "report.md"; const reportDisplay = `agent-artifacts/${storyId}/evaluations/${reportId}/${reportName}`;
		const reportPath = join(evaluationRoot, reportName); if (await invalidExistingFile(reportPath, evaluationRoot, this.repositoryRoot)) return undefined;
		const body = await regularFile(reportPath, evaluationRoot, this.repositoryRoot) ? await readFile(reportPath, "utf8").catch(() => undefined) : undefined;
		const riskName = safePath(result?.riskAcceptance) && !result.riskAcceptance.includes("/") ? result.riskAcceptance : undefined;
		const riskPath = riskName ? join(evaluationRoot, riskName) : undefined;
		if (riskPath && await invalidExistingFile(riskPath, evaluationRoot, this.repositoryRoot)) return undefined;
		const riskAcceptance = riskPath && await regularFile(riskPath, evaluationRoot, this.repositoryRoot) ? await readFile(riskPath, "utf8").catch(() => undefined) : undefined;
		const attemptsRoot = join(evaluationRoot, "attempts"); const attemptsInfo = await lstat(attemptsRoot).catch(() => undefined);
		if (attemptsInfo && !(await containedDirectory(attemptsRoot, evaluationRoot, this.repositoryRoot))) return undefined;
		const attemptFiles = (attemptsInfo ? await readdir(attemptsRoot).catch(() => []) : []).filter((name) => /^\d+-report\.md$/.test(name)).sort();
		if ((await Promise.all(attemptFiles.map((name) => regularFile(join(attemptsRoot, name), evaluationRoot, this.repositoryRoot)))).some((valid) => !valid)) return undefined;
		const history = await Promise.all(attemptFiles.map(async (name) => { const attempt = Number.parseInt(name, 10); const attemptPath = join(attemptsRoot, name); const attemptBody = await readFile(attemptPath, "utf8").catch(() => undefined); return { attempt, path: `agent-artifacts/${storyId}/evaluations/${reportId}/attempts/${name}`, ...(attemptBody ? { body: attemptBody } : {}), available: Boolean(attemptBody) }; }));
		const findings: Finding[] = (Array.isArray(raw.findings) ? raw.findings : []).flatMap((value): Finding[] => { const item = record(value); if (!item || typeof item.id !== "string") return []; return [{ id: item.id, severity: typeof item.severity === "string" ? item.severity : "unknown", status: typeof item.status === "string" ? item.status : "unknown", summary: typeof item.summary === "string" ? item.summary : "", ...(typeof item.blocking === "boolean" ? { blocking: item.blocking } : {}), ...(typeof item.location === "string" ? { location: item.location } : {}) }]; });
		const cases = Array.isArray(result?.caseResults) ? result.caseResults.flatMap((value) => { const item = record(value); return item && typeof item.caseId === "string" && typeof item.status === "string" ? [{ caseId: item.caseId, status: item.status, executedActions: strings(item.executedActions), observations: strings(item.observations), evidenceRefs: strings(item.evidenceRefs) }] : []; }) : undefined;
		const diagnostics = body ? summary.diagnostics : [...summary.diagnostics, diagnostic(reportDisplay, "Evaluation report is missing")];
		return { ...summary, available: Boolean(body), diagnostics, ...(body ? { body } : {}), findings, ...(riskAcceptance ? { riskAcceptance } : {}), history, evidence: await readEvidenceMetadata(this.repositoryRoot, storyId, reportId), ...(cases ? { caseResults: cases } : {}) };
	}
}

export async function readStoryCatalog(repositoryRoot: string): Promise<StorySummary[]> { return new StoryBoardReader(repositoryRoot).readCatalog(); }
export async function readStoryWorkspace(repositoryRoot: string, storyId: string): Promise<StoryWorkspace | undefined> { return new StoryBoardReader(repositoryRoot).readWorkspace(storyId); }
export async function readTaskDetail(repositoryRoot: string, storyId: string, taskId: string): Promise<TaskDetail | undefined> { return new StoryBoardReader(repositoryRoot).readTaskDetail(storyId, taskId); }
export async function readDocumentDetail(repositoryRoot: string, storyId: string, documentId: string): Promise<DocumentDetail | undefined> { return new StoryBoardReader(repositoryRoot).readDocumentDetail(storyId, documentId); }
export async function readReportDetail(repositoryRoot: string, storyId: string, reportId: string): Promise<ReportDetail | undefined> { return new StoryBoardReader(repositoryRoot).readReportDetail(storyId, reportId); }
