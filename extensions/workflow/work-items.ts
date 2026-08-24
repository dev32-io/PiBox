import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { acceptanceCriterionIds, renderArtifact, renderEvaluationReport, renderOutcome, type SemanticSections } from "./artifact-contracts.js";
import { HarnessError } from "./errors.js";
import { executionTopologyIssues, validateExecutionTopology, type ExecutionTopologyIssue } from "./execution-topology.js";
import { assertCleanRepository, atomicWriteFile, discoverCommonDirSync, runGit } from "./repository.js";
import { CanonicalMutationCoordinator } from "./canonical-mutation.js";
import { isTierTaskAssignment, type E2ECaseResult, type EvaluationManifest, type MutationAuthority, type TaskManifest, type TaskStatus, type WorkingBranchKind, type WorkItemDelivery, type WorkItemIndex, type WorkItemKind } from "./types.js";
import { DEFAULT_REVIEW_FIX_ITERATIONS } from "./review-loop.js";
import { stageReviewRequired, validateStageReviewPolicy } from "./stage-review-policy.js";
import { normalizeChecks, verificationCommand } from "./verification-checks.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCAL_PERMISSION_RATIONALE = /(?=.*\buser\b)(?=.*\b(?:request(?:ed)?|permission|approv(?:ed|al)?|authoriz(?:ed|ation)?)\b)/i;
const ARTIFACT_DIRECTORIES = { spec: "specs", design: "design", decision: "decisions", "e2e-matrix": "e2e-matrix" } as const;
export type MutableArtifactType = keyof typeof ARTIFACT_DIRECTORIES;

function collectQualifiedCriteria(value: unknown, found = new Set<string>()): string[] {
	if (typeof value === "string") {
		for (const match of value.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)*)#(AC-\d{3})\b/g)) found.add(`${match[1]}#${match[2]}`);
	} else if (Array.isArray(value)) value.forEach((entry) => collectQualifiedCriteria(entry, found));
	else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectQualifiedCriteria(entry, found));
	return [...found];
}

export function immutableWorkItemMutationError(index: WorkItemIndex): HarnessError {
	const completed = index.phase === "complete";
	const guidance = completed
		? { tool: "workflow_transition", arguments: { ref: `work-item:${index.id}`, action: "reopen", reason: "Describe the requested amendment" }, outcome: "Creates a linked editable amendment work item and keeps this completed baseline immutable; retry mutations against the returned amendment ref." }
		: { tool: "workflow_transition", arguments: { ref: `work-item:${index.id}`, action: "reopen", reason: "Describe why editing should resume" }, outcome: "Reopens this archived planning work item; retry the mutation after the transition succeeds." };
	return new HarnessError("CAPABILITY_DENIED", completed
		? `Work item ${index.id} is complete and immutable. Call workflow_transition with action reopen to create a linked amendment, then retry against the returned amendment work-item ref.`
		: `Work item ${index.id} is finalized and immutable. Call workflow_transition with action reopen, then retry the mutation.`, { workflowState: { phase: index.phase, state: index.state, finalized: Boolean(index.finalization?.locked) }, guidance });
}

function assertContractMutable(index: WorkItemIndex): void {
	if (index.finalization?.locked || index.phase === "complete") throw immutableWorkItemMutationError(index);
}

function advanceContractRevision(index: WorkItemIndex, _authority?: MutationAuthority): void {
	index.planning.revision += 1;
}

function validateId(id: string, label: string): void {
	if (!ID_PATTERN.test(id)) throw new HarnessError("INVALID_ARTIFACT", `${label} must be a kebab-case identifier`);
}

const WORKING_BRANCH_PATTERN = /^(feature|fix)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROTECTED_BRANCHES = new Set(["develop", "main", "master"]);

function validateDelivery(delivery: WorkItemDelivery): void {
	if (!WORKING_BRANCH_PATTERN.test(delivery.workingBranch) || PROTECTED_BRANCHES.has(delivery.workingBranch)) throw new HarnessError("INVALID_ARTIFACT", "workingBranch must match feature/<kebab-case-name> or fix/<kebab-case-name>");
	if (!/^[0-9a-f]{40,64}$/.test(delivery.createdFromCommit)) throw new HarnessError("INVALID_ARTIFACT", "delivery.createdFromCommit must be a harness-owned Git commit anchor");
	if (delivery.executionStartCommit !== undefined && !/^[0-9a-f]{40,64}$/.test(delivery.executionStartCommit)) throw new HarnessError("INVALID_ARTIFACT", "delivery.executionStartCommit must be a harness-owned Git commit anchor");
}

function ensureInside(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
		throw new HarnessError("INVALID_ARTIFACT", `Path escapes its managed root: ${path}`);
	}
}

const SENSITIVE_EVIDENCE_NAME = /(^|[._-])(env|credentials?|secrets?|private|token|password|passwd|api[-_]?key|transcript|session)([._-]|$)|\.(pem|key|p12|pfx)$/i;
const SENSITIVE_EVIDENCE_CONTENT = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s]+)/i;

export async function validateEvidenceSource(repositoryRoot: string, source: string): Promise<string> {
	let lexical = resolve(repositoryRoot, source);
	let absolute = await realpath(lexical).catch(() => undefined);
	if (!absolute) {
		// Reviewers commonly cite source as path:line or path:start-end,more-ranges.
		// Preserve that citation in the report while validating/copying the real file.
		const withoutLineRanges = source.replace(/:(?:L?\d+(?:-L?\d+)?)(?:,(?:L?\d+(?:-L?\d+)?))*$/, "");
		if (withoutLineRanges !== source) {
			lexical = resolve(repositoryRoot, withoutLineRanges);
			absolute = await realpath(lexical).catch(() => undefined);
		}
	}
	if (!absolute) throw new HarnessError("INVALID_ARTIFACT", `Evidence file does not exist: ${source}`);
	const allowedRoots = await Promise.all([repositoryRoot, tmpdir(), "/tmp"].map((root) => realpath(root).catch(() => resolve(root))));
	if (!allowedRoots.some((root) => absolute !== root && absolute.startsWith(`${root}${sep}`))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source resolves outside the repository or operating-system temporary directory: ${source}`);
	if (SENSITIVE_EVIDENCE_NAME.test(basename(absolute)) || SENSITIVE_EVIDENCE_NAME.test(basename(lexical))) throw new HarnessError("INVALID_ARTIFACT", `Evidence source looks sensitive: ${source}. Provide a sanitized minimal artifact instead.`);
	const info = await stat(absolute).catch(() => undefined);
	if (!info?.isFile()) throw new HarnessError("INVALID_ARTIFACT", `Evidence path is not a regular file: ${source}. Provide a specific sanitized file instead of a directory.`);
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
		try { validateDelivery(index.delivery); }
		catch (error) { throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid working-branch delivery contract: ${error instanceof Error ? error.message : String(error)}`); }
	}
	if (index.amendment !== undefined) {
		const amendment = index.amendment;
		if (!ID_PATTERN.test(amendment.baselineWorkItemId) || !ID_PATTERN.test(amendment.rootWorkItemId) || !Number.isInteger(amendment.generation) || amendment.generation < 1 || !Number.isInteger(amendment.baselineRevision) || amendment.baselineRevision < 1 || !/^[0-9a-f]{40,64}$/.test(amendment.baselineCommit) || typeof amendment.createdAt !== "string" || !amendment.createdAt || typeof amendment.reason !== "string" || !amendment.reason.trim()) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid amendment metadata`);
	}
	if (index.integrationUnits === undefined) index.integrationUnits = [];
	if (!Array.isArray(index.integrationUnits)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid integration units`);
	// Do not materialize the compatibility projection in memory: a read of a
	// schema-v1 artifact must not cause its canonical index to be rewritten.
	if (index.executionStages !== undefined && !Array.isArray(index.executionStages)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid execution stages`);
	const scheduled = new Set<string>();
	const stageIds = new Set<string>();
	for (const stage of index.executionStages ?? []) {
		const emptyOutsidePlanning = Array.isArray(stage?.tasks) && stage.tasks.length === 0 && index.phase !== "planning";
		if (!stage || typeof stage.id !== "string" || !ID_PATTERN.test(stage.id) || stageIds.has(stage.id) || !Array.isArray(stage.tasks) || emptyOutsidePlanning || stage.tasks.some((id) => typeof id !== "string" || scheduled.has(id))) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid or duplicate execution stages/tasks`);
		stageIds.add(stage.id);
		stage.tasks.forEach((id) => scheduled.add(id));
		if (stage.mode !== undefined && stage.mode !== "sequential" && stage.mode !== "concurrent") throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid execution stage mode`);
		if (stage.checks !== undefined) {
			if (!Array.isArray(stage.checks)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid stage checks`);
			normalizeChecks(stage.checks, `${source} stage ${stage.id} checks`);
		}
		validateStageReviewPolicy(stage.review, `${source} stage ${stage.id} review policy`);
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
	running: ["blocked", "paused", "ready", "submitted", "awaiting_ci", "changes_requested", "contribution_complete", "failed", "protocol_failed", "cancelled"],
	paused: ["blocked", "ready", "running", "cancelled"],
	submitted: ["awaiting_ci", "changes_requested", "cancelled"],
	awaiting_ci: ["contribution_complete", "changes_requested", "failed", "cancelled"],
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
		"draft", "blocked", "ready", "running", "paused", "submitted", "awaiting_ci", "contribution_complete", "reviewing", "changes_requested", "accepted", "merge_queued", "merging", "merged", "staged", "integrating", "integrated", "failed", "protocol_failed", "cancelled",
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
		if (!["low", "medium", "high", "max", "local"].includes(assignment.tier)) throw new HarnessError("INVALID_ARTIFACT", `${source} has invalid tier routing`);
		if (assignment.tier === "local" && !LOCAL_PERMISSION_RATIONALE.test(assignment.rationale)) throw new HarnessError("INVALID_ARTIFACT", `${source} local routing requires a rationale recording explicit user permission`);
	} else if (typeof assignment.model !== "string" || typeof assignment.effort !== "string" || typeof assignment.minimumCapabilityRank !== "number" || typeof assignment.allowFallback !== "boolean") {
		throw new HarnessError("INVALID_ARTIFACT", `${source} has an invalid legacy model assignment`);
	}
	return task as TaskManifest;
}

export class WorkItemStore {
	readonly repositoryRoot: string;
	readonly artifactRoot: string;
	readonly coordinator: CanonicalMutationCoordinator;

	constructor(repositoryRoot: string, coordinator?: CanonicalMutationCoordinator) {
		this.repositoryRoot = resolve(repositoryRoot);
		this.artifactRoot = join(this.repositoryRoot, "agent-artifacts");
		if (coordinator) this.coordinator = coordinator;
		else {
			const commonDir = discoverCommonDirSync(this.repositoryRoot);
			this.coordinator = new CanonicalMutationCoordinator(this.repositoryRoot, commonDir ?? this.repositoryRoot);
		}
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

	async findDelivery(id: string): Promise<WorkItemDelivery | undefined> {
		const indexPath = relative(this.repositoryRoot, join(this.workItemRoot(id), "index.yaml"));
		const branches = (await runGit(this.repositoryRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature", "refs/heads/fix"])).split("\n").filter(Boolean);
		for (const branch of branches) {
			const candidate = await runGit(this.repositoryRoot, ["show", `${branch}:${indexPath}`]).then((content) => parse(content) as { id?: string; delivery?: WorkItemDelivery }, () => undefined);
			if (candidate?.id === id && candidate.delivery?.workingBranch === branch) return candidate.delivery;
		}
		return undefined;
	}

	async read(id: string): Promise<WorkItemIndex> {
		const path = join(this.workItemRoot(id), "index.yaml");
		if (!(await pathExists(path))) {
			const delivery = await this.findDelivery(id);
			if (delivery) throw new HarnessError("CAPABILITY_DENIED", `Work item ${id} is bound to ${delivery.workingBranch}; switch to that branch intentionally before reading or mutating it`);
			throw new HarnessError("WORK_ITEM_NOT_FOUND", `Work item does not exist: ${id}`);
		}
		return parseWorkItemIndex(await readFile(path, "utf8"), path);
	}

	private async currentBranch(): Promise<string> {
		return runGit(this.repositoryRoot, ["branch", "--show-current"]);
	}

	private async assertWorkingBranch(index: WorkItemIndex): Promise<void> {
		if (!index.delivery) throw new HarnessError("INVALID_ARTIFACT", `Work item ${index.id} has no workingBranch contract`);
		const current = await this.currentBranch();
		if (current !== index.delivery.workingBranch) throw new HarnessError("CAPABILITY_DENIED", `Work item ${index.id} is bound to ${index.delivery.workingBranch}; current branch is ${current || "detached HEAD"}`);
	}

	private async prepareWorkingBranch(id: string, requested: string | undefined, kind: WorkingBranchKind | undefined): Promise<{ delivery: WorkItemDelivery; created: boolean }> {
		await assertCleanRepository(this.repositoryRoot);
		const current = await this.currentBranch();
		const requestedKind = requested?.match(/^(feature|fix)\//)?.[1] as WorkingBranchKind | undefined;
		const currentKind = current.match(/^(feature|fix)\//)?.[1] as WorkingBranchKind | undefined;
		const branchKind = kind ?? requestedKind ?? currentKind ?? "feature";
		if (branchKind !== "feature" && branchKind !== "fix") throw new HarnessError("INVALID_ARTIFACT", "branchKind must be feature or fix");

		if (current !== "develop") {
			if (!currentKind || PROTECTED_BRANCHES.has(current)) throw new HarnessError("CAPABILITY_DENIED", `New work item ${id} requires clean develop or the checked-out feature/fix branch; current branch is ${current || "detached HEAD"}`);
			const workingBranch = requested ?? current;
			if (workingBranch !== current) throw new HarnessError("CAPABILITY_DENIED", `New work item ${id} can only continue the checked-out branch ${current}; requested ${workingBranch}`);
			if (branchKind !== currentKind) throw new HarnessError("INVALID_ARTIFACT", `branchKind ${branchKind} does not match checked-out branch ${current}`);
			const createdFromCommit = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			return { delivery: { workingBranch, createdFromCommit }, created: false };
		}

		const workingBranch = requested ?? `${branchKind}/${id}`;
		if (!WORKING_BRANCH_PATTERN.test(workingBranch) || !workingBranch.startsWith(`${branchKind}/`) || PROTECTED_BRANCHES.has(workingBranch)) throw new HarnessError("INVALID_ARTIFACT", `workingBranch must match ${branchKind}/<kebab-case-name>`);
		const exists = await runGit(this.repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workingBranch}`]).then(() => true, () => false);
		if (exists) throw new HarnessError("GIT_OPERATION_FAILED", `Working branch already exists: ${workingBranch}`);
		const hasOrigin = await runGit(this.repositoryRoot, ["remote", "get-url", "origin"]).then(() => true, () => false);
		if (hasOrigin) await runGit(this.repositoryRoot, ["pull", "--ff-only", "origin", "develop"]);
		const createdFromCommit = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		await runGit(this.repositoryRoot, ["switch", "-c", workingBranch]);
		return { delivery: { workingBranch, createdFromCommit }, created: true };
	}

	async create(input: { id: string; title: string; kind: WorkItemKind; delivery?: WorkItemDelivery; workingBranch?: string; branchKind?: WorkingBranchKind; intent?: string; intentSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; amendment?: WorkItemIndex["amendment"] }): Promise<WorkItemIndex> {
		return this.coordinator.run(`work-item-create:${input.id}`, () => this.createUnlocked(input));
	}

	private async createUnlocked(input: { id: string; title: string; kind: WorkItemKind; delivery?: WorkItemDelivery; workingBranch?: string; branchKind?: WorkingBranchKind; intent?: string; intentSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; amendment?: WorkItemIndex["amendment"] }): Promise<WorkItemIndex> {
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
		if (input.delivery && (input.workingBranch || input.branchKind)) throw new HarnessError("INVALID_ARTIFACT", "Creation accepts either a canonical delivery contract or working-branch authoring hints, not both");
		if (input.delivery) validateDelivery(input.delivery);
		if (input.amendment && (!ID_PATTERN.test(input.amendment.baselineWorkItemId) || !ID_PATTERN.test(input.amendment.rootWorkItemId) || input.amendment.generation < 1)) throw new HarnessError("INVALID_ARTIFACT", "Amendment creation requires valid immutable baseline metadata");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.id);
		if (await pathExists(root)) throw new HarnessError("WORK_ITEM_EXISTS", `Work item already exists: ${input.id}`);
		// Capture both sides of the branch operation before pull/switch.  A failed
		// create must return the checkout to exactly the branch the caller supplied;
		// it must never reset that branch, since it may have advanced externally.
		const originalBranch = await this.currentBranch();
		const originalHead = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		const requestedBranch = input.delivery?.workingBranch ?? input.workingBranch;
		const inferredKind = requestedBranch?.match(/^(feature|fix)\//)?.[1] as WorkingBranchKind | undefined;
		let delivery: WorkItemDelivery | undefined;
		let createdWorkingBranch = false;
		const temporary = join(this.artifactRoot, `.${input.id}.tmp-${randomUUID()}`);
		try {
			const prepared = await this.prepareWorkingBranch(input.id, requestedBranch, input.branchKind ?? inferredKind);
			delivery = prepared.delivery;
			createdWorkingBranch = prepared.created;
			await mkdir(temporary, { recursive: true });
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
				delivery,
				...(input.amendment ? { amendment: input.amendment } : {}),
				evaluations: [],
			};
			await writeFile(join(temporary, "index.yaml"), stringify(index), "utf8");
			await mkdir(this.artifactRoot, { recursive: true });
			await rename(temporary, root);
			await this.commit([root], `harness(${input.id}): create work item`);
			return index;
		} catch (error) {
			const recovery: string[] = [];
			try {
				if (delivery && (await this.currentBranch()) === delivery.workingBranch) {
					const tip = await runGit(this.repositoryRoot, ["rev-parse", delivery.workingBranch]);
					// Only remove/reset objects demonstrably created by this transaction.
					if (tip === delivery.createdFromCommit) {
						await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, root)]);
						await rm(root, { recursive: true, force: true });
						if (createdWorkingBranch) {
							await runGit(this.repositoryRoot, ["switch", originalBranch]);
							await runGit(this.repositoryRoot, ["branch", "-D", delivery.workingBranch]);
						}
					} else {
						recovery.push(`preserved ${delivery.workingBranch} at ${tip}; it advanced beyond transaction baseline ${originalHead}`);
						if (createdWorkingBranch) await runGit(this.repositoryRoot, ["switch", originalBranch]);
					}
				} else if ((await this.currentBranch()) !== originalBranch) await runGit(this.repositoryRoot, ["switch", originalBranch]);
			} catch (rollbackError) {
				recovery.push(`branch recovery failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
			}
			if (recovery.length) throw new HarnessError("GIT_OPERATION_FAILED", `Canonical work-item creation failed: ${error instanceof Error ? error.message : String(error)}. Blocking recovery is required: ${recovery.join("; ")}`, { originalBranch, originalHead, workingBranch: delivery?.workingBranch });
			throw error;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async reviseWorkItem(input: { workItemId: string; title?: string; kind?: WorkItemKind; delivery?: WorkItemDelivery; intent?: string; intentSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority: MutationAuthority }): Promise<WorkItemIndex> {
		return this.coordinator.run(`work-item-revise:${input.workItemId}`, () => this.reviseWorkItemUnlocked(input));
	}

	private async reviseWorkItemUnlocked(input: { workItemId: string; title?: string; kind?: WorkItemKind; delivery?: WorkItemDelivery; intent?: string; intentSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority: MutationAuthority }): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		await this.assertWorkingBranch(index);
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
		if (input.delivery !== undefined) {
			validateDelivery(input.delivery);
			if (!index.delivery || stringify(input.delivery) !== stringify(index.delivery)) throw new HarnessError("CAPABILITY_DENIED", "The harness-owned working-branch contract is immutable after work-item creation");
		}
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
		return await this.coordinator.run(`artifact:${input.workItemId}:${input.id}`, () => this.putArtifactUnlocked(input));
	}

	private async putArtifactUnlocked(input: {
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
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		const directory = ARTIFACT_DIRECTORIES[input.type];
		const artifactPath = join(root, directory, `${input.id}.md`);
		ensureInside(root, artifactPath);
		const relativePath = relative(root, artifactPath);
		const existing = index.artifacts.find((artifact) => artifact.id === input.id);
		const amendingMatrix = input.type === "e2e-matrix" && Boolean(existing) && (index.tasks.length > 0 || index.evaluations.length > 0);
		if (amendingMatrix && index.phase !== "planning" && index.state !== "paused") throw new HarnessError("CAPABILITY_DENIED", "E2E matrix amendment is unsafe during active execution; pause the workflow, amend the matrix, then resume");
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
			if (amendingMatrix) {
				// Preserve any recorded attempts. Only untouched runtime gates are
				// regenerated so historical evidence remains immutable and auditable.
				for (const entry of index.evaluations) {
					const evaluation = await this.readEvaluation(input.workItemId, entry.id);
					if (["final-e2e", "final-review"].includes(evaluation.checkpoint ?? "") && evaluation.attempt === 0 && !evaluation.result) {
						await this.updateEvaluationLoop(input.workItemId, evaluation.id, { state: "planned", iteration: 0 }, "planned");
					}
				}
			}
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
		return await this.coordinator.run(`artifact-remove:${workItemId}:${artifactId}`, () => this.removeArtifactUnlocked(workItemId, artifactId, authority));
	}

	private async removeArtifactUnlocked(workItemId: string, artifactId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		if (artifactId === "intent" || artifactId === "outcome") throw new HarnessError("CAPABILITY_DENIED", `Artifact ${artifactId} cannot be deleted`);
		const artifact = index.artifacts.find((candidate) => candidate.id === artifactId);
		if (artifact?.type === "e2e-matrix" && (index.tasks.length > 0 || index.evaluations.length > 0) && index.phase !== "planning") throw new HarnessError("CAPABILITY_DENIED", "E2E matrix removal is only safe before execution; use a controlled paused amendment instead");
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
			await this.commit([path, indexPath], `harness(${workItemId}): remove artifact ${artifactId}`);
			return index;
		} catch (error) {
			await this.restore([{ path, content: previousArtifact }, { path: indexPath, content: previousIndex }]);
			throw error;
		}
	}

	async linkArtifact(workItemId: string, artifactId: string, links: string[], authority?: MutationAuthority, replace = false): Promise<WorkItemIndex> {
		return await this.coordinator.run(`artifact-link:${workItemId}:${artifactId}`, () => this.linkArtifactUnlocked(workItemId, artifactId, links, authority, replace));
	}

	private async linkArtifactUnlocked(workItemId: string, artifactId: string, links: string[], authority?: MutationAuthority, replace = false): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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
		return await this.coordinator.run(`task-define:${input.workItemId}:${input.manifest.id}`, () => this.defineTaskUnlocked(input));
	}

	private async defineTaskUnlocked(input: { workItemId: string; manifest: TaskManifest; brief?: string; acceptance?: string; briefSections?: SemanticSections; acceptanceSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority?: MutationAuthority }): Promise<WorkItemIndex> {
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
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		if (index.tasks.some((task) => task.id === input.manifest.id)) throw new HarnessError("INVALID_ARTIFACT", `Task already exists: ${input.manifest.id}`);
		if (input.manifest.id !== input.manifest.id.toLowerCase()) throw new HarnessError("INVALID_ARTIFACT", "Task id must be lowercase");
		for (const dependency of input.manifest.dependsOn) {
			if (index.phase !== "planning" && !index.tasks.some((task) => task.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task dependency: ${dependency}`);
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
		if (stage && !stage.tasks.includes(input.manifest.id)) stage.tasks.push(input.manifest.id);
		else if (!stage) index.executionStages!.push({ id: stageId, tasks: [input.manifest.id] });
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
		return await this.coordinator.run(`task-revise:${input.workItemId}:${input.manifest.id}`, () => this.reviseTaskUnlocked(input));
	}

	private async reviseTaskUnlocked(input: { workItemId: string; manifest: TaskManifest; brief?: string; acceptance?: string; briefSections?: SemanticSections; acceptanceSections?: SemanticSections; narrativeSchemaVersion?: 1 | 2; authority: MutationAuthority }): Promise<WorkItemIndex> {
		validateId(input.manifest.id, "Task id");
		const narrativeSchemaVersion = input.narrativeSchemaVersion ?? 1;
		const brief = narrativeSchemaVersion === 2 && input.briefSections !== undefined ? renderArtifact("taskBrief", `Task Brief: ${input.manifest.title}`, input.briefSections) : input.brief;
		const acceptance = narrativeSchemaVersion === 2 && input.acceptanceSections !== undefined ? renderArtifact("taskAcceptance", `Task Acceptance: ${input.manifest.title}`, input.acceptanceSections) : input.acceptance;
		if (!brief?.trim() || !acceptance?.trim()) throw new HarnessError("INVALID_ARTIFACT", "Task brief and acceptance must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		const catalog = index.tasks.find((task) => task.id === input.manifest.id);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Task does not exist: ${input.manifest.id}`);
		for (const dependency of input.manifest.dependsOn) if (index.phase !== "planning" && !index.tasks.some((task) => task.id === dependency)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task dependency: ${dependency}`);
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
		const movedFromStageId = currentStage?.id !== stageId ? currentStage?.id : undefined;
		if (currentStage?.id !== stageId) {
			for (const stage of nextStages) stage.tasks = stage.tasks.filter((id) => id !== revised.id);
			const target = nextStages.find((stage) => stage.id === stageId);
			if (target) target.tasks.push(revised.id);
			else nextStages.push({ id: stageId, tasks: [revised.id] });
		}
		const candidateStages = nextStages.filter((stage) => stage.tasks.length > 0 || (index.phase === "planning" && stage.id !== movedFromStageId));
		const candidate = { ...index, executionStages: candidateStages };
		const candidateTasks = await Promise.all(index.tasks.map((entry) => entry.id === revised.id ? revised : this.readTask(input.workItemId, entry.id)));
		if (index.phase !== "planning") {
			const candidateEvaluations = await Promise.all(index.evaluations.map((entry) => this.readEvaluation(input.workItemId, entry.id)));
			validateExecutionTopology(candidate, candidateTasks, candidateEvaluations);
		}
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
		return await this.coordinator.run(`task-remove:${workItemId}:${taskId}`, () => this.removeTaskUnlocked(workItemId, taskId, authority));
	}

	private async removeTaskUnlocked(workItemId: string, taskId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		const manifest = await this.readTask(workItemId, taskId);
		if (manifest.runtime || ["running", "contribution_complete", "reviewing", "accepted", "merge_queued", "merging", "merged", "staged", "integrating", "integrated"].includes(manifest.status)) throw new HarnessError("CAPABILITY_DENIED", `Task ${taskId} has delivery history and must be superseded rather than deleted`);
		if (index.phase !== "planning") for (const task of index.tasks.filter((candidate) => candidate.id !== taskId)) {
			if ((await this.readTask(workItemId, task.id)).dependsOn.includes(taskId)) throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} still depends on ${taskId}`);
		}
		const taskRoot = dirname(join(root, catalog.path));
		const indexPath = join(root, "index.yaml");
		const previousIndex = await readFile(indexPath, "utf8");
		// Backups are private transaction material, never a sibling of tracked
		// artifacts.  If post-commit disposal fails, retaining this harmless copy
		// is safer than rolling back a commit that is already canonical.
		const backup = join(tmpdir(), "pibox-delete-backups", `${workItemId}-${taskId}-${randomUUID()}`);
		index.executionStages ??= index.integrationUnits.map((unit) => ({ id: unit.id, tasks: [...unit.tasks] }));
		index.tasks = index.tasks.filter((task) => task.id !== taskId);
		for (const stage of index.executionStages!) stage.tasks = stage.tasks.filter((id) => id !== taskId);
		index.executionStages = index.executionStages!.filter((stage) => stage.tasks.length > 0);
		advanceContractRevision(index, authority);
		let committed = false;
		try {
			await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
			await rename(taskRoot, backup);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([taskRoot, indexPath], `harness(${workItemId}): remove task ${taskId}`);
			committed = true;
			try { await this.discardBackup(backup); }
			catch (cleanupError) {
				throw new HarnessError("GIT_OPERATION_FAILED", `Task ${taskId} was committed, but private backup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. No rollback was attempted; canonical HEAD/index/worktree are coherent. Retained backup: ${backup}`);
			}
			return index;
		} catch (error) {
			if (committed) throw error;
			try {
				if (await pathExists(backup)) await rename(backup, taskRoot);
				await this.restore([{ path: indexPath, content: previousIndex }]);
				await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, taskRoot)]);
			} catch (rollbackError) {
				throw new HarnessError("GIT_OPERATION_FAILED", `Canonical task removal failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Owned paths: ${relative(this.repositoryRoot, taskRoot)}, ${relative(this.repositoryRoot, indexPath)}. Blocking recovery is required.`);
			}
			throw error;
		}
	}

	async readTaskContract(workItemId: string, taskId: string): Promise<{ manifest: TaskManifest; brief: string; acceptance: string; workItemRevision: number }> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		const taskRoot = dirname(join(root, catalog.path));
		return { manifest: await this.readTask(workItemId, taskId), brief: await readFile(join(taskRoot, "brief.md"), "utf8"), acceptance: await readFile(join(taskRoot, "acceptance.md"), "utf8"), workItemRevision: index.planning.revision };
	}

	async readTask(workItemId: string, taskId: string): Promise<TaskManifest> {
		validateId(taskId, "Task id");
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		const catalog = index.tasks.find((task) => task.id === taskId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown task: ${taskId}`);
		return parseTaskManifest(await readFile(join(root, catalog.path), "utf8"), catalog.path);
	}

	/** Read every task from one validated work-item snapshot without repeating index and branch checks per task. */
	async readTasks(workItemId: string): Promise<TaskManifest[]> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		return Promise.all(index.tasks.map(async (catalog) =>
			parseTaskManifest(await readFile(join(root, catalog.path), "utf8"), catalog.path)));
	}

	/** Return advisory compiler diagnostics while the plan remains editable source. */
	async planningTopologyIssues(workItemId: string): Promise<ExecutionTopologyIssue[]> {
		const index = await this.read(workItemId);
		if (index.phase !== "planning") return [];
		return executionTopologyIssues(index, await this.readTasks(workItemId));
	}

	async updateTask(
		workItemId: string,
		taskId: string,
		update: { status?: TaskStatus; runtime?: TaskManifest["runtime"] },
	): Promise<TaskManifest> {
		return this.coordinator.run(`task-update:${workItemId}:${taskId}`, () => this.updateTaskUnlocked(workItemId, taskId, update));
	}

	private async updateTaskUnlocked(
		workItemId: string,
		taskId: string,
		update: { status?: TaskStatus; runtime?: TaskManifest["runtime"] },
	): Promise<TaskManifest> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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
		const next = stringify(manifest);
		// Normal supervision and reported-agent reconciliation can race to settle the
		// same completed run. The canonical lock makes the second writer observe the
		// first writer's state; treat that identical settlement as success instead of
		// invoking `git commit` with an empty index and pausing the workflow.
		if (next === previous) return manifest;
		try {
			await atomicWriteFile(path, next);
			await this.commit([path], `harness(${workItemId}): update task ${taskId}`);
			return manifest;
		} catch (error) {
			await this.restore([{ path, content: previous }]);
			throw error;
		}
	}

	async activateDraftTasks(workItemId: string): Promise<TaskManifest[]> {
		return await this.coordinator.run(`task-activate:${workItemId}`, () => this.activateDraftTasksUnlocked(workItemId));
	}

	private async activateDraftTasksUnlocked(workItemId: string): Promise<TaskManifest[]> {
		await assertCleanRepository(this.repositoryRoot);
		const item = await this.read(workItemId);
		await this.assertWorkingBranch(item);
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
		return await this.coordinator.run(`task-refresh:${workItemId}`, () => this.refreshReadyTasksUnlocked(workItemId));
	}

	private async refreshReadyTasksUnlocked(workItemId: string): Promise<TaskManifest[]> {
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
		return await this.coordinator.run(`evaluation-define:${workItemId}:${manifest.id}`, () => this.defineEvaluationUnlocked(workItemId, manifest, report, authority));
	}

	private async defineEvaluationUnlocked(workItemId: string, manifest: EvaluationManifest, report = "# Evaluation\n\nPending.\n", authority?: MutationAuthority): Promise<WorkItemIndex> {
		validateId(manifest.id, "Evaluation id");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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
		const evaluation: EvaluationManifest = { ...manifest, loop: manifest.loop ?? { state: "planned", iteration: 0, maxIterations: DEFAULT_REVIEW_FIX_ITERATIONS } };
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
		return await this.coordinator.run(`evaluation-revise:${workItemId}:${manifest.id}`, () => this.reviseEvaluationUnlocked(workItemId, manifest, authority));
	}

	private async reviseEvaluationUnlocked(workItemId: string, manifest: EvaluationManifest, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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
		return await this.coordinator.run(`evaluation-remove:${workItemId}:${evaluationId}`, () => this.removeEvaluationUnlocked(workItemId, evaluationId, authority));
	}

	private async removeEvaluationUnlocked(workItemId: string, evaluationId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		const catalog = index.evaluations.find((evaluation) => evaluation.id === evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${evaluationId}`);
		const current = await this.readEvaluation(workItemId, evaluationId);
		if (current.attempt > 0 || current.result) throw new HarnessError("CAPABILITY_DENIED", `Evaluation ${evaluationId} has recorded evidence and cannot be deleted`);
		const evaluationRoot = dirname(join(root, catalog.path));
		const indexPath = join(root, "index.yaml");
		const previousIndex = await readFile(indexPath, "utf8");
		// Keep deletion backups outside the tracked tree so cleanup failure cannot
		// create a new canonical artifact or an untracked recovery surprise.
		const backup = join(tmpdir(), "pibox-delete-backups", `${workItemId}-${evaluationId}-${randomUUID()}`);
		index.evaluations = index.evaluations.filter((evaluation) => evaluation.id !== evaluationId);
		advanceContractRevision(index, authority);
		let committed = false;
		try {
			await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
			await rename(evaluationRoot, backup);
			await atomicWriteFile(indexPath, stringify(index));
			await this.commit([evaluationRoot, indexPath], `harness(${workItemId}): remove evaluation ${evaluationId}`);
			committed = true;
			try { await this.discardBackup(backup); }
			catch (cleanupError) {
				throw new HarnessError("GIT_OPERATION_FAILED", `Evaluation ${evaluationId} was committed, but private backup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. No rollback was attempted; canonical HEAD/index/worktree are coherent. Retained backup: ${backup}`);
			}
			return index;
		} catch (error) {
			if (committed) throw error;
			try {
				if (await pathExists(backup)) await rename(backup, evaluationRoot);
				await this.restore([{ path: indexPath, content: previousIndex }]);
				await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(this.repositoryRoot, evaluationRoot)]);
			} catch (rollbackError) {
				throw new HarnessError("GIT_OPERATION_FAILED", `Canonical evaluation removal failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Owned paths: ${relative(this.repositoryRoot, evaluationRoot)}, ${relative(this.repositoryRoot, indexPath)}. Blocking recovery is required.`);
			}
			throw error;
		}
	}

	async removeExecutionStage(workItemId: string, stageId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		return await this.coordinator.run(`stage-remove:${workItemId}:${stageId}`, async () => {
			validateId(stageId, "Execution-stage id");
			await assertCleanRepository(this.repositoryRoot);
			const root = this.workItemRoot(workItemId);
			const index = await this.read(workItemId);
			await this.assertWorkingBranch(index);
			assertContractMutable(index);
			if (index.phase !== "planning") throw new HarnessError("CAPABILITY_DENIED", `Execution stage ${stageId} can only be deleted while planning`);
			if (!index.executionStages?.some((stage) => stage.id === stageId)) throw new HarnessError("INVALID_ARTIFACT", `Unknown execution stage: ${stageId}`);
			index.executionStages = index.executionStages.filter((stage) => stage.id !== stageId);
			advanceContractRevision(index, authority);
			const indexPath = join(root, "index.yaml");
			const previous = await readFile(indexPath, "utf8");
			try {
				await atomicWriteFile(indexPath, stringify(index));
				await this.commit([indexPath], `harness(${workItemId}): remove execution stage ${stageId}`);
				return index;
			} catch (error) {
				await this.restore([{ path: indexPath, content: previous }]);
				throw error;
			}
		});
	}

	async putExecutionStage(workItemId: string, stage: NonNullable<WorkItemIndex["executionStages"]>[number], authority: MutationAuthority): Promise<WorkItemIndex> {
		return await this.coordinator.run(`stage-put:${workItemId}:${stage.id}`, () => this.putExecutionStageUnlocked(workItemId, stage, authority));
	}

	private async putExecutionStageUnlocked(workItemId: string, stage: NonNullable<WorkItemIndex["executionStages"]>[number], authority: MutationAuthority): Promise<WorkItemIndex> {
		validateId(stage.id, "Execution-stage id");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		assertContractMutable(index);
		if (stage.mode !== undefined && stage.mode !== "sequential" && stage.mode !== "concurrent") throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} has an invalid execution mode`);
		if (new Set(stage.tasks).size !== stage.tasks.length) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} requires unique tasks`);
		if (index.phase !== "planning" && !stage.tasks.length) throw new HarnessError("INVALID_ARTIFACT", `Execution stage ${stage.id} requires at least one task`);
		for (const taskId of stage.tasks) if (index.phase !== "planning" && !index.tasks.some((task) => task.id === taskId)) throw new HarnessError("INVALID_ARTIFACT", `Unknown task in execution stage ${stage.id}: ${taskId}`);
		validateStageReviewPolicy(stage.review, `Execution stage ${stage.id} review policy`);
		index.executionStages ??= [];
		const originalStages = index.executionStages.map((existing) => ({ ...existing, tasks: [...existing.tasks] }));
		const previousPosition = originalStages.findIndex((existing) => existing.id === stage.id);
		const donorPositions = originalStages.flatMap((existing, position) => existing.tasks.some((taskId) => stage.tasks.includes(taskId)) ? [position] : []);
		const anchorPosition = previousPosition >= 0 ? previousPosition : donorPositions.length ? Math.min(...donorPositions) : originalStages.length;
		for (const existing of index.executionStages) if (existing.id !== stage.id) existing.tasks = existing.tasks.filter((id) => !stage.tasks.includes(id));
		index.executionStages = index.executionStages.filter((existing) => existing.tasks.length > 0 && existing.id !== stage.id);
		const retainedBeforeAnchor = originalStages.slice(0, anchorPosition).filter((existing) => existing.id !== stage.id && existing.tasks.some((taskId) => !stage.tasks.includes(taskId))).length;
		const insertion = Math.min(retainedBeforeAnchor, index.executionStages.length);
		index.executionStages.splice(insertion, 0, { ...stage, tasks: [...stage.tasks] });
		const tasks = await Promise.all(index.tasks.map((entry) => this.readTask(workItemId, entry.id)));
		const stageForTask = new Map(index.executionStages.flatMap((entry) => entry.tasks.map((taskId) => [taskId, entry.id] as const)));
		for (const task of tasks) {
			const taskStage = stageForTask.get(task.id);
			if (taskStage) task.assembly.stageId = taskStage;
			else if (index.phase !== "planning") throw new HarnessError("INVALID_ARTIFACT", `Task ${task.id} is not assigned to an execution stage`);
		}
		if (index.phase !== "planning") validateExecutionTopology(index, tasks);
		advanceContractRevision(index, authority);
		const indexPath = join(root, "index.yaml");
		const taskPaths = new Map(index.tasks.map((entry) => [entry.id, join(root, entry.path)]));
		const previous = [{ path: indexPath, content: await readFile(indexPath, "utf8") }, ...await Promise.all(tasks.map(async (task) => ({ path: taskPaths.get(task.id)!, content: await readFile(taskPaths.get(task.id)!, "utf8") })))];
		try {
			await atomicWriteFile(indexPath, stringify(index));
			for (const task of tasks) await atomicWriteFile(taskPaths.get(task.id)!, stringify(task));
			await this.commit([indexPath, ...taskPaths.values()], `harness(${workItemId}): update execution stage ${stage.id}`);
			return index;
		} catch (error) {
			await this.restore(previous);
			throw error;
		}
	}

	async putIntegrationUnit(workItemId: string, unit: WorkItemIndex["integrationUnits"][number], authority: MutationAuthority): Promise<WorkItemIndex> {
		return await this.coordinator.run(`integration-put:${workItemId}:${unit.id}`, () => this.putIntegrationUnitUnlocked(workItemId, unit, authority));
	}

	private async putIntegrationUnitUnlocked(workItemId: string, unit: WorkItemIndex["integrationUnits"][number], authority: MutationAuthority): Promise<WorkItemIndex> {
		validateId(unit.id, "Integration-unit id");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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
		return await this.coordinator.run(`integration-remove:${workItemId}:${unitId}`, () => this.removeIntegrationUnitUnlocked(workItemId, unitId, authority));
	}

	private async removeIntegrationUnitUnlocked(workItemId: string, unitId: string, authority: MutationAuthority): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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

	async readE2EMatrix(workItemId: string, seen = new Set<string>()): Promise<{ metadata: WorkItemIndex["artifacts"][number]; content: string; workItemRevision: number } | undefined> {
		if (seen.has(workItemId)) throw new HarnessError("INVALID_ARTIFACT", `Amendment baseline cycle detected at ${workItemId}`);
		seen.add(workItemId);
		const item = await this.read(workItemId);
		const matrix = item.artifacts.find((artifact) => artifact.type === "e2e-matrix" && artifact.status === "approved");
		if (matrix) return this.readArtifact(workItemId, matrix.id);
		return item.amendment ? this.readE2EMatrix(item.amendment.baselineWorkItemId, seen) : undefined;
	}

	async validateE2ECaseResults(workItemId: string, evaluation: EvaluationManifest, verdict: "pass" | "fail" | "blocked" | "not_applicable", caseResults: E2ECaseResult[] | undefined): Promise<void> {
		if (evaluation.type !== "e2e" || evaluation.scope.workItem !== workItemId) return;
		const matrix = await this.readE2EMatrix(workItemId);
		if (!matrix) throw new HarnessError("INVALID_HANDOFF", `E2E evaluation ${evaluation.id} requires an approved matrix`);
		const expected = [...matrix.content.matchAll(/^### (E2E-\d{3})\b/gm)].map((match) => match[1]!);
		if (!expected.length) throw new HarnessError("INVALID_ARTIFACT", `Approved E2E matrix for ${workItemId} has no readable case IDs`);
		if (!caseResults?.length) throw new HarnessError("INVALID_HANDOFF", `E2E evaluation ${evaluation.id} must report every matrix case exactly once`);
		const actual = caseResults.map((result) => result.caseId);
		const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
		const missing = expected.filter((id) => !actual.includes(id));
		const unexpected = actual.filter((id) => !expected.includes(id));
		if (duplicates.length || missing.length || unexpected.length || actual.length !== expected.length) throw new HarnessError("INVALID_HANDOFF", `E2E evaluation ${evaluation.id} case results do not match the approved matrix`, { missing, unexpected, duplicates: [...new Set(duplicates)] });
		for (const result of caseResults) {
			if (!["pass", "fail", "blocked"].includes(result.status) || !Array.isArray(result.executedActions) || !Array.isArray(result.observations) || !Array.isArray(result.evidenceRefs)) throw new HarnessError("INVALID_HANDOFF", `E2E evaluation ${evaluation.id} has an invalid result for ${result.caseId}`);
		}
		if (verdict === "not_applicable") throw new HarnessError("INVALID_HANDOFF", `Required E2E evaluation ${evaluation.id} cannot be not_applicable`);
		const incomplete = caseResults.filter((result) => result.status !== "pass");
		if (verdict === "pass" && incomplete.length) throw new HarnessError("INVALID_HANDOFF", `E2E evaluation ${evaluation.id} cannot pass with incomplete cases: ${incomplete.map((result) => `${result.caseId}:${result.status}`).join(", ")}`);
	}

	async ensureFinalEvaluations(workItemId: string, maxIterations = DEFAULT_REVIEW_FIX_ITERATIONS): Promise<EvaluationManifest[]> {
		return await this.coordinator.run(`ensure-final-evaluations:${workItemId}`, () => this.ensureFinalEvaluationsUnlocked(workItemId, maxIterations));
	}

	private async ensureFinalEvaluationsUnlocked(workItemId: string, maxIterations = DEFAULT_REVIEW_FIX_ITERATIONS): Promise<EvaluationManifest[]> {
		const item = await this.read(workItemId);
		if (!await this.readE2EMatrix(workItemId)) throw new HarnessError("INVALID_HANDOFF", `Work item ${workItemId} cannot launch final E2E without an e2e-matrix artifact in the amendment or its completed baseline chain`);
		let existing = await Promise.all(item.evaluations.map((entry) => this.readEvaluation(workItemId, entry.id)));
		for (const stage of item.executionStages ?? []) {
			if (!stageReviewRequired(stage.review)) continue;
			const id = `stage-${stage.id}-review`;
			const durable = existing.find((evaluation) => evaluation.id === id);
			if (durable) {
				if (durable.checkpoint !== "stage-review" || durable.stageId !== stage.id || !durable.required) throw new HarnessError("INVALID_ARTIFACT", `Runtime stage review identity ${id} is occupied by a conflicting evaluation`);
				continue;
			}
			const policy = stage.review?.mode === "skip" ? undefined : stage.review;
			await this.defineRuntimeEvaluation(workItemId, { schemaVersion: 1, id, type: "combined-review", checkpoint: "stage-review", stageId: stage.id, scope: { workItem: workItemId }, status: "planned", required: true, attempt: 0, methods: (stage.checks ?? []).map(verificationCommand), ...(policy?.focus ? { criteria: policy.focus } : {}), loop: { state: "planned", iteration: 0, maxIterations } });
			existing = [...existing, await this.readEvaluation(workItemId, id)];
		}
		let finalReview = existing.find((evaluation) => evaluation.checkpoint === "final-review");
		if (!finalReview) {
			finalReview = { schemaVersion: 1, id: "final-branch-review", type: "combined-review", checkpoint: "final-review", scope: { workItem: workItemId }, status: "planned", required: true, attempt: 0, methods: ["Review the complete executionStartCommit..reviewedCommit feature diff as one integrated change for specification fit, cross-stage correctness, regressions, maintainability, and test coverage."], loop: { state: "planned", iteration: 0, maxIterations } };
			await this.defineRuntimeEvaluation(workItemId, finalReview);
		}
		let finalJourney = existing.find((evaluation) => evaluation.checkpoint === "final-e2e");
		if (!finalJourney) {
			finalJourney = { schemaVersion: 1, id: "final-e2e", type: "e2e", checkpoint: "final-e2e", scope: { workItem: workItemId }, status: "planned", required: true, attempt: 0, methods: ["Execute every case in the approved E2E matrix exactly after whole-branch review passes."], loop: { state: "planned", iteration: 0, maxIterations } };
			await this.defineRuntimeEvaluation(workItemId, finalJourney);
		}
		return Promise.all((await this.read(workItemId)).evaluations.map((entry) => this.readEvaluation(workItemId, entry.id)));
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
		return this.coordinator.run(`evaluation-loop:${workItemId}:${evaluationId}`, () => this.updateEvaluationLoopUnlocked(workItemId, evaluationId, update, status));
	}

	private async updateEvaluationLoopUnlocked(workItemId: string, evaluationId: string, update: Partial<NonNullable<EvaluationManifest["loop"]>>, status?: EvaluationManifest["status"]): Promise<EvaluationManifest> {
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		const catalog = index.evaluations.find((entry) => entry.id === evaluationId);
		if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${evaluationId}`);
		const path = join(root, catalog.path);
		const evaluation = await this.readEvaluation(workItemId, evaluationId);
		const before = stringify(evaluation);
		evaluation.loop = { state: "planned", iteration: 0, maxIterations: DEFAULT_REVIEW_FIX_ITERATIONS, ...evaluation.loop, ...update };
		if (status) evaluation.status = status;
		const after = stringify(evaluation);
		if (after === before) return evaluation;
		await atomicWriteFile(path, after);
		await this.commit([path], `harness(${workItemId}): update review loop ${evaluationId}`);
		return evaluation;
	}

	async readEvaluation(workItemId: string, evaluationId: string): Promise<EvaluationManifest> {
		validateId(evaluationId, "Evaluation id");
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
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
		caseResults?: E2ECaseResult[];
		evidence: Array<{ command?: string; result: string; path?: string; description?: string }>;
		findings?: NonNullable<EvaluationManifest["findings"]>;
		residualRisks?: string[];
		/** Managed evaluator attempt guard; ordinary curated evaluations omit it. */
		expectedAttempt?: number;
		/** Reviewer identity and commit recorded atomically with a managed verdict. */
		reviewContext?: { reviewerAgentId: string; reviewedCommit: string };
	}): Promise<EvaluationManifest> {
		return this.coordinator.run(`evaluation-record:${input.workItemId}:${input.evaluationId}`, () => this.recordEvaluationUnlocked(input));
	}

	private async recordEvaluationUnlocked(input: {
		workItemId: string;
		evaluationId: string;
		verdict: "pass" | "fail" | "blocked" | "not_applicable";
		report: string;
		caseResults?: E2ECaseResult[];
		evidence: Array<{ command?: string; result: string; path?: string; description?: string }>;
		findings?: NonNullable<EvaluationManifest["findings"]>;
		residualRisks?: string[];
		expectedAttempt?: number;
		reviewContext?: { reviewerAgentId: string; reviewedCommit: string };
	}): Promise<EvaluationManifest> {
		if (!input.report.trim()) throw new HarnessError("INVALID_ARTIFACT", "Evaluation report must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const baseHead = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		const root = this.workItemRoot(input.workItemId);
		const index = await this.read(input.workItemId);
		await this.assertWorkingBranch(index);
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
		const evaluation = parse(previousEvaluation) as EvaluationManifest;
		await this.validateE2ECaseResults(input.workItemId, evaluation, input.verdict, input.caseResults);
		if (input.expectedAttempt !== undefined) {
			if (evaluation.attempt > input.expectedAttempt) throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} advanced past expected attempt ${input.expectedAttempt}`);
			if (evaluation.attempt === input.expectedAttempt) {
				if (evaluation.result?.verdict !== input.verdict) throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} attempt ${input.expectedAttempt} has a conflicting verdict`);
				return evaluation;
			}
			if (evaluation.attempt + 1 !== input.expectedAttempt) throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} cannot skip from attempt ${evaluation.attempt} to ${input.expectedAttempt}`);
		}
		const attemptNumber = evaluation.attempt + 1;
		const attemptReportPath = join(evaluationRoot, "attempts", `${String(attemptNumber).padStart(3, "0")}-report.md`);
		const previousIndex = await readFile(indexPath, "utf8");
		const previousReport = await readFile(reportPath, "utf8").catch(() => undefined);
		const previousManifest = await readFile(manifestPath, "utf8").catch(() => undefined);
		// Validate every source before creating or copying canonical evidence. A later
		// invalid path must not leave earlier evidence as untracked rollback debris.
		const evidenceSources = await Promise.all(input.evidence.map((evidence) => evidence?.path ? validateEvidenceSource(this.repositoryRoot, evidence.path) : undefined));
		const evidenceEntries: Array<Record<string, unknown>> = [];
		const attemptPrefix = String(attemptNumber).padStart(3, "0");
		const evidenceDestinations = evidenceSources.map((source, indexValue) => source ? join(evidenceRoot, "files", `${attemptPrefix}-${indexValue + 1}-${basename(source)}`) : undefined);
		await mkdir(join(evidenceRoot, "files"), { recursive: true });
		try {
			for (let indexValue = 0; indexValue < input.evidence.length; indexValue++) {
				const evidence = input.evidence[indexValue];
				if (!evidence) continue;
				const entry: Record<string, unknown> = { result: evidence.result };
				if (evidence.command) entry.command = evidence.command;
				if (evidence.description) entry.description = evidence.description;
				const source = evidenceSources[indexValue];
				const destination = evidenceDestinations[indexValue];
				if (evidence.path && source && destination) {
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
				maxIterations: evaluation.loop?.maxIterations ?? DEFAULT_REVIEW_FIX_ITERATIONS,
				...evaluation.loop,
				...input.reviewContext,
				state: input.verdict === "pass" || input.verdict === "not_applicable" ? "passed" : "awaiting_manager",
			};
			if (input.findings) evaluation.findings = input.findings;
			evaluation.result = {
				verdict: input.verdict,
				report: "report.md",
				evidence: `../../evidence/${input.evaluationId}/manifest.yaml`,
				...(input.caseResults ? { caseResults: input.caseResults } : {}),
			};
			const renderedReport = renderEvaluationReport({
				id: evaluation.id,
				boundary: evaluation.scope,
				...(evaluation.criteria ? { criteria: evaluation.criteria } : {}),
				observations: input.report,
				evidence: input.evidence,
				findings: input.findings ?? [],
				...(input.caseResults ? { caseResults: input.caseResults } : {}),
				verdict: input.verdict,
				...(input.residualRisks ? { residualRisks: input.residualRisks } : {}),
			});
			await atomicWriteFile(reportPath, renderedReport);
			await atomicWriteFile(attemptReportPath, renderedReport);
			await atomicWriteFile(evaluationPath, stringify(evaluation));
			index.phase = "evaluation";
			await atomicWriteFile(indexPath, stringify(index));
			await atomicWriteFile(manifestPath, stringify({ schemaVersion: 1, evaluation: input.evaluationId, recordedAt: new Date().toISOString(), entries: evidenceEntries }));
			await this.commit([evaluationRoot, evidenceRoot, indexPath], `harness(${input.workItemId}): record evaluation ${input.evaluationId}`);
			return evaluation;
		} catch (error) {
			return this.rollbackCanonical(baseHead, [
				{ path: evaluationPath, content: previousEvaluation },
				{ path: indexPath, content: previousIndex },
				{ path: reportPath, ...(previousReport === undefined ? {} : { content: previousReport }) },
				{ path: attemptReportPath },
				{ path: manifestPath, ...(previousManifest === undefined ? {} : { content: previousManifest }) },
				...evidenceDestinations.filter((path): path is string => Boolean(path)).map((path) => ({ path })),
			], error);
		}
	}

	/** Approve a review with explicitly selected, durable residual risks. The manifest and
	 * report are committed together so a failed canonical mutation cannot imply approval. */
	async approveEvaluation(workItemId: string, evaluationId: string, acceptedRisks: Array<{ findingId: string; rationale: string; userConfirmed?: boolean }>): Promise<EvaluationManifest> {
		return this.coordinator.run(`evaluation-approve:${workItemId}:${evaluationId}`, async () => {
			await assertCleanRepository(this.repositoryRoot);
			const baseHead = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			const root = this.workItemRoot(workItemId);
			const index = await this.read(workItemId);
			await this.assertWorkingBranch(index);
			const catalog = index.evaluations.find((entry) => entry.id === evaluationId);
			if (!catalog) throw new HarnessError("INVALID_ARTIFACT", `Unknown evaluation: ${evaluationId}`);
			const evaluationPath = join(root, catalog.path);
			const evaluationRoot = dirname(evaluationPath);
			const indexPath = join(root, "index.yaml");
			const riskPath = join(evaluationRoot, "risk-acceptance.md");
			const previousEvaluation = await readFile(evaluationPath, "utf8");
			const previousIndex = await readFile(indexPath, "utf8");
			const previousRisk = await readFile(riskPath, "utf8").catch(() => undefined);
			const evaluation = parse(previousEvaluation) as EvaluationManifest;
			if (evaluation.attempt < 1) throw new HarnessError("INVALID_HANDOFF", "Approval requires a completed evaluation attempt.");
			if (evaluation.type === "deterministic" && evaluation.status !== "passed") throw new HarnessError("INVALID_HANDOFF", "Deterministic failed checks are hard blockers and cannot be accepted as risk.");
			if (evaluation.checkpoint === "final-e2e" && evaluation.status !== "passed") throw new HarnessError("INVALID_HANDOFF", "An incomplete final E2E matrix cannot be accepted as risk; every required case must pass.");
			const unresolved = (evaluation.findings ?? []).filter((finding) => ["open", "needs_user", "accepted"].includes(finding.status));
			if (!unresolved.length) throw new HarnessError("INVALID_HANDOFF", "Approval with risk requires at least one explicit unresolved finding; request changes or record a passing evaluation instead.");
			const selected = new Map(acceptedRisks.map((risk) => [risk.findingId, risk]));
			const missing = unresolved.filter((finding) => !selected.has(finding.id));
			if (missing.length) throw new HarnessError("INVALID_HANDOFF", `Approval must name every unresolved finding in acceptedRisks: ${missing.map((finding) => finding.id).join(", ")}`);
			for (const risk of acceptedRisks) if (!risk.rationale.trim()) throw new HarnessError("INVALID_HANDOFF", `acceptedRisks rationale is required for ${risk.findingId}`);
			for (const finding of unresolved) {
				const risk = selected.get(finding.id)!;
				if (finding.severity === "critical" && !risk.userConfirmed) throw new HarnessError("USER_DECISION_REQUIRED", `Explicit user confirmation is required before accepting Critical finding ${finding.id}.`);
				finding.status = "accepted";
			}
			const evidenceManifest = await readFile(join(root, "evidence", evaluationId, "manifest.yaml"), "utf8").catch(() => "No deterministic evidence manifest recorded.");
			const history = previousRisk ? `${previousRisk.trim()}\n\n---\n\n` : "";
			const lines = [`# Risk acceptance — ${evaluationId}`, "", `- Work item: ${workItemId}`, `- Evaluation: ${evaluationId}`, `- Reviewed commit: ${evaluation.loop?.reviewedCommit ?? "not recorded"}`, "- Decision: Approved with risk", `- Recorded at: ${new Date().toISOString()}`, "", "## Accepted findings", ""];
			for (const risk of acceptedRisks) {
				const finding = (evaluation.findings ?? []).find((candidate) => candidate.id === risk.findingId);
				if (!finding) throw new HarnessError("INVALID_HANDOFF", `Unknown finding in acceptedRisks: ${risk.findingId}`);
				lines.push(`### ${finding.id} — ${finding.severity}`, `- Location: ${finding.location ?? "Not specified"}`, `- Summary: ${finding.summary}`, `- Manager rationale: ${risk.rationale}`, `- Explicit Critical-risk confirmation: ${finding.severity === "critical" ? (risk.userConfirmed ? "required and received" : "required and missing") : "not required"}`, "");
			}
			lines.push("## Deterministic checks and evidence", "", evidenceManifest.trim(), "", "## Residual risks", "", ...(evaluation.findings ?? []).filter((finding) => finding.status === "accepted").map((finding) => `- ${finding.id}: ${finding.summary}`), "", "## Provenance", "", `Canonical evaluation report: ${catalog.path}`, `Evidence resource: evidence/${evaluationId}/manifest.yaml`);
			const rendered = history + lines.join("\n") + "\n";
			try {
				evaluation.status = "passed";
				evaluation.loop = { iteration: evaluation.loop?.iteration ?? 0, maxIterations: evaluation.loop?.maxIterations ?? DEFAULT_REVIEW_FIX_ITERATIONS, ...evaluation.loop, state: "passed", acceptedRisks };
				evaluation.result = { ...(evaluation.result ?? { verdict: "pass", report: "report.md" }), verdict: "pass", riskAcceptance: "risk-acceptance.md" };
				await atomicWriteFile(riskPath, rendered);
				await atomicWriteFile(evaluationPath, stringify(evaluation));
				await atomicWriteFile(indexPath, stringify(index));
				await this.commit([evaluationRoot, indexPath], `harness(${workItemId}): approve evaluation ${evaluationId} with risk`);
				return evaluation;
			} catch (error) {
				return this.rollbackCanonical(baseHead, [
					{ path: evaluationPath, content: previousEvaluation },
					{ path: indexPath, content: previousIndex },
					{ path: riskPath, ...(previousRisk === undefined ? {} : { content: previousRisk }) },
				], error);
			}
		});
	}

	async completeWorkItem(workItemId: string, outcome?: string, outcomeSections?: { delivered: string[]; deviations?: string[]; residualRisks?: string[]; followUp?: string[] }): Promise<WorkItemIndex> {
		return this.coordinator.run(`complete:${workItemId}`, () => this.completeWorkItemUnlocked(workItemId, outcome, outcomeSections));
	}

	private async completeWorkItemUnlocked(workItemId: string, outcome?: string, outcomeSections?: { delivered: string[]; deviations?: string[]; residualRisks?: string[]; followUp?: string[] }): Promise<WorkItemIndex> {
		if (!outcome?.trim() && !outcomeSections) throw new HarnessError("INVALID_ARTIFACT", "Outcome must not be empty");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(workItemId);
		const index = await this.read(workItemId);
		await this.assertWorkingBranch(index);
		for (const task of index.tasks) {
			if (!["merged", "integrated"].includes((await this.readTask(workItemId, task.id)).status)) {
				throw new HarnessError("INVALID_HANDOFF", `Task is not merged: ${task.id}`);
			}
		}
		const remainingFindings: Array<{ evaluation: string; id: string; severity: string; summary: string; status: string }> = [];
		const verification: string[] = [];
		for (const evaluation of index.evaluations) {
			const manifest = await this.readEvaluation(workItemId, evaluation.id);
			verification.push(`${manifest.id}: ${manifest.status}${manifest.result?.riskAcceptance ? ` (risk report: ${manifest.result.riskAcceptance})` : ""}`);
			if (manifest.required && manifest.status !== "passed" && manifest.status !== "not_applicable") {
				throw new HarnessError("INVALID_HANDOFF", `Required evaluation has not passed: ${evaluation.id}`);
			}
			if (manifest.checkpoint === "final-e2e") await this.validateE2ECaseResults(workItemId, manifest, manifest.result?.verdict ?? "blocked", manifest.result?.caseResults);
			const acceptedRiskIds = new Set(manifest.loop?.acceptedRisks?.map((risk) => risk.findingId) ?? []);
			const hasRiskAcceptance = Boolean(manifest.result?.riskAcceptance);
			if (manifest.findings?.some((finding) => {
				if (!finding.blocking || ["resolved", "rejected", "duplicate"].includes(finding.status)) return false;
				if (finding.status === "accepted") return !hasRiskAcceptance || !acceptedRiskIds.has(finding.id);
				return true;
			})) {
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
		const baseHead = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
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
			return this.rollbackCanonical(baseHead, [
				{ path: indexPath, content: previousIndex },
				{ path: outcomePath, ...(previousOutcome === undefined ? {} : { content: previousOutcome }) },
			], error);
		}
	}

	private async createAmendmentUnlocked(baseline: WorkItemIndex, reason: string): Promise<WorkItemIndex> {
		if (baseline.phase !== "complete") throw new HarnessError("INVALID_ARTIFACT", `Work item ${baseline.id} is not a completed amendment baseline`);
		const rootWorkItemId = baseline.amendment?.rootWorkItemId ?? baseline.id;
		const items = await this.list();
		const root = items.find((item) => item.id === rootWorkItemId) ?? baseline;
		const generation = Math.max(0, ...items.filter((item) => item.amendment?.rootWorkItemId === rootWorkItemId).map((item) => item.amendment!.generation)) + 1;
		const amendmentId = `${rootWorkItemId}-amendment-${generation}`;
		const baselineCommit = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		const baselineIntent = await readFile(join(this.workItemRoot(baseline.id), "intent.md"), "utf8");
		const intent = `# Amendment ${generation} to ${root.title}\n\n## Baseline\n\n- Completed work item: \`work-item:${baseline.id}\`\n- Baseline planning revision: ${baseline.planning.revision}\n- Baseline commit: \`${baselineCommit}\`\n- Amendment reason: ${reason.trim()}\n\nThe completed baseline is immutable. Shape and plan only the incremental amendment in this work item; final verification must cover the resulting whole branch.\n\n## Baseline intent\n\n${baselineIntent.trim()}`;
		return this.createUnlocked({
			id: amendmentId,
			title: `${root.title} — Amendment ${generation}`,
			kind: "change",
			workingBranch: baseline.delivery!.workingBranch,
			intent,
			amendment: { baselineWorkItemId: baseline.id, rootWorkItemId, generation, baselineRevision: baseline.planning.revision, baselineCommit, createdAt: new Date().toISOString(), reason: reason.trim() },
		});
	}

	async transitionWorkItem(id: string, action: "postpone" | "pause" | "resume" | "archive" | "reopen" | "request-user", reason: string): Promise<WorkItemIndex> {
		return this.coordinator.run(`work-item-transition:${id}`, () => this.transitionWorkItemUnlocked(id, action, reason));
	}

	private async transitionWorkItemUnlocked(id: string, action: "postpone" | "pause" | "resume" | "archive" | "reopen" | "request-user", reason: string): Promise<WorkItemIndex> {
		if (!reason.trim()) throw new HarnessError("INVALID_ARTIFACT", "Transition reason is required");
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(id);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8");
		const index = parseWorkItemIndex(previous, indexPath);
		await this.assertWorkingBranch(index);
		if ((index.finalization?.locked || index.phase === "complete") && action !== "reopen") throw immutableWorkItemMutationError(index);
		if (action === "reopen" && index.phase === "complete") return this.createAmendmentUnlocked(index, reason);
		if (action === "postpone") index.state = "postponed";
		if (action === "pause") index.state = "paused";
		if (action === "resume") index.state = "active";
		if (action === "request-user") index.state = "waiting_user";
		if (action === "archive") {
			index.state = "archived";
			index.finalization = { locked: true, reason, lockedAt: new Date().toISOString() };
		}
		if (action === "reopen") {
			delete index.finalization;
			index.state = "active";
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
		return this.coordinator.run(`work-item-submit-planning:${id}`, () => this.submitPlanningUnlocked(id));
	}

	private async submitPlanningUnlocked(id: string): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const index = await this.read(id);
		await this.assertWorkingBranch(index);
		if (index.finalization?.locked || index.phase === "complete") throw immutableWorkItemMutationError(index);
		const tasks = await Promise.all(index.tasks.map((task) => this.readTask(id, task.id)));
		const evaluations = await Promise.all(index.evaluations.map((evaluation) => this.readEvaluation(id, evaluation.id)));
		validateExecutionTopology(index, tasks, evaluations);
		return index;
	}

	async beginExecution(id: string): Promise<WorkItemIndex> {
		return this.coordinator.run(`work-item-begin-execution:${id}`, () => this.beginExecutionUnlocked(id));
	}

	private async beginExecutionUnlocked(id: string): Promise<WorkItemIndex> {
		await assertCleanRepository(this.repositoryRoot);
		const root = this.workItemRoot(id);
		const indexPath = join(root, "index.yaml");
		const previous = await readFile(indexPath, "utf8").catch(() => {
			throw new HarnessError("WORK_ITEM_NOT_FOUND", `Work item does not exist: ${id}`);
		});
		const rawIndex = parse(previous) as { planning?: Record<string, unknown> };
		const hadLegacyApprovalMetadata = ["status", "approvedRevision", "approvedAt", "contractDigest", "approvalAmendments"].some((key) => rawIndex.planning?.[key] !== undefined);
		const index = parseWorkItemIndex(previous, indexPath);
		await this.assertWorkingBranch(index);
		if (index.finalization?.locked || index.phase === "complete") throw immutableWorkItemMutationError(index);
		const tasks = await Promise.all(index.tasks.map((task) => this.readTask(id, task.id)));
		const evaluations = await Promise.all(index.evaluations.map((evaluation) => this.readEvaluation(id, evaluation.id)));
		validateExecutionTopology(index, tasks, evaluations);
		const needsPhase = index.phase === "planning";
		const needsActiveState = index.state !== "active";
		const needsExecutionAnchor = Boolean(index.delivery && !index.delivery.executionStartCommit);
		if (needsPhase) index.phase = "execution";
		if (needsActiveState) index.state = "active";
		if (needsExecutionAnchor) index.delivery!.executionStartCommit = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
		if (needsPhase || needsActiveState || needsExecutionAnchor || hadLegacyApprovalMetadata) {
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

	/** Commit only harness-owned canonical metadata. The explicit path check is the
	 * policy boundary for --no-verify; contributor/source commits never use this helper. */
	private async commit(paths: string[], message: string): Promise<void> {
		await this.coordinator.run(`canonical-commit:${message}`, () => this.coordinator.commitHarness(paths, message));
	}

	/** Cleanup is deliberately outside canonical rollback. */
	private async discardBackup(path: string): Promise<void> {
		await rm(path, { recursive: true, force: true });
	}

	private async rollbackCanonical(baseHead: string, files: Array<{ path: string; content?: string }>, original: unknown): Promise<never> {
		const paths = files.map((file) => relative(this.repositoryRoot, file.path).replaceAll("\\", "/"));
		if (paths.some((path) => !path || path === ".." || path.startsWith("../") || !path.startsWith("agent-artifacts/"))) throw new HarnessError("GIT_OPERATION_FAILED", `Rollback path is outside transaction-owned harness metadata: ${paths.join(", ")}`);
		try {
			const head = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			// A concurrent/external advance is never ours to rewind. A transaction-owned
			// metadata commit may be moved back, but only when every intervening commit
			// is harness-owned and changed only our explicit paths.
			if (head !== baseHead) {
				const subjects = (await runGit(this.repositoryRoot, ["log", "--format=%s", `${baseHead}..HEAD`])).split("\n").filter(Boolean);
				const changed = (await runGit(this.repositoryRoot, ["diff", "--name-only", `${baseHead}..HEAD`])).split("\n").filter(Boolean);
				if (subjects.some((subject) => !subject.startsWith("harness(")) || changed.some((path) => !paths.some((owned) => path === owned || path.startsWith(`${owned}/`)))) throw new Error(`canonical branch advanced outside owned paths (base=${baseHead}, current=${head})`);
				await runGit(this.repositoryRoot, ["reset", "--soft", baseHead]);
			}
			await runGit(this.repositoryRoot, ["reset", "HEAD", "--", ...paths]);
			for (let index = 0; index < files.length; index += 1) {
				const file = files[index]!;
				const ownedPath = paths[index]!;
				if (file.content !== undefined) {
					await atomicWriteFile(file.path, file.content);
					continue;
				}
				const existedAtBase = await runGit(this.repositoryRoot, ["cat-file", "-e", `${baseHead}:${ownedPath}`]).then(() => true, () => false);
				if (existedAtBase) await runGit(this.repositoryRoot, ["restore", "--source", baseHead, "--staged", "--worktree", "--", ownedPath]);
				else await rm(file.path, { recursive: true, force: true });
			}
			const finalHead = await runGit(this.repositoryRoot, ["rev-parse", "HEAD"]);
			const status = await runGit(this.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
			if (finalHead !== baseHead || status) throw new Error(`rollback verification failed (HEAD=${finalHead}, status=${status || "clean"})`);
		} catch (rollbackError) {
			throw new HarnessError("GIT_OPERATION_FAILED", `Canonical mutation failed: ${original instanceof Error ? original.message : String(original)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Owned paths: ${paths.join(", ")}. Blocking recovery is required.`, { baseHead, paths });
		}
		throw original;
	}

	private async restore(files: Array<{ path: string; content: string | undefined }>): Promise<void> {
		for (const file of files) {
			// restore() owns file paths only. Never recursively remove a path that
			// unexpectedly resolves to a pre-existing directory.
			if (file.content === undefined) await rm(file.path, { force: true });
			else await atomicWriteFile(file.path, file.content);
		}
		await runGit(this.repositoryRoot, ["reset", "--quiet", "HEAD", "--", ...files.map((file) => relative(this.repositoryRoot, file.path))]);
		const createdParents = [...new Set(files.filter((file) => file.content === undefined).map((file) => dirname(file.path)))].sort((left, right) => right.length - left.length);
		for (const directory of createdParents) {
			if (basename(directory) === basename(this.artifactRoot)) continue;
			try {
				await rmdir(directory);
			} catch (error) {
				const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
				if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
			}
		}
	}
}
