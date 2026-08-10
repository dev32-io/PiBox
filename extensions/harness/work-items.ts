import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, runGit } from "./repository.js";
import type { WorkItemIndex, WorkItemKind } from "./types.js";

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
