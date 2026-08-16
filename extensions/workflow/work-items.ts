import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { acceptanceCriterionIds, renderArtifact, renderEvaluationReport, renderOutcome, type SemanticSections } from "./artifact-contracts.js";
import { HarnessError } from "./errors.js";
import { validateExecutionTopology } from "./execution-topology.js";
import { RepositoryMutex } from "./idempotency.js";
import { assertCleanRepository, atomicWriteFile, runGit } from "./repository.js";
import { isTierTaskAssignment, type DeliveryBranchMode, type DeliveryBranchType, type EvaluationManifest, type MutationAuthority, type TaskManifest, type TaskStatus, type WorkItemDelivery, type WorkItemIndex, type WorkItemKind } from "./types.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_DIRECTORIES = { spec: "specs", design: "design", decision: "decisions", "e2e-matrix": "e2e-matrix" } as const;
export type MutableArtifactType = keyof typeof ARTIFACT_DIRECTORIES;

function collectQualifiedCriteria(value: unknown, found = new Set<string>()): string[] {
	if (typeof value === "string") {
		for (const match of value.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)*)#(AC-\d{3})\b/g)) found.add(`${match[1]}#${match[2]}`);
	} else if (Array.isArray(value)) value.forEach((entry) => collectQualifiedCriteria(entry, found));
	else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectQualifiedCriteria(entry, found));
	return [...found];
}

function assertContractMutable(index: WorkItemIndex): void {
	if (index.finalization?.locked || index.phase === "complete") throw new HarnessError("CAPABILITY_DENIED", `Work item ${index.id} is finalized; reopen it before mutation`);
}

function advanceContractRevision(index: WorkItemIndex, _authority?: MutationAuthority): void {
	index.planning.revision += 1;
}

function validateId(id: string, label: string): void {
	if (!ID_PATTERN.test(id)) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a kebab-case identifier`);
}

function validateDelivery(delivery: WorkItemDelivery): void {
	if (delivery.baseBranch !== "develop") throw new HarnessError("INVALID_ARTIFACT", "New delivery contracts must use develop as baseBranch");
	if (!delivery.branchType || !(["feature", "fix"] as DeliveryBranchType[]).includes(delivery.branchType)) throw new HarnessError("INVALID_ARTIFACT", "Delivery branchType must be feature or fix");
	if (!delivery.branchMode || !(["create", "continue"] as DeliveryBranchMode[]).includes(delivery.branchMode)) throw new HarnessError("INVALID_ARTIFACT", "Delivery branchMode must be create or continue");
	if (delivery.branchMode === "continue" && !delivery.featureBranch?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Continued delivery requires featureBranch");
	if (delivery.featureBranch && !new RegExp(`^${delivery.branchType}/[a-z0-9]+(?:-[a-z0-9]+)*$`).test(delivery.featureBranch)) throw new HarnessError("INVALID_ARTIFACT", `Delivery branch must match ${delivery.branchType}/<kebab-case-name>`);
}

function ensureInside(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
		throw new HarnessError("INVALID_ARTIFACT", `Path escapes its managed root: ${path}`);
	}
}

const SENSITIVE_EVIDENCE_NAME = /(^|[._-])(env|credentials?|secrets?|private|token|password|passwd|api[-_]?key|transcript|session)([._-]|$)|\.(pem|key|p12|pfx)$/i;
const SENSITIVE_EVIDENCE_CONTENT = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]+)/i;

async function validateEvidenceSource(repositoryRoot: string, source: string): Promise<string> {
	const lexical = resolve(repositoryRoot, source);
	const absolute = await realpath(lexical).catch(() => undefined);
	if (!absolute) throw new HarnessError("INVALID_ARTIFACT", `Evidence file does not exist: ${source}`);
	const allowedRoots = await Promise.all([repositoryRoot, tmpdir()].map((root) => realpath(root).catch(() => resolve(root))));
	if (!allowedRoots.some((root) => absolute !== root && absolute.startsWith(`${root}${sep}`))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source resolves outside the repository or operating-system temporary directory: ${source}`);
	if (SENSITIVE_EVIDENCE_NAME.test(basename(absolute)) || SENSITIVE_EVIDENCE_NAME.test(basename(lexical))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source looks sensitive: ${source}. Provide a sanitized minimal artifact instead.`);
	const content = await readFile(absolute);
	// Fail closed only on obvious credential/private-transcript indicators. PiBox does
	// not claim to redact arbitrary secrets; callers must curate minimal evidence.
	if (SENSITIVE_EVIDENCE_CONTENT.test(content.subarray(0, 128 * 1024).toString("utf8"))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source contains an obvious credential or private material: ${source}. Supply sanitized minimal evidence.`);
	return absolute;
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
	if (!index.state || !["active", "waiting_user", "paused", "postponed", "blocked", "failed", "complete", "archived"].includes(index.state)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid state`);
	}
	if (!index.planning || !Number.isInteger(index.planning.revision) || index.planning.revision < 1) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid planning metadata`);
	}
	// Approval metadata was removed as an execution gate. Strip legacy fields
	// when an older work item is next persisted.
	const legacyPlanning = index.planning as unknown as Record<string, unknown>;
	for (const key of ["status", "approvedRevision", "approvedAt", "contractDigest", "approvalAmendments"]) delete legacyPlanning[key];
	if (!Array.isArray(index.artifacts) || !Array.isArray(index.tasks) || !Array.isArray(index.evaluations)) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid catalogs`);
	}
	if (index.delivery !== undefined) {
		const typedDelivery = index.delivery.branchType !== undefined || index.delivery.branchMode !== undefined;
		if (typedDelivery && (!index.delivery.branchType || !index.delivery.branchMode)) throw new HarnessError("INVALID_ARTIFACT", `${source} delivery branchType and branchMode must be declared together`);
		if (typedDelivery && index.delivery.baseBranch !== "develop") throw new HarnessError("INVALID_ARTIFACT", `${source} delivery must use develop as its base branch`);
		if (index.delivery.branchType !== undefined && !["feature", "fix"].includes(index.delivery.branchType)) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid delivery branch type`);
		if (index.delivery.branchMode !== undefined && !["create", "continue"].includes(index.delivery.branchMode)) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid delivery branch mode`);
		if (index.delivery.featureBranch !== undefined && (typeof index.delivery.featureBranch !== "string" || !index.delivery.featureBranch.trim())) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid delivery branch`);
		if (index.delivery.branchMode === "continue" && !index.delivery.featureBranch) throw new HarnessError("INVALID_ARTIFACT", `${source} continued delivery requires an explicit featureBranch`);
		if (!typedDelivery && !index.delivery.featureBranch) throw new HarnessError("INVALID_ARTIFACT", `${source} legacy delivery requires a recorded featureBranch`);
	}
	if (index.integrationUnits === undefined) index.integrationUnits = [];
	if (!Array.isArray(index.integrationUnits)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid integration units`);
	// Do not materialize the compatibility projection in memory: a read of a
	// schema-v1 artifact must not cause its canonical index to be rewritten.
	if (index.executionStages !== undefined && !Array.isArray(index.executionStages)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid execution stages`);
	const scheduled = new Set<string>();
	for (const stage of index.executionStages ?? []) {
		if (!stage || typeof stage.id !== "string" || !ID_PATTERN.test(stage.id) || !Array.isArray(stage.tasks) || (!stage.tasks.length && !stage.nodes?.length) || stage.tasks.some((id) => typeof id !== "string" || scheduled.has(id))) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid or duplicate execution-stage tasks`);
		stage.tasks.forEach((id) => scheduled.add(id));
		if (stage.nodes !== undefined && (!Array.isArray(stage.nodes) || stage.nodes.some((node) => !node || !["task", "evaluation"].includes(node.kind) || typeof node.id !== "string"))) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid staged nodes`);
	}
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

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	draft: ["blocked", "ready", "cancelled"],
	blocked: ["ready", "cancelled"],
	ready: ["blocked", "running", "cancelled"],
	running: ["blocked", "paused", "ready", "contribution_complete", "failed", "protocol_failed", "cancelled"],
	paused: ["blocked", "ready", "running", "cancelled"],
	contribution_complete: ["reviewing", "accepted", "merge_queued", "merged", "staged", "integrating", "integrated", "changes_requested"],
	reviewing: ["changes_requested", "accepted", "merge_queued", "merged", "staged", "integrating", "integrated"],
	changes_requested: ["running", "cancelled"],
	accepted: ["merge_queued", "merged", "changes_requested"],
	merge_queued: ["merging", "changes_requested"],
	merging: ["merged", "changes_requested", "failed"],
	merged: [],
	staged: ["integrating", "integrated", "changes_requested"],
	integrating: ["integrated", "changes_requested", "failed"],
	integrated: [],
	failed: ["blocked", "ready", "running", "cancelled"],
	protocol_failed: ["blocked", "ready", "running", "cancelled"],
	cancelled: ["blocked", "ready"],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
	return from === to || TASK_TRANSITIONS[from].includes(to);
}

export function parseTaskManifest(content: string, source = "task.yaml"): TaskManifest {
	const value = parse(content) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HarnessError("INVALID_ARTIFACT", `${source} must contain a mapping`);
	const task = value as Partial<TaskManifest>;
	if (task.schemaVersion !== 1 || typeof task.id !== "string" || !ID_PATTERN.test(task.id) || typeof task.title !== "string") {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid identity`);
	}
	const statuses: TaskStatus[] = [
		"draft", "blocked", "ready", "running", "paused", "contribution_complete", "reviewing", "changes_requested", "accepted", "merge_queued", "merging", "merged", "staged", "integrating", "integrated", "failed", "protocol_failed", "cancelled",
	];
	if (!task.status || !statuses.includes(task.status) || !Array.isArray(task.dependsOn)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid lifecycle fields`);
	if (task.references && (!Array.isArray(task.references.specs) || !Array.isArray(task.references.designs) || !Array.isArray(task.references.decisions))) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid legacy references`);
	}
	if (!task.execution || !task.execution.assignment || !task.assembly || !task.verification) {
		throw new HarnessError("INVALID_ARTIFACT", `${source} is missing execution, assembly, or verification policy`);
	}
	const stageId = task.assembly.stageId ?? task.assembly.integrationUnit;
	if (!stageId) throw new HarnessError("INVALID_ARTIFACT", `${source} is missing an execution stage`);
	validateId(stageId, "Execution-stage id");
	task.assembly.stageId = stageId;
	if (!Array.isArray(task.execution.resourceClaims) || !Array.isArray(task.verification.methods) || !Array.isArray(task.verification.taskChecks)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid policy arrays`);
	if (task.execution.isolation !== undefined && !["worktree", "repository"].includes(task.execution.isolation)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid legacy execution isolation`);
	if (task.execution.parallelism !== undefined && !["allowed", "serial"].includes(task.execution.parallelism)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid legacy execution parallelism`);
	const assignment = task.execution.assignment as TaskManifest["execution"]["assignment"];
	const agent = "agent" in assignment ? assignment.agent : assignment.role;
	if (typeof agent !== "string" || typeof assignment.rationale !== "string" || !assignment.rationale.trim()) throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid assignment`);
	if (isTierTaskAssignment(assignment)) {
		if (!["low", "medium", "high", "max"].includes(assignment.tier)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid tier routing`);
	} else if (typeof assignment.model !== "string" || typeof assignment.effort !== "string" || typeof assignment.minimumCapabilityRank !== "number" || typeof assignment.allowFallback !== "boolean") {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid legacy model assignment`);
	}
	return task as TaskManifest;
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

	async create(input: { id: string; title: string; kind: WorkItemKind; delivery?: WorkItemDelivery; intent?: string; intentSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2 }): Promise<WorkItemIndex> {
		validateId(input.id, "Work-item id");
		const narrativeSchemaVersion = input.narrativeSchemaVersion ?? 1;
		const intent = narrativeSchemaVersion === 2
			? (() => {
				if (!input.intentSections) throw new HarnessError("INVALID_ARTIFACT", "schema-v2 work item requires intentSections");
				if (input.intent !== undefined) throw new HarnessError("INVALID_ARTIFACT", "schema-v2 work item does not accept raw intent Markdown");
				return renderArtifact("intent", `Intent: ${input.title}`, input.intentSections);
			})()
			: input.intent;
		if (!input.title.trim() || !intent?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Title and intent must not be empty");
		if (input.delivery) validateDelivery(input.delivery);
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.id);
		if (await pathExists(root)) throw new HarnessError("WORK_ITEM_EXISTS", `Work item already exists: ${input.id}`);

		const temporary = join(this.artifactRoot, `.${input.id}.tmp-${randomUUID()}`);
		await mkdir(temporary, { recursive: true });
		try {
			await writeFile(join(temporary, "intent.md"), `${intent.trim()}\n`, "utf8");
			const index: WorkItemIndex = {
				schemaVersion: 1,
				id: input.id,
				kind: input.kind,
				title: input.title.trim(),
				phase: "planning",
				state: "active",
				planning: { revision: 1 },
				artifacts: [{ id: "intent", type: "intent", path: "intent.md", status: "draft", narrativeSchemaVersion }],
				tasks: [],
				integrationUnits: [],
				...(input.delivery ? { delivery: input.delivery } : {}),
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

	async reviseWorkItem(input: { workItemId: string; title?: string; kind?: WorkItemKind; delivery?: WorkItemDelivery; intent?: string; intentSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority: MutationAuthority }): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		assertContractMutable(index);
		const indexPath = join(root, "index.yaml");
		const intentPath = join(root, "intent.md");
		const previousIndex = await readFile(indexPath, "utf8");
		const previousIntent = await readFile(intentPath, "utf8");
		if (input.title !== undefined) {
			if (!input.title.trim()) throw new HarnessError("INVALID_ARTIFACT", "Work-item title must not be empty");
			index.title = input.title.trim();
		}
		if (input.kind !== undefined) index.kind = input.kind;
		if (input.delivery !== undefined) { validateDelivery(input.delivery); index.delivery = input.delivery; }
		if (input.intent !== undefined || input.intentSections !== undefined) {
			const version = input.narrativeSchemaVersion ?? index.artifacts.find((artifact) => artifact.id === "intent")?.narrativeSchemaVersion ?? 1;
			const content = version === 2 ? renderArtifact("intent", `Intent: ${index.title}`, input.intentSections ?? {}) : input.intent;
			if (!content?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Intent must not be empty");
			await atomicWriteFile(intentPath, `${content.trim()}\n`);
			const intent = index.artifacts.find((artifact) => artifact.id === "intent");
			if (intent) intent.narrativeSchemaVersion = version;
		}
		advanceContractRevision(index, input.authority);
		try {
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([intentPath, indexPath], `harness(${input.workItemId}): revise work item`);
			return index;
		} catch (error) {
			await this.restore([{ path: intentPath, content: previousIntent }, { path: indexPath, content: previousIndex }]);
			throw error;
		}
	}

	async putArtifact(input: {
		workItemId: string;
		id: string;
		type: MutableArtifactType;
		content?: string;
		renderedContent?: string;
		sections?: SemanticSections;
		title?: string;
		narrativeSchemaVersion?: 1 | 2;
		operation?: "create" | "update" | "upsert";
		authority?: MutationAuthority;
	}): Promise<WorkItemIndex> {
		validateId(input.id, "Artifact id");
		const narrativeSchemaVersion = input.narrativeSchemaVersion ?? 1;
		if (input.type === "e2e-matrix" && (narrativeSchemaVersion !== 2 || input.renderedContent !== undefined || input.content !== undefined)) throw new HarnessError("INVALID_ARTIFACT", "e2e-matrix artifacts require validated schema-v2 sections");
		const content = input.renderedContent ?? (narrativeSchemaVersion === 2
			? (() => {
				if (!input.sections) throw new HarnessError("INVALID_ARTIFACT", `${input.type} schema-v2 mutation requires semantic sections`);
				if (input.content !== undefined) throw new HarnessError("INVALID_ARTIFACT", `${input.type} schema-v2 mutation does not accept raw Markdown content`);
				if (input.type === "spec") acceptanceCriterionIds(input.sections);
				return renderArtifact(input.type, input.title ?? input.id, input.sections);
			})()
			: input.content);
		if (!content?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Artifact content must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		assertContractMutable(index);
		const directory = ARTIFACT_DIRECTORIES[input.type];
		const artifactPath = join(root, directory, `${input.id}.md`);
		ensureInside(root, artifactPath);
		const relativePath = relative(root, artifactPath);
		const existing = index.artifacts.find((artifact) => artifact.id === input.id);
		if (input.type === "e2e-matrix" && existing && (index.tasks.length > 0 || index.evaluations.length > 0)) throw new HarnessError("CAPABILITY_DENIED", "The approved e2e-matrix is immutable after delivery planning begins; return to story shaping before changing it");
		const existingMatrix = index.artifacts.find((artifact) => artifact.type === "e2e-matrix" && artifact.id !== input.id);
		if (input.type === "e2e-matrix" && existingMatrix) throw new HarnessError("INVALID_ARTIFACT", `Work item already has an e2e-matrix artifact: ${existingMatrix.id}`);
		if (existing && (existing.type !== input.type || existing.path !== relativePath)) {
			throw new HarnessError("INVALID_ARTIFACT", `Artifact id already belongs to ${existing.path}`);
		}
		if (input.operation === "create" && existing) throw new HarnessError("INVALID_ARTIFACT", `Artifact already exists: ${input.id}`);
		if (input.operation === "update" && !existing) throw new HarnessError("INVALID_ARTIFACT", `Artifact does not exist: ${input.id}`);
		if (!existing) {
			index.artifacts.push({ id: input.id, type: input.type, path: relativePath, status: input.type === "e2e-matrix" ? "approved" : "draft", narrativeSchemaVersion });
		} else if (existing.narrativeSchemaVersion !== narrativeSchemaVersion) {
			existing.narrativeSchemaVersion = narrativeSchemaVersion;
		}
		advanceContractRevision(index, input.authority);

		await mkdir(dirname(artifactPath), { recursive: true });
		const priorArtifact = await readFile(artifactPath, "utf8").catch(() => undefined);
		const indexPath = join(root, "index.yaml");
		const priorIndex = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(artifactPath, `${content.trim()}\n`);
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

	async removeArtifact(workItemId: string, artifactId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		if (artifactId === "intent" || artifactId === "outcome") throw new HarnessError("CAPABILITY_DENIED", `Artifact ${artifactId} cannot be deleted`);
		const artifact = index.artifacts.find((candidate) => candidate.id === artifactId);
		if (artifact?.type === "e2e-matrix" && (index.tasks.length > 0 || index.evaluations.length > 0)) throw new HarnessError("CAPABILITY_DENIED", "The approved e2e-matrix is immutable after delivery planning begins; return to story shaping before removing it");
		if (!artifact) throw new HarnessError("INVALID_ARTIFACT", `Unknown artifact: ${artifactId}`);
		for (const task of index.tasks) {
			const manifest = await this.readTask(workItemId, task.id);
			if (manifest.references && [...manifest.references.specs, ...manifest.references.designs, ...manifest.references.decisions].includes(artifactId)) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} still references ${artifactId}`);
		}
		for (const candidate of index.artifacts) if (candidate.links?.includes(artifactId)) throw new HarnessError("INVALID_ARTIFACT", `Artifact ${candidate.id} still links to ${artifactId}`);
		const path = join(root, artifact.path);
		const indexPath = join(root, "index.yaml");
		const previousIndex = await readFile(indexPath, "utf8");
		const previousArtifact = await readFile(path, "utf8");
		index.artifacts = index.artifacts.filter((candidate) => candidate.id !== artifactId);
		advanceContractRevision(index, authority);
		try {
			await rm(path);
			await atomicWriteFile(indexPath, stringify(index));
			await runGit(this.repositoryRoot, ["add", "-A", "--", relative(this.repositoryRoot, path), relative(this.repositoryRoot, indexPath)]);
			await runGit(this.repositoryRoot, ["commit", "-m", `harness(${workItemId}): remove artifact ${artifactId}`, "--", relative(this.repositoryRoot, path), relative(this.repositoryRoot, indexPath)]);
			return index;
		} catch (error) {
			await this.restore([{ path, content: previousArtifact }, { path: indexPath, content: previousIndex }]);
			throw error;
		}
	}

	async linkArtifact(workItemId: string, artifactId: string, links: string[], authority?: MutationAuthority, replace = false): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		const artifact = index.artifacts.find((candidate) => candidate.id === artifactId);
		if (!artifact) throw new HarnessError("INVALID_ARTIFACT", `Unknown artifact: ${artifactId}`);
		for (const link of links) {
			if (!index.artifacts.some((candidate) => candidate.id === link)) throw new HarnessError("INVALID_ARTIFACT", `Unknown linked artifact: ${link}`);
		}
		artifact.links = [...new Set(replace ? links : [...(artifact.links ?? []), ...links])].sort();
		advanceContractRevision(index, authority);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([indexPath], `harness(${workItemId}): link artifact ${artifactId}`);
			return index;
		} catch (error) {
			await this.restore([{ path: indexPath, content: previous }]);
			throw error;
		}
	}

	async reconcile(workItemId: string): Promise<WorkItemIndex> {
		return this.read(workItemId);
	}

	async defineTask(input: { workItemId: string; manifest: TaskManifest; brief?: string; acceptance?: string; briefSections?: SemanticSections; acceptanceSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority?: MutationAuthority }): Promise<WorkItemIndex> {
		validateId(input.manifest.id, "Task id");
		const narrativeSchemaVersion = input.narrativeSchemaVersion ?? 1;
		if (narrativeSchemaVersion === 2 && input.manifest.assembly.intermediateState === "partial" && !input.acceptanceSections?.expectedIntermediateState) {
			throw new HarnessError("INVALID_ARTIFACT", "Partial task acceptance requires expectedIntermediateState");
		}
		if (narrativeSchemaVersion === 2 && input.manifest.dependsOn.length > 0 && !input.briefSections?.interfacesAndDependencies) {
			throw new HarnessError("INVALID_ARTIFACT", "Task dependencies or resource claims require interfacesAndDependencies");
		}
		const brief = narrativeSchemaVersion === 2
			? renderArtifact("taskBrief", `Task Brief: ${input.manifest.title}`, input.briefSections ?? {})
			: input.brief;
		const acceptance = narrativeSchemaVersion === 2
			? renderArtifact("taskAcceptance", `Task Acceptance: ${input.manifest.title}`, input.acceptanceSections ?? {})
			: input.acceptance;
		if (!brief?.trim() || !acceptance?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Task brief and acceptance must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		assertContractMutable(index);
		if (index.tasks.some((task) => task.id === input.manifest.id)) throw new HarnessError("INVALID_ARTIFACT", `Task already exists: ${input.manifest.id}`);
		if (input.manifest.id !== input.manifest.id.toLowerCase()) throw new HarnessError("INVALID_ARTIFACT", "Task id must be lowercase");
		for (const dependency of input.manifest.dependsOn) {
			if (!index.tasks.some((task) => task.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task dependency: ${dependency}`);
		}
		for (const [kind, ids] of Object.entries(input.manifest.references ?? {})) {
			const expectedType = kind === "specs" ? "spec" : kind === "designs" ? "design" : "decision";
			for (const id of ids) {
				if (!index.artifacts.some((artifact) => artifact.id === id && artifact.type === expectedType)) {
					throw new HarnessError("INVALID_ARTIFACT", `Unknown ${expectedType} reference: ${id}`);
				}
			}
		}
		if (narrativeSchemaVersion === 2) await this.validateCriterionReferences(index, collectQualifiedCriteria(input.acceptanceSections));
		const taskRoot = join(root, "tasks", input.manifest.id);
		const manifestPath = join(taskRoot, "task.yaml");
		const briefPath = join(taskRoot, "brief.md");
		const acceptancePath = join(taskRoot, "acceptance.md");
		await mkdir(taskRoot, { recursive: true });
		index.tasks.push({ id: input.manifest.id, path: relative(root, manifestPath) });
		index.executionStages ??= index.integrationUnits.map((unit) => ({ id: unit.id, tasks: [...unit.tasks] }));
		const stageId = input.manifest.assembly.stageId ?? input.manifest.assembly.integrationUnit!;
		const stage = index.executionStages!.find((item) => item.id === stageId);
		if (stage) stage.tasks.push(input.manifest.id);
		else index.executionStages!.push({ id: stageId, tasks: [input.manifest.id] });
		advanceContractRevision(index, input.authority);
		const indexPath = join(root, "index.yaml");
		const priorIndex = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(manifestPath, stringify(input.manifest));
			await atomicWriteFile(briefPath, `${brief.trim()}\n`);
			await atomicWriteFile(acceptancePath, `${acceptance.trim()}\n`);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([taskRoot, indexPath], `harness(${input.workItemId}): define task ${input.manifest.id}`);
			return index;
		} catch (error) {
			await rm(taskRoot, { recursive: true, force: true });
			await this.restore([{ path: indexPath, content: priorIndex }]);
			throw error;
		}
	}

	async reviseTask(input: { workItemId: string; manifest: TaskManifest; brief?: string; acceptance?: string; briefSections?: SemanticSections; acceptanceSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority: MutationAuthority }): Promise<WorkItemIndex> {
		validateId(input.manifest.id, "Task id");
		const narrativeSchemaVersion = input.narrativeSchemaVersion ?? 1;
		const brief = narrativeSchemaVersion === 2 && input.briefSections !== undefined ? renderArtifact("taskBrief", `Task Brief: ${input.manifest.title}`, input.briefSections) : input.brief;
		const acceptance = narrativeSchemaVersion === 2 && input.acceptanceSections !== undefined ? renderArtifact("taskAcceptance", `Task Acceptance: ${input.manifest.title}`, input.acceptanceSections) : input.acceptance;
		if (!brief?.trim() || !acceptance?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Task brief and acceptance must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		assertContractMutable(index);
		const catalog = index.tasks.find((task) => task.id === input.manifest.id);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Task does not exist: ${input.manifest.id}`);
		for (const dependency of input.manifest.dependsOn) if (!index.tasks.some((task) => task.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task dependency: ${dependency}`);
		for (const [kind, ids] of Object.entries(input.manifest.references ?? {})) {
			const expectedType = kind === "specs" ? "spec" : kind === "designs" ? "design" : "decision";
			for (const id of ids) if (!index.artifacts.some((artifact) => artifact.id === id && artifact.type === expectedType)) throw new HarnessError("INVALID_ARTIFACT", `Unknown ${expectedType} reference: ${id}`);
		}
		if (narrativeSchemaVersion === 2) await this.validateCriterionReferences(index, collectQualifiedCriteria(input.acceptanceSections));
		index.executionStages ??= index.integrationUnits.map((unit) => ({ id: unit.id, tasks: [...unit.tasks] }));
		const taskRoot = dirname(join(root, catalog.path));
		const manifestPath = join(taskRoot, "task.yaml");
		const briefPath = join(taskRoot, "brief.md");
		const acceptancePath = join(taskRoot, "acceptance.md");
		const indexPath = join(root, "index.yaml");
		const previous = await Promise.all([manifestPath, briefPath, acceptancePath, indexPath].map((path) => readFile(path, "utf8")));
		const current = parseTaskManifest(previous[0]!, manifestPath);
		const revised: TaskManifest = { ...input.manifest, status: current.status, ...(current.runtime ? { runtime: current.runtime } : {}) };
		const stageId = revised.assembly.stageId ?? revised.assembly.integrationUnit!;
		// Build and validate the complete candidate graph before changing the in-memory
		// index. In particular, a singleton task must not be removed/re-added: that
		// used to move its stage (and therefore execution order) on every revision.
		const nextStages = index.executionStages!.map((stage) => ({ ...stage, tasks: [...stage.tasks] }));
		const currentStage = nextStages.find((stage) => stage.tasks.includes(revised.id));
		if (currentStage?.id !== stageId) {
			for (const stage of nextStages) stage.tasks = stage.tasks.filter((id) => id !== revised.id);
			const target = nextStages.find((stage) => stage.id === stageId);
			if (target) target.tasks.push(revised.id);
			else nextStages.push({ id: stageId, tasks: [revised.id] });
		}
		const candidateStages = nextStages.filter((stage) => stage.tasks.length > 0);
		const candidate = { ...index, executionStages: candidateStages };
		const candidateTasks = await Promise.all(index.tasks.map((entry) => entry.id === revised.id ? revised : this.readTask(input.workItemId, entry.id)));
		const candidateEvaluations = await Promise.all(index.evaluations.map((entry) => this.readEvaluation(input.workItemId, entry.id)));
		validateExecutionTopology(candidate, candidateTasks, candidateEvaluations);
		index.executionStages = candidateStages;
		advanceContractRevision(index, input.authority);
		try {
			await atomicWriteFile(manifestPath, stringify(revised));
			await atomicWriteFile(briefPath, `${brief.trim()}\n`);
			await atomicWriteFile(acceptancePath, `${acceptance.trim()}\n`);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([taskRoot, indexPath], `harness(${input.workItemId}): revise task ${revised.id}`);
			return index;
		} catch (error) {
			await this.restore([manifestPath, briefPath, acceptancePath, indexPath].map((path, i) => ({ path, content: previous[i] })));
			throw error;
		}
	}

	async removeTask(workItemId: string, taskId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		const manifest = await this.readTask(workItemId, taskId);
		if (manifest.runtime || ["running", "contribution_complete", "reviewing", "accepted", "merge_queued", "merging", "merged", "staged", "integrating", "integrated"].includes(manifest.status)) throw new HarnessError("CAPABILITY_DENIED", `Task ${taskId} has delivery history and must be superseded rather than deleted`);
		for (const task of index.tasks.filter((candidate) => candidate.id !== taskId)) {
			if ((await this.readTask(workItemId, task.id)).dependsOn.includes(taskId)) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} still depends on ${taskId}`);
		}
		const taskRoot = dirname(join(root, catalog.path));
		const indexPath = join(root, "index.yaml");
		const previousIndex = await readFile(indexPath, "utf8");
		const backup = join(this.artifactRoot, `.${workItemId}-${taskId}.delete-${randomUUID()}`);
		index.executionStages ??= index.integrationUnits.map((unit) => ({ id: unit.id, tasks: [...unit.tasks] }));
		index.tasks = index.tasks.filter((task) => task.id !== taskId);
		for (const stage of index.executionStages!) stage.tasks = stage.tasks.filter((id) => id !== taskId);
		index.executionStages = index.executionStages!.filter((stage) => stage.tasks.length > 0);
		advanceContractRevision(index, authority);
		try {
			await rename(taskRoot, backup);
			await atomicWriteFile(indexPath, stringify(index));
			await runGit(this.repositoryRoot, ["add", "-A", "--", relative(this.repositoryRoot, taskRoot), relative(this.repositoryRoot, indexPath)]);
			await runGit(this.repositoryRoot, ["commit", "-m", `harness(${workItemId}): remove task ${taskId}`, "--", relative(this.repositoryRoot, taskRoot), relative(this.repositoryRoot, indexPath)]);
			await rm(backup, { recursive: true, force: true });
			return index;
		} catch (error) {
			if (await pathExists(backup)) await rename(backup, taskRoot);
			await this.restore([{ path: indexPath, content: previousIndex }]);
			await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, taskRoot)]).catch(() => undefined);
			throw error;
		}
	}

	async readTaskContract(workItemId: string, taskId: string): Promise<{ manifest: TaskManifest; brief: string; acceptance: string; workItemRevision: number }> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		const taskRoot = dirname(join(root, catalog.path));
		return { manifest: await this.readTask(workItemId, taskId), brief: await readFile(join(taskRoot, "brief.md"), "utf8"), acceptance: await readFile(join(taskRoot, "acceptance.md"), "utf8"), workItemRevision: index.planning.revision };
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
		if (update.status) {
			if (!canTransitionTask(manifest.status, update.status)) throw new HarnessError("INVALID_HANDOFF", `Invalid task transition: ${manifest.status} -> ${update.status}`);
			manifest.status = update.status;
		}
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

	async activateDraftTasks(workItemId: string): Promise<TaskManifest[]> {
		await assertCleanRepository(this.repositoryRoot);
		const item = await this.read(workItemId);
		const drafts = (await Promise.all(item.tasks.map((catalog) => this.readTask(workItemId, catalog.id)))).filter((task) => task.status === "draft");
		if (drafts.length === 0) return [];
		const files = drafts.map((task) => ({
			path: join(this.workItemRoot(workItemId), "tasks", task.id, "task.yaml"),
			content: stringify({ ...task, status: task.dependsOn.length === 0 ? "ready" : "blocked" }),
		}));
		const previous = await Promise.all(files.map(async (file) => ({ path: file.path, content: await readFile(file.path, "utf8") })));
		try {
			for (const file of files) await atomicWriteFile(file.path, file.content);
			await this.commit(files.map((file) => file.path), `harness(${workItemId}): activate workflow tasks`);
			return Promise.all(drafts.map((task) => this.readTask(workItemId, task.id)));
		} catch (error) {
			await this.restore(previous);
			throw error;
		}
	}

	async refreshReadyTasks(workItemId: string): Promise<TaskManifest[]> {
		const item = await this.read(workItemId);
		const changed: TaskManifest[] = [];
		for (const catalog of item.tasks) {
			const task = await this.readTask(workItemId, catalog.id);
			if (task.status !== "blocked") continue;
			const dependencies = await Promise.all(task.dependsOn.map((dependency) => this.readTask(workItemId, dependency)));
			if (dependencies.every((dependency) => dependency.status === "merged" || dependency.status === "integrated")) changed.push(await this.updateTask(workItemId, task.id, { status: "ready" }));
		}
		return changed;
	}

	async defineEvaluation(workItemId: string, manifest: EvaluationManifest, report = "# Evaluation\n\nPending.\n", authority?: MutationAuthority): Promise<WorkItemIndex> {
		validateId(manifest.id, "Evaluation id");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		await this.validateCriterionReferences(index, manifest.criteria ?? []);
		if (manifest.scope.task && !index.tasks.some((task) => task.id === manifest.scope.task)) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation task scope: ${manifest.scope.task}`);
		if (manifest.scope.integrationUnit && !index.integrationUnits.some((unit) => unit.id === manifest.scope.integrationUnit)) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation integration-unit scope: ${manifest.scope.integrationUnit}`);
		if (manifest.scope.workItem && manifest.scope.workItem !== workItemId) throw new HarnessError("INVALID_ARTIFACT", `Evaluation work-item scope must be ${workItemId}`);
		if (manifest.stageId) validateId(manifest.stageId, "Evaluation stage id");
		for (const dependency of manifest.dependsOn ?? []) if (!index.tasks.some((task) => task.id === dependency) && !index.evaluations.some((evaluation) => evaluation.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation dependency: ${dependency}`);
		if (manifest.dependsOn?.includes(manifest.id)) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${manifest.id} cannot depend on itself`);
		if (index.evaluations.some((item) => item.id === manifest.id)) throw new HarnessError("INVALID_ARTIFACT", `Evaluation already exists: ${manifest.id}`);
		const evaluationRoot = join(root, "evaluations", manifest.id);
		const manifestPath = join(evaluationRoot, "evaluation.yaml");
		const indexPath = join(root, "index.yaml");
		const priorIndex = await readFile(indexPath, "utf8");
		index.evaluations.push({ id: manifest.id, path: relative(root, manifestPath) });
		// New graphs keep typed nodes beside the schema-v1 task list. Legacy indexes
		// intentionally remain task-only until a planner explicitly creates a graph node.
		const stageId = manifest.stageId ?? (manifest.scope.integrationUnit ? manifest.scope.integrationUnit : undefined);
		if (index.executionStages && stageId) {
			const stage = index.executionStages.find((candidate) => candidate.id === stageId);
			if (stage) {
				stage.nodes ??= stage.tasks.map((id) => ({ kind: "task" as const, id }));
				if (!stage.nodes.some((node) => node.kind === "evaluation" && node.id === manifest.id)) stage.nodes.push({ kind: "evaluation", id: manifest.id });
			} else index.executionStages.push({ id: stageId, tasks: [], nodes: [{ kind: "evaluation", id: manifest.id }] });
		}
		const evaluation: EvaluationManifest = { ...manifest, checkpoint: manifest.checkpoint ?? "planned", loop: manifest.loop ?? { state: "planned", iteration: 0, maxIterations: 2 } };
		if (manifest.stageId) {
			const tasks = await Promise.all(index.tasks.map((entry) => this.readTask(workItemId, entry.id)));
			const evaluations = await Promise.all(index.evaluations.filter((entry) => entry.id !== manifest.id).map((entry) => this.readEvaluation(workItemId, entry.id)));
			validateExecutionTopology(index, tasks, [...evaluations, evaluation]);
		}
		advanceContractRevision(index, authority);
		try {
			await mkdir(evaluationRoot, { recursive: true });
			await atomicWriteFile(manifestPath, stringify(evaluation));
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

	async reviseEvaluation(workItemId: string, manifest: EvaluationManifest, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		await this.validateCriterionReferences(index, manifest.criteria ?? []);
		if (manifest.scope.task && !index.tasks.some((task) => task.id === manifest.scope.task)) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation task scope: ${manifest.scope.task}`);
		if (manifest.scope.integrationUnit && !index.integrationUnits.some((unit) => unit.id === manifest.scope.integrationUnit)) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation integration-unit scope: ${manifest.scope.integrationUnit}`);
		if (manifest.scope.workItem && manifest.scope.workItem !== workItemId) throw new HarnessError("INVALID_ARTIFACT", `Evaluation work-item scope must be ${workItemId}`);
		if (manifest.stageId) validateId(manifest.stageId, "Evaluation stage id");
		for (const dependency of manifest.dependsOn ?? []) if (dependency !== manifest.id && !index.tasks.some((task) => task.id === dependency) && !index.evaluations.some((evaluation) => evaluation.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation dependency: ${dependency}`);
		const catalog = index.evaluations.find((evaluation) => evaluation.id === manifest.id);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Evaluation does not exist: ${manifest.id}`);
		const path = join(root, catalog.path);
		const previousManifest = await readFile(path, "utf8");
		const previousIndex = await readFile(join(root, "index.yaml"), "utf8");
		const current = parse(previousManifest) as EvaluationManifest;
		if (current.attempt > 0 || current.result) throw new HarnessError("CAPABILITY_DENIED", `Evaluation ${manifest.id} has recorded evidence and must be superseded rather than rewritten`);
		const revised: EvaluationManifest = { ...manifest, status: current.status, attempt: current.attempt };
		if (index.executionStages) {
			const oldStageId = current.stageId ?? current.scope.integrationUnit;
			const newStageId = revised.stageId ?? revised.scope.integrationUnit;
			const stages = index.executionStages.map((stage) => ({ ...stage, tasks: [...stage.tasks], ...(stage.nodes ? { nodes: stage.nodes.map((node) => ({ ...node })) } : {}) }));
			if (oldStageId !== newStageId) for (const stage of stages) stage.nodes = (stage.nodes ?? stage.tasks.map((id) => ({ kind: "task" as const, id }))).filter((node) => !(node.kind === "evaluation" && node.id === revised.id));
			if (newStageId) {
				let target = stages.find((stage) => stage.id === newStageId);
				if (!target) { target = { id: newStageId, tasks: [], nodes: [] }; stages.push(target); }
				target.nodes ??= target.tasks.map((id) => ({ kind: "task" as const, id }));
				if (!target.nodes.some((node) => node.kind === "evaluation" && node.id === revised.id)) target.nodes.push({ kind: "evaluation", id: revised.id });
			}
			index.executionStages = stages.filter((stage) => stage.tasks.length || stage.nodes?.length);
			const tasks = await Promise.all(index.tasks.map((entry) => this.readTask(workItemId, entry.id)));
			const evaluations = await Promise.all(index.evaluations.map((entry) => entry.id === revised.id ? revised : this.readEvaluation(workItemId, entry.id)));
			validateExecutionTopology(index, tasks, evaluations);
		}
		advanceContractRevision(index, authority);
		const indexPath = join(root, "index.yaml");
		try {
			await atomicWriteFile(path, stringify(revised));
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([path, indexPath], `harness(${workItemId}): revise evaluation ${manifest.id}`);
			return index;
		} catch (error) {
			await this.restore([{ path, content: previousManifest }, { path: indexPath, content: previousIndex }]);
			throw error;
		}
	}

	async removeEvaluation(workItemId: string, evaluationId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		const catalog = index.evaluations.find((evaluation) => evaluation.id === evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${evaluationId}`);
		const current = await this.readEvaluation(workItemId, evaluationId);
		if (current.attempt > 0 || current.result) throw new HarnessError("CAPABILITY_DENIED", `Evaluation ${evaluationId} has recorded evidence and cannot be deleted`);
		const evaluationRoot = dirname(join(root, catalog.path));
		const indexPath = join(root, "index.yaml");
		const previousIndex = await readFile(indexPath, "utf8");
		const backup = join(this.artifactRoot, `.${workItemId}-${evaluationId}.delete-${randomUUID()}`);
		index.evaluations = index.evaluations.filter((evaluation) => evaluation.id !== evaluationId);
		if (index.executionStages) {
			for (const stage of index.executionStages) if (stage.nodes) stage.nodes = stage.nodes.filter((node) => !(node.kind === "evaluation" && node.id === evaluationId));
			index.executionStages = index.executionStages.filter((stage) => stage.tasks.length || stage.nodes?.length);
		}
		advanceContractRevision(index, authority);
		try {
			await rename(evaluationRoot, backup);
			await atomicWriteFile(indexPath, stringify(index));
			await runGit(this.repositoryRoot, ["add", "-A", "--", relative(this.repositoryRoot, evaluationRoot), relative(this.repositoryRoot, indexPath)]);
			await runGit(this.repositoryRoot, ["commit", "-m", `harness(${workItemId}): remove evaluation ${evaluationId}`, "--", relative(this.repositoryRoot, evaluationRoot), relative(this.repositoryRoot, indexPath)]);
			await rm(backup, { recursive: true, force: true });
			return index;
		} catch (error) {
			if (await pathExists(backup)) await rename(backup, evaluationRoot);
			await this.restore([{ path: indexPath, content: previousIndex }]);
			await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, evaluationRoot)]).catch(() => undefined);
			throw error;
		}
	}

	async putIntegrationUnit(workItemId: string, unit: WorkItemIndex["integrationUnits"][number], authority: MutationAuthority): Promise<WorkItemIndex> {
		validateId(unit.id, "Integration-unit id");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		if (unit.tasks.length === 0) throw new HarnessError("INVALID_ARTIFACT", `Integration unit ${unit.id} must contain at least one task`);
		if (new Set(unit.tasks).size !== unit.tasks.length) throw new HarnessError("INVALID_ARTIFACT", `Integration unit ${unit.id} contains duplicate task ids`);
		for (const taskId of unit.tasks) if (!index.tasks.some((task) => task.id === taskId)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task in integration unit ${unit.id}: ${taskId}`);
		for (const existing of index.integrationUnits) if (existing.id !== unit.id) existing.tasks = existing.tasks.filter((taskId) => !unit.tasks.includes(taskId));
		index.integrationUnits = index.integrationUnits.filter((existing) => existing.tasks.length > 0 && existing.id !== unit.id);
		index.integrationUnits.push({ ...unit, tasks: [...unit.tasks] });
		advanceContractRevision(index, authority);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([indexPath], `harness(${workItemId}): update integration unit ${unit.id}`);
			return index;
		} catch (error) {
			await this.restore([{ path: indexPath, content: previous }]);
			throw error;
		}
	}

	async removeIntegrationUnit(workItemId: string, unitId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		assertContractMutable(index);
		if (!index.integrationUnits.some((unit) => unit.id === unitId)) throw new HarnessError("INVALID_ARTIFACT", `Unknown integration unit: ${unitId}`);
		for (const evaluation of index.evaluations) {
			const manifest = await this.readEvaluation(workItemId, evaluation.id);
			if (manifest.scope.integrationUnit === unitId) throw new HarnessError("INVALID_ARTIFACT", `Evaluation ${manifest.id} still references integration unit ${unitId}`);
		}
		index.integrationUnits = index.integrationUnits.filter((unit) => unit.id !== unitId);
		advanceContractRevision(index, authority);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8");
		try {
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([indexPath], `harness(${workItemId}): remove integration unit ${unitId}`);
			return index;
		} catch (error) {
			await this.restore([{ path: indexPath, content: previous }]);
			throw error;
		}
	}

	async readArtifact(workItemId: string, artifactId: string): Promise<{ metadata: WorkItemIndex["artifacts"][number]; content: string; workItemRevision: number }> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const metadata = index.artifacts.find((artifact) => artifact.id === artifactId);
		if (!metadata) throw new HarnessError("INVALID_ARTIFACT", `Unknown artifact: ${artifactId}`);
		return { metadata, content: await readFile(join(root, metadata.path), "utf8"), workItemRevision: index.planning.revision };
	}

	async readE2EMatrix(workItemId: string): Promise<{ metadata: WorkItemIndex["artifacts"][number]; content: string; workItemRevision: number } | undefined> {
		const item = await this.read(workItemId);
		const matrix = item.artifacts.find((artifact) => artifact.type === "e2e-matrix" && artifact.status === "approved");
		return matrix ? this.readArtifact(workItemId, matrix.id) : undefined;
	}

	async ensureFinalEvaluations(workItemId: string, maxIterations = 2): Promise<EvaluationManifest[]> {
		const item = await this.read(workItemId);
		const existing = await Promise.all(item.evaluations.map((entry) => this.readEvaluation(workItemId, entry.id)));
		// Compatibility rule: persisted stories that already carried an E2E evaluation
		// remain runnable; all new final-E2E launches require the approved matrix.
		if (!item.artifacts.some((artifact) => artifact.type === "e2e-matrix" && artifact.status === "approved") && !existing.some((evaluation) => evaluation.type === "e2e")) {
			throw new HarnessError("INVALID_HANDOFF", `Work item ${workItemId} cannot launch final E2E without an e2e-matrix artifact`);
		}
		let finalJourney = existing.find((evaluation) => evaluation.checkpoint === "final-e2e")
			?? existing.find((evaluation) => evaluation.type === "e2e" && evaluation.scope.workItem === workItemId);
		if (!finalJourney) {
			finalJourney = { schemaVersion: 1, id: "final-e2e", type: "e2e", checkpoint: "final-e2e", scope: { workItem: workItemId }, status: "planned", required: true, attempt: 0, methods: ["Exercise the complete meaningful user journey; record not_applicable only when no runnable E2E surface exists."], loop: { state: "planned", iteration: 0, maxIterations } };
			await this.defineRuntimeEvaluation(workItemId, finalJourney);
		}
		let finalReview = existing.find((evaluation) => evaluation.checkpoint === "final-review");
		if (!finalReview) {
			finalReview = { schemaVersion: 1, id: "final-branch-review", type: "combined-review", checkpoint: "final-review", scope: { workItem: workItemId }, status: "planned", required: true, attempt: 0, methods: ["Review the complete feature-branch diff for specification fit, correctness, regressions, maintainability, and test coverage."], loop: { state: "planned", iteration: 0, maxIterations } };
			await this.defineRuntimeEvaluation(workItemId, finalReview);
		}
		return [await this.readEvaluation(workItemId, finalJourney.id), await this.readEvaluation(workItemId, finalReview.id)];
	}

	private async defineRuntimeEvaluation(workItemId: string, manifest: EvaluationManifest): Promise<void> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const evaluationRoot = join(root, "evaluations", manifest.id);
		const manifestPath = join(evaluationRoot, "evaluation.yaml");
		const indexPath = join(root, "index.yaml");
		if (index.evaluations.some((entry) => entry.id === manifest.id)) return;
		index.evaluations.push({ id: manifest.id, path: relative(root, manifestPath) });
		await mkdir(evaluationRoot, { recursive: true });
		await atomicWriteFile(manifestPath, stringify(manifest));
		await atomicWriteFile(join(evaluationRoot, "report.md"), "# Evaluation\n\nPending.\n");
		await atomicWriteFile(indexPath, stringify(index));
		await this.commit([evaluationRoot, indexPath], `harness(${workItemId}): add final review checkpoint ${manifest.id}`);
	}

	async updateEvaluationLoop(workItemId: string, evaluationId: string, update: Partial<NonNullable<EvaluationManifest["loop"]>>, status?: EvaluationManifest["status"]): Promise<EvaluationManifest> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		const catalog = index.evaluations.find((entry) => entry.id === evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${evaluationId}`);
		const path = join(root, catalog.path);
		const evaluation = await this.readEvaluation(workItemId, evaluationId);
		evaluation.loop = { state: "planned", iteration: 0, maxIterations: 2, ...evaluation.loop, ...update };
		if (status) evaluation.status = status;
		await atomicWriteFile(path, stringify(evaluation));
		await this.commit([path], `harness(${workItemId}): update review loop ${evaluationId}`);
		return evaluation;
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

	/** Serialize evaluation artifact writes across processes; Git's index is shared by all workers. */
	async recordEvaluation(input: {
		workItemId: string;
		evaluationId: string;
		verdict: "pass" | "fail" | "blocked" | "not_applicable";
		report: string;
		evidence: Array<{ command?: string; result: string; path?: string; description?: string }>;
		findings?: NonNullable<EvaluationManifest["findings"]>;
		residualRisks?: string[];
	}): Promise<EvaluationManifest> {
		// Keep the lock outside the working tree so assertCleanRepository never sees
		// the lock itself as an uncommitted canonical artifact.
		const lock = new RepositoryMutex(join(this.repositoryRoot, ".git", "pibox-evaluation-lock"));
		return lock.run(`evaluation-record:${input.workItemId}:${input.evaluationId}`, () => this.recordEvaluationUnlocked(input));
	}

	private async recordEvaluationUnlocked(input: {
		workItemId: string;
		evaluationId: string;
		verdict: "pass" | "fail" | "blocked" | "not_applicable";
		report: string;
		evidence: Array<{ command?: string; result: string; path?: string; description?: string }>;
		findings?: NonNullable<EvaluationManifest["findings"]>;
		residualRisks?: string[];
	}): Promise<EvaluationManifest> {
		if (!input.report.trim()) throw new HarnessError("INVALID_ARTIFACT", "Evaluation report must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		if (index.phase === "complete") throw new HarnessError("INVALID_HANDOFF", `Work item is already complete: ${input.workItemId}`);
		const catalog = index.evaluations.find((evaluation) => evaluation.id === input.evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${input.evaluationId}`);
		const evaluationPath = join(root, catalog.path);
		const evaluationRoot = dirname(evaluationPath);
		const indexPath = join(root, "index.yaml");
		const reportPath = join(evaluationRoot, "report.md");
		const evidenceRoot = join(root, "evidence", input.evaluationId);
		const manifestPath = join(evidenceRoot, "manifest.yaml");
		const previousEvaluation = await readFile(evaluationPath, "utf8");
		const previousIndex = await readFile(indexPath, "utf8");
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
					const source = await validateEvidenceSource(this.repositoryRoot, evidence.path);
					const info = await stat(source).catch(() => undefined);
					if (!info?.isFile()) throw new HarnessError("INVALID_ARTIFACT", `Evidence path is not a regular file: ${evidence.path}`);
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
			evaluation.loop = {
				iteration: evaluation.loop?.iteration ?? 0,
				maxIterations: evaluation.loop?.maxIterations ?? 2,
				...evaluation.loop,
				state: input.verdict === "pass" || input.verdict === "not_applicable" ? "passed" : "awaiting_manager",
			};
			if (input.findings) evaluation.findings = input.findings;
			evaluation.result = {
				verdict: input.verdict,
				report: "report.md",
				evidence: `../../evidence/${input.evaluationId}/manifest.yaml`,
			};
			await atomicWriteFile(reportPath, renderEvaluationReport({
				id: evaluation.id,
				boundary: evaluation.scope,
				...(evaluation.criteria ? { criteria: evaluation.criteria } : {}),
				observations: input.report,
				evidence: input.evidence,
				findings: input.findings ?? [],
				verdict: input.verdict,
				...(input.residualRisks ? { residualRisks: input.residualRisks } : {}),
			}));
			await atomicWriteFile(evaluationPath, stringify(evaluation));
			index.phase = "evaluation";
			await atomicWriteFile(indexPath, stringify(index));
			await atomicWriteFile(manifestPath, stringify({ schemaVersion: 1, evaluation: input.evaluationId, recordedAt: new Date().toISOString(), entries: evidenceEntries }));
			await this.commit([evaluationRoot, evidenceRoot, indexPath], `harness(${input.workItemId}): record evaluation ${input.evaluationId}`);
			return evaluation;
		} catch (error) {
			await atomicWriteFile(evaluationPath, previousEvaluation);
			await atomicWriteFile(indexPath, previousIndex);
			if (previousReport === undefined) await rm(reportPath, { force: true });
			else await atomicWriteFile(reportPath, previousReport);
			await rm(evidenceRoot, { recursive: true, force: true });
			await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, evaluationRoot), relative(this.repositoryRoot, evidenceRoot), relative(this.repositoryRoot, indexPath)]).catch(() => undefined);
			throw error;
		}
	}

	async completeWorkItem(workItemId: string, outcome?: string, outcomeSections?: { delivered: string[]; deviations?: string[]; residualRisks?: string[]; followUp?: string[] }): Promise<WorkItemIndex> {
		if (!outcome?.trim() && !outcomeSections) throw new HarnessError("INVALID_ARTIFACT", "Outcome must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		for (const task of index.tasks) {
			if (!["merged", "integrated"].includes((await this.readTask(workItemId, task.id)).status)) {
				throw new HarnessError("INVALID_HANDOFF", `Task is not merged: ${task.id}`);
			}
		}
		const remainingFindings: Array<{ evaluation: string; id: string; severity: string; summary: string; status: string }> = [];
		const verification: string[] = [];
		for (const evaluation of index.evaluations) {
			const manifest = await this.readEvaluation(workItemId, evaluation.id);
			verification.push(`${manifest.id}: ${manifest.status}`);
			if (manifest.required && manifest.status !== "passed" && manifest.status !== "not_applicable") {
				throw new HarnessError("INVALID_HANDOFF", `Required evaluation has not passed: ${evaluation.id}`);
			}
			if (manifest.findings?.some((finding) => finding.blocking && (finding.status === "open" || finding.status === "accepted" || finding.status === "needs_user"))) {
				throw new HarnessError("INVALID_HANDOFF", `Evaluation has an unresolved blocking finding: ${evaluation.id}`);
			}
			for (const finding of manifest.findings ?? []) {
				if (finding.status !== "resolved" && finding.status !== "rejected" && finding.status !== "duplicate") {
					remainingFindings.push({ evaluation: evaluation.id, id: finding.id, severity: finding.severity, summary: finding.summary, status: finding.status });
				}
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
		const findingLines = remainingFindings.map((finding) => `**${finding.id}** (${finding.severity}, ${finding.status}; ${finding.evaluation}): ${finding.summary}`);
		const renderedOutcome = outcomeSections
			? renderOutcome({
				title: index.title,
				delivered: outcomeSections.delivered,
				verification: verification.length ? verification : ["No planned evaluations were required."],
				...(outcomeSections.deviations ? { deviations: outcomeSections.deviations } : {}),
				...(findingLines.length ? { remainingFindings: findingLines } : {}),
				...(outcomeSections.residualRisks ? { residualRisks: outcomeSections.residualRisks } : {}),
				...(outcomeSections.followUp ? { followUp: outcomeSections.followUp } : {}),
			})
			: `${outcome?.trim()}${findingLines.length ? `\n\n## Remaining non-blocking findings\n\n${findingLines.map((line) => `- ${line}`).join("\n")}` : ""}\n`;
		try {
			await atomicWriteFile(outcomePath, renderedOutcome);
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

	async transitionWorkItem(id: string, action: "postpone" | "resume" | "archive" | "reopen" | "request-user", reason: string): Promise<WorkItemIndex> {
		if (!reason.trim()) throw new HarnessError("INVALID_ARTIFACT", "Transition reason is required");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(id);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8");
		const index = parseWorkItemIndex(previous, indexPath);
		if (index.finalization?.locked && action !== "reopen") throw new HarnessError("CAPABILITY_DENIED", `Work item ${id} is finalized; reopen it before transition`);
		if (action === "postpone") index.state = "postponed";
		if (action === "resume") index.state = "active";
		if (action === "request-user") index.state = "waiting_user";
		if (action === "archive") {
			index.state = "archived";
			index.finalization = { locked: true, reason, lockedAt: new Date().toISOString() };
		}
		if (action === "reopen") {
			delete index.finalization;
			index.state = "active";
			if (index.phase === "complete") index.phase = "planning";
		}
		try {
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([indexPath], `harness(${id}): ${action} work item`);
			return index;
		} catch (error) {
			await this.restore([{ path: indexPath, content: previous }]);
			throw error;
		}
	}

	async submitPlanning(id: string): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const index = await this.read(id);
		if (index.finalization?.locked || index.phase === "complete") throw new HarnessError("CAPABILITY_DENIED", `Work item ${id} is finalized; reopen it before planning or execution`);
		const tasks = await Promise.all(index.tasks.map((task) => this.readTask(id, task.id)));
		const evaluations = await Promise.all(index.evaluations.map((evaluation) => this.readEvaluation(id, evaluation.id)));
		validateExecutionTopology(index, tasks, evaluations);
		return index;
	}

	async beginExecution(id: string): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(id);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8").catch(() => {
			throw new HarnessError("WORK_ITEM_NOT_FOUND", `Work item does not exist: ${id}`);
		});
		const rawIndex = parse(previous) as { planning?: Record<string, unknown> };
		const hadLegacyApprovalMetadata = ["status", "approvedRevision", "approvedAt", "contractDigest", "approvalAmendments"].some((key) => rawIndex.planning?.[key] !== undefined);
		const index = parseWorkItemIndex(previous, indexPath);
		if (index.finalization?.locked || index.phase === "complete") throw new HarnessError("CAPABILITY_DENIED", `Work item ${id} is finalized; reopen it before execution`);
		const tasks = await Promise.all(index.tasks.map((task) => this.readTask(id, task.id)));
		const evaluations = await Promise.all(index.evaluations.map((evaluation) => this.readEvaluation(id, evaluation.id)));
		validateExecutionTopology(index, tasks, evaluations);
		const needsPhase = index.phase === "planning";
		const needsActiveState = index.state !== "active";
		if (needsPhase) index.phase = "execution";
		if (needsActiveState) index.state = "active";
		if (needsPhase || needsActiveState || hadLegacyApprovalMetadata) {
			await atomicWriteFile(indexPath, stringify(index));
			try {
				await this.commit([indexPath], `harness(${id}): begin execution`);
			} catch (error) {
				await this.restore([{ path: indexPath, content: previous }]);
				throw error;
			}
		}
		return index;
	}

	private async validateCriterionReferences(index: WorkItemIndex, references: string[]): Promise<void> {
		for (const reference of references) {
			const [artifactId, criterionId] = reference.split("#");
			const artifact = index.artifacts.find((candidate) => candidate.id === artifactId && candidate.type === "spec");
			if (!artifact || artifact.narrativeSchemaVersion !== 2) {
				throw new HarnessError("INVALID_ARTIFACT", `Criterion reference ${reference} requires a schema-v2 specification`);
			}
			const content = await readFile(join(this.workItemRoot(index.id), artifact.path), "utf8");
			if (!criterionId || (!content.includes(`**${criterionId}:**`) && !content.includes(`**${criterionId}**`))) {
				throw new HarnessError("INVALID_ARTIFACT", `Dangling criterion reference: ${reference}`);
			}
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
