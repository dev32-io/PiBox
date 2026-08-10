import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, runGit } from "./repository.js";
import type { EvaluationManifest, TaskManifest, TaskStatus, WorkItemIndex, WorkItemKind } from "./types.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_DIRECTORIES = { spec: "specs", design: "design", decision: "decisions" } as const;
type MutableArtifactType = keyof typeof ARTIFACT_DIRECTORIES;

function validateId(id: string, label: string): void {
	if (!ID_PATTERN.test(id)) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a kebab-case identifier`);
}

function ensureInside(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
		throw new HarnessError("INVALID_ARTIFACT", `Path escapes its managed root: ${path}`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

export function parseWorkItemIndex(content: string, source = "index.yaml"): WorkItemIndex {
	const value = parse(content) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} must contain a mapping`);
	}
	const index = value as Partial<WorkItemIndex>;
	if (index.schemaVersion !== 1 || typeof index.id !== "string" || !ID_PATTERN.test(index.id)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid schema version or id`);
	}
	if (index.kind !== "change" && index.kind !== "story") throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid kind`);
	if (typeof index.title !== "string" || !index.title.trim()) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid title`);
	if (!index.phase || !["planning", "execution", "evaluation", "complete"].includes(index.phase)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid phase`);
	}
	if (!index.state || !["active", "waiting_user", "paused", "blocked", "failed", "complete"].includes(index.state)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid state`);
	}
	if (
		!index.planning ||
		!Number.isInteger(index.planning.revision) ||
		index.planning.revision < 1 ||
		!["draft", "awaiting_approval", "approved", "stale"].includes(index.planning.status) ||
		!/^sha256:[a-f0-9]{64}$/.test(index.planning.contractDigest)
	) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid planning metadata`);
	}
	if (index.planning.status === "approved" && index.planning.approvedRevision !== index.planning.revision) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has inconsistent approval metadata`);
	}
	if (!Array.isArray(index.artifacts) || !Array.isArray(index.tasks) || !Array.isArray(index.evaluations)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid catalogs`);
	}
	if (index.integrationUnits === undefined) index.integrationUnits = [];
	if (!Array.isArray(index.integrationUnits)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid integration units`);
	const artifactIds = new Set<string>();
	for (const artifact of index.artifacts) {
		if (!artifact || typeof artifact.id !== "string" || !ID_PATTERN.test(artifact.id) || artifactIds.has(artifact.id)) {
			throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid or duplicate artifact ids`);
		}
		if (typeof artifact.path !== "string" || !artifact.path || artifact.path.startsWith("/") || artifact.path.split(/[\\/]/).includes("..")) {
			throw new HarnessError("INVALID_ARTIFACT", `${source} has an unsafe artifact path`);
		}
		artifactIds.add(artifact.id);
	}
	return index as WorkItemIndex;
}

export function parseTaskManifest(content: string, source = "task.yaml"): TaskManifest {
	const value = parse(content) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HarnessError("INVALID_ARTIFACT", `${source} must contain a mapping`);
	const task = value as Partial<TaskManifest>;
	if (task.schemaVersion !== 1 || typeof task.id !== "string" || !ID_PATTERN.test(task.id) || typeof task.title !== "string") {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid identity`);
	}
	const statuses: TaskStatus[] = [
		"draft", "blocked", "ready", "running", "contribution_complete", "reviewing", "changes_requested", "staged", "integrating", "integrated", "failed", "protocol_failed", "cancelled",
	];
	if (!task.status || !statuses.includes(task.status) || !Array.isArray(task.dependsOn)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid lifecycle fields`);
	if (!task.references || !Array.isArray(task.references.specs) || !Array.isArray(task.references.designs) || !Array.isArray(task.references.decisions)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid references`);
	}
	if (!task.execution || !task.execution.assignment || !task.assembly || !task.verification) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} is missing execution, assembly, or verification policy`);
	}
	validateId(task.assembly.integrationUnit, "Integration-unit id");
	if (!Array.isArray(task.execution.resourceClaims) || !Array.isArray(task.verification.methods) || !Array.isArray(task.verification.taskChecks)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid policy arrays`);
	}
	return task as TaskManifest;
}

async function listFilesRecursively(root: string): Promise<string[]> {
	if (!(await pathExists(root))) return [];
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await listFilesRecursively(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

export async function computeContractDigest(workItemRoot: string): Promise<string> {
	const candidates = [join(workItemRoot, "intent.md")];
	for (const directory of ["specs", "design", "decisions"]) {
		candidates.push(...(await listFilesRecursively(join(workItemRoot, directory))));
	}
	for (const path of await listFilesRecursively(join(workItemRoot, "tasks"))) {
		if (basename(path) === "acceptance.md") candidates.push(path);
	}
	const hash = createHash("sha256");
	for (const path of candidates.sort()) {
		if (!(await pathExists(path))) continue;
		hash.update(relative(workItemRoot, path));
		hash.update("\0");
		hash.update(await readFile(path));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

export class WorkItemStore {
	readonly repositoryRoot: string;
	readonly artifactRoot: string;

	constructor(repositoryRoot: string) {
		this.repositoryRoot = resolve(repositoryRoot);
		this.artifactRoot = join(this.repositoryRoot, "agent-artifacts");
	}

	workItemRoot(id: string): string {
		validateId(id, "Work-item id");
		const path = join(this.artifactRoot, id);
		ensureInside(this.artifactRoot, path);
		return path;
	}

	async list(): Promise<WorkItemIndex[]> {
		if (!(await pathExists(this.artifactRoot))) return [];
		const entries = await readdir(this.artifactRoot, { withFileTypes: true });
		const indexes: WorkItemIndex[] = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
			const path = join(this.artifactRoot, entry.name, "index.yaml");
			if (await pathExists(path)) indexes.push(parseWorkItemIndex(await readFile(path, "utf8"), path));
		}
		return indexes;
	}

	async read(id: string): Promise<WorkItemIndex> {
		const path = join(this.workItemRoot(id), "index.yaml");
		if (!(await pathExists(path))) throw new HarnessError("WORK_ITEM_NOT_FOUND", `Work item does not exist: ${id}`);
		return parseWorkItemIndex(await readFile(path, "utf8"), path);
	}

	async create(input: { id: string; title: string; kind: WorkItemKind; intent: string }): Promise<WorkItemIndex> {
		validateId(input.id, "Work-item id");
		if (!input.title.trim() || !input.intent.trim()) throw new HarnessError("INVALID_ARTIFACT", "Title and intent must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.id);
		if (await pathExists(root)) throw new HarnessError("WORK_ITEM_EXISTS", `Work item already exists: ${input.id}`);

		const temporary = join(this.artifactRoot, `.${input.id}.tmp-${randomUUID()}`);
		await mkdir(temporary, { recursive: true });
		try {
			await writeFile(join(temporary, "intent.md"), `${input.intent.trim()}\n`, "utf8");
			const digest = await computeContractDigest(temporary);
			const index: WorkItemIndex = {
				schemaVersion: 1,
				id: input.id,
				kind: input.kind,
				title: input.title.trim(),
				phase: "planning",
				state: "active",
				planning: { revision: 1, status: "draft", contractDigest: digest },
				artifacts: [{ id: "intent", type: "intent", path: "intent.md", status: "draft" }],
				tasks: [],
				integrationUnits: [],
				evaluations: [],
			};
			await writeFile(join(temporary, "index.yaml"), stringify(index), "utf8");
			await mkdir(this.artifactRoot, { recursive: true });
			await rename(temporary, root);
			try {
				await this.commit([root], `harness(${input.id}): create work item`);
			} catch (error) {
				await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, root)]).catch(() => undefined);
				await rm(root, { recursive: true, force: true });
				throw error;
			}
			return index;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async putArtifact(input: {
		workItemId: string;
		id: string;
		type: MutableArtifactType;
		content: string;
		operation?: "create" | "update" | "upsert";
	}): Promise<WorkItemIndex> {
		validateId(input.id, "Artifact id");
		if (!input.content.trim()) throw new HarnessError("INVALID_ARTIFACT", "Artifact content must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		const directory = ARTIFACT_DIRECTORIES[input.type];
		const artifactPath = join(root, directory, `${input.id}.md`);
		ensureInside(root, artifactPath);
		const relativePath = relative(root, artifactPath);
		const existing = index.artifacts.find((artifact) => artifact.id === input.id);
		if (existing && (existing.type !== input.type || existing.path !== relativePath)) {
			throw new HarnessError("INVALID_ARTIFACT", `Artifact id already belongs to ${existing.path}`);
		}
		if (input.operation === "create" && existing) throw new HarnessError("INVALID_ARTIFACT", `Artifact already exists: ${input.id}`);
		if (input.operation === "update" && !existing) throw new HarnessError("INVALID_ARTIFACT", `Artifact does not exist: ${input.id}`);
		if (!existing) {
			index.artifacts.push({ id: input.id, type: input.type, path: relativePath, status: "draft" });
		}
		index.planning.revision += 1;
		index.planning.status = index.planning.status === "approved" ? "stale" : "draft";
		delete index.planning.approvedAt;
		delete index.planning.approvedRevision;

		await mkdir(dirname(artifactPath), { recursive: true });
		const priorArtifact = await readFile(artifactPath, "utf8").catch(() => undefined);
		const indexPath = join(root, "index.yaml");
		const priorIndex = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(artifactPath, `${input.content.trim()}\n`);
			index.planning.contractDigest = await computeContractDigest(root);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([artifactPath, indexPath], `harness(${input.workItemId}): update ${input.type} ${input.id}`);
			return index;
		} catch (error) {
			await this.restore([
				{ path: artifactPath, content: priorArtifact },
				{ path: indexPath, content: priorIndex },
			]);
			throw error;
		}
	}

	async defineTask(input: { workItemId: string; manifest: TaskManifest; brief: string; acceptance: string }): Promise<WorkItemIndex> {
		validateId(input.manifest.id, "Task id");
		if (!input.brief.trim() || !input.acceptance.trim()) throw new HarnessError("INVALID_ARTIFACT", "Task brief and acceptance must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		if (index.tasks.some((task) => task.id === input.manifest.id)) throw new HarnessError("INVALID_ARTIFACT", `Task already exists: ${input.manifest.id}`);
		if (input.manifest.id !== input.manifest.id.toLowerCase()) throw new HarnessError("INVALID_ARTIFACT", "Task id must be lowercase");
		for (const dependency of input.manifest.dependsOn) {
			if (!index.tasks.some((task) => task.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task dependency: ${dependency}`);
		}
		for (const [kind, ids] of Object.entries(input.manifest.references)) {
			const expectedType = kind === "specs" ? "spec" : kind === "designs" ? "design" : "decision";
			for (const id of ids) {
				if (!index.artifacts.some((artifact) => artifact.id === id && artifact.type === expectedType)) {
					throw new HarnessError("INVALID_ARTIFACT", `Unknown ${expectedType} reference: ${id}`);
				}
			}
		}
		const taskRoot = join(root, "tasks", input.manifest.id);
		const manifestPath = join(taskRoot, "task.yaml");
		const briefPath = join(taskRoot, "brief.md");
		const acceptancePath = join(taskRoot, "acceptance.md");
		await mkdir(taskRoot, { recursive: true });
		index.tasks.push({ id: input.manifest.id, path: relative(root, manifestPath) });
		const unit = index.integrationUnits.find((item) => item.id === input.manifest.assembly.integrationUnit);
		if (unit) unit.tasks.push(input.manifest.id);
		else {
			index.integrationUnits.push({
				id: input.manifest.assembly.integrationUnit,
				tasks: [input.manifest.id],
				intermediatePolicy: input.manifest.assembly.intermediateState === "partial" ? "partial-allowed" : "coherent",
			});
		}
		index.planning.revision += 1;
		index.planning.status = index.planning.status === "approved" ? "stale" : "draft";
		delete index.planning.approvedAt;
		delete index.planning.approvedRevision;
		const indexPath = join(root, "index.yaml");
		const priorIndex = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(manifestPath, stringify(input.manifest));
			await atomicWriteFile(briefPath, `${input.brief.trim()}\n`);
			await atomicWriteFile(acceptancePath, `${input.acceptance.trim()}\n`);
			index.planning.contractDigest = await computeContractDigest(root);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([taskRoot, indexPath], `harness(${input.workItemId}): define task ${input.manifest.id}`);
			return index;
		} catch (error) {
			await rm(taskRoot, { recursive: true, force: true });
			await this.restore([{ path: indexPath, content: priorIndex }]);
			throw error;
		}
	}

	async readTask(workItemId: string, taskId: string): Promise<TaskManifest> {
		validateId(taskId, "Task id");
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		return parseTaskManifest(await readFile(join(root, catalog.path), "utf8"), catalog.path);
	}

	async updateTask(
		workItemId: string,
		taskId: string,
		update: { status?: TaskStatus; runtime?: TaskManifest["runtime"] },
	): Promise<TaskManifest> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		const path = join(root, catalog.path);
		const previous = await readFile(path, "utf8");
		const manifest = parseTaskManifest(previous, path);
		if (update.status) manifest.status = update.status;
		if (update.runtime) manifest.runtime = { ...manifest.runtime, ...update.runtime };
		try {
			await atomicWriteFile(path, stringify(manifest));
			await this.commit([path], `harness(${workItemId}): update task ${taskId}`);
			return manifest;
		} catch (error) {
			await this.restore([{ path, content: previous }]);
			throw error;
		}
	}

	async defineEvaluation(workItemId: string, manifest: EvaluationManifest, report = "# Evaluation\n\nPending.\n"): Promise<WorkItemIndex> {
		validateId(manifest.id, "Evaluation id");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		if (index.evaluations.some((item) => item.id === manifest.id)) throw new HarnessError("INVALID_ARTIFACT", `Evaluation already exists: ${manifest.id}`);
		const evaluationRoot = join(root, "evaluations", manifest.id);
		const manifestPath = join(evaluationRoot, "evaluation.yaml");
		const indexPath = join(root, "index.yaml");
		const priorIndex = await readFile(indexPath, "utf8");
		index.evaluations.push({ id: manifest.id, path: relative(root, manifestPath) });
		try {
			await mkdir(evaluationRoot, { recursive: true });
			await atomicWriteFile(manifestPath, stringify(manifest));
			await atomicWriteFile(join(evaluationRoot, "report.md"), report);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([evaluationRoot, indexPath], `harness(${workItemId}): define evaluation ${manifest.id}`);
			return index;
		} catch (error) {
			await rm(evaluationRoot, { recursive: true, force: true });
			await this.restore([{ path: indexPath, content: priorIndex }]);
			throw error;
		}
	}

	async readEvaluation(workItemId: string, evaluationId: string): Promise<EvaluationManifest> {
		validateId(evaluationId, "Evaluation id");
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const catalog = index.evaluations.find((evaluation) => evaluation.id === evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${evaluationId}`);
		const value = parse(await readFile(join(root, catalog.path), "utf8")) as EvaluationManifest;
		if (value.schemaVersion !== 1 || value.id !== evaluationId) throw new HarnessError("INVALID_ARTIFACT", `Invalid evaluation manifest: ${evaluationId}`);
		return value;
	}

	async recordEvaluation(input: {
		workItemId: string;
		evaluationId: string;
		verdict: "pass" | "fail" | "blocked" | "not_applicable";
		report: string;
		evidence: Array<{ command?: string; result: string; path?: string; description?: string }>;
	}): Promise<EvaluationManifest> {
		if (!input.report.trim()) throw new HarnessError("INVALID_ARTIFACT", "Evaluation report must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		const catalog = index.evaluations.find((evaluation) => evaluation.id === input.evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${input.evaluationId}`);
		const evaluationPath = join(root, catalog.path);
		const evaluationRoot = dirname(evaluationPath);
		const reportPath = join(evaluationRoot, "report.md");
		const evidenceRoot = join(root, "evidence", input.evaluationId);
		const manifestPath = join(evidenceRoot, "manifest.yaml");
		const previousEvaluation = await readFile(evaluationPath, "utf8");
		const previousReport = await readFile(reportPath, "utf8").catch(() => undefined);
		const evaluation = parse(previousEvaluation) as EvaluationManifest;
		const evidenceEntries: Array<Record<string, unknown>> = [];
		await mkdir(join(evidenceRoot, "files"), { recursive: true });
		try {
			for (let indexValue = 0; indexValue < input.evidence.length; indexValue++) {
				const evidence = input.evidence[indexValue];
				if (!evidence) continue;
				const entry: Record<string, unknown> = { result: evidence.result };
				if (evidence.command) entry.command = evidence.command;
				if (evidence.description) entry.description = evidence.description;
				if (evidence.path) {
					const source = resolve(this.repositoryRoot, evidence.path);
					const info = await stat(source).catch(() => undefined);
					if (!info?.isFile()) throw new HarnessError("INVALID_ARTIFACT", `Evidence file does not exist: ${evidence.path}`);
					const destination = join(evidenceRoot, "files", `${indexValue + 1}-${basename(source)}`);
					await copyFile(source, destination);
					entry.path = relative(evidenceRoot, destination);
					entry.checksum = `sha256:${createHash("sha256").update(await readFile(destination)).digest("hex")}`;
				}
				evidenceEntries.push(entry);
			}
			const status = input.verdict === "pass" ? "passed" : input.verdict === "fail" ? "failed" : input.verdict;
			evaluation.status = status;
			evaluation.attempt += 1;
			evaluation.result = {
				verdict: input.verdict,
				report: "report.md",
				evidence: `../../evidence/${input.evaluationId}/manifest.yaml`,
			};
			await atomicWriteFile(reportPath, `${input.report.trim()}\n`);
			await atomicWriteFile(evaluationPath, stringify(evaluation));
			await atomicWriteFile(manifestPath, stringify({ schemaVersion: 1, evaluation: input.evaluationId, recordedAt: new Date().toISOString(), entries: evidenceEntries }));
			await this.commit([evaluationRoot, evidenceRoot], `harness(${input.workItemId}): record evaluation ${input.evaluationId}`);
			return evaluation;
		} catch (error) {
			await atomicWriteFile(evaluationPath, previousEvaluation);
			if (previousReport === undefined) await rm(reportPath, { force: true });
			else await atomicWriteFile(reportPath, previousReport);
			await rm(evidenceRoot, { recursive: true, force: true });
			await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, evaluationRoot), relative(this.repositoryRoot, evidenceRoot)]).catch(() => undefined);
			throw error;
		}
	}

	async completeWorkItem(workItemId: string, outcome: string): Promise<WorkItemIndex> {
		if (!outcome.trim()) throw new HarnessError("INVALID_ARTIFACT", "Outcome must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		if (index.planning.status !== "approved" || index.planning.approvedRevision !== index.planning.revision) {
			throw new HarnessError("STALE_PLANNING_REVISION", "Completion requires the current approved contract");
		}
		for (const task of index.tasks) {
			if ((await this.readTask(workItemId, task.id)).status !== "integrated") {
				throw new HarnessError("INVALID_HANDOFF", `Task is not integrated: ${task.id}`);
			}
		}
		for (const evaluation of index.evaluations) {
			const manifest = await this.readEvaluation(workItemId, evaluation.id);
			if (manifest.required && manifest.status !== "passed" && manifest.status !== "not_applicable") {
				throw new HarnessError("INVALID_HANDOFF", `Required evaluation has not passed: ${evaluation.id}`);
			}
		}
		const indexPath = join(root, "index.yaml");
		const outcomePath = join(root, "outcome.md");
		const previousIndex = await readFile(indexPath, "utf8");
		const previousOutcome = await readFile(outcomePath, "utf8").catch(() => undefined);
		index.phase = "complete";
		index.state = "complete";
		if (!index.artifacts.some((artifact) => artifact.id === "outcome")) {
			index.artifacts.push({ id: "outcome", type: "outcome", path: "outcome.md", status: "complete" });
		}
		try {
			await atomicWriteFile(outcomePath, `${outcome.trim()}\n`);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([outcomePath, indexPath], `harness(${workItemId}): complete work item`);
			return index;
		} catch (error) {
			await atomicWriteFile(indexPath, previousIndex);
			if (previousOutcome === undefined) await rm(outcomePath, { force: true });
			else await atomicWriteFile(outcomePath, previousOutcome);
			await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, indexPath), relative(this.repositoryRoot, outcomePath)]).catch(() => undefined);
			throw error;
		}
	}

	async submitPlanning(id: string): Promise<WorkItemIndex> {
		return this.updatePlanning(id, "submit");
	}

	async approve(id: string): Promise<WorkItemIndex> {
		return this.updatePlanning(id, "approve");
	}

	private async updatePlanning(id: string, operation: "submit" | "approve"): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(id);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8").catch(() => {
			throw new HarnessError("WORK_ITEM_NOT_FOUND", `Work item does not exist: ${id}`);
		});
		const index = parseWorkItemIndex(previous, indexPath);
		const digest = await computeContractDigest(root);
		if (operation === "submit") {
			if (index.planning.status === "approved") return index;
			index.planning.status = "awaiting_approval";
			index.state = "waiting_user";
			index.planning.contractDigest = digest;
		} else {
			if (index.planning.status !== "awaiting_approval") {
				throw new HarnessError("STALE_PLANNING_REVISION", `Work item ${id} is not awaiting approval`);
			}
			if (digest !== index.planning.contractDigest) {
				throw new HarnessError("STALE_PLANNING_REVISION", `Work item ${id} changed after planning submission`);
			}
			index.planning.status = "approved";
			index.planning.approvedRevision = index.planning.revision;
			index.planning.approvedAt = new Date().toISOString();
			index.state = "active";
			for (const artifact of index.artifacts) artifact.status = artifact.status === "draft" ? "approved" : artifact.status;
		}
		try {
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([indexPath], `harness(${id}): ${operation === "approve" ? "approve planning" : "submit planning"}`);
			return index;
		} catch (error) {
			await this.restore([{ path: indexPath, content: previous }]);
			throw error;
		}
	}

	private async commit(paths: string[], message: string): Promise<void> {
		const relativePaths = paths.map((path) => relative(this.repositoryRoot, path));
		await runGit(this.repositoryRoot, ["add", "--", ...relativePaths]);
		await runGit(this.repositoryRoot, ["commit", "-m", message, "--", ...relativePaths]);
	}

	private async restore(files: Array<{ path: string; content: string | undefined }>): Promise<void> {
		for (const file of files) {
			if (file.content === undefined) await rm(file.path, { force: true });
			else await atomicWriteFile(file.path, file.content);
		}
		await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", ...files.map((file) => relative(this.repositoryRoot, file.path))]).catch(
			() => undefined,
		);
		for (const directory of new Set(files.map((file) => dirname(file.path)))) {
			if (basename(directory) !== basename(this.artifactRoot)) await rm(directory, { recursive: false }).catch(() => undefined);
		}
	}
}
