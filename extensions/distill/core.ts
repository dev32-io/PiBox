import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { atomicWriteFile } from "../workflow/repository.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_BATCH_ARGUMENTS = 256;
const GIT_BATCH_BYTES = 32 * 1024;

export interface GitResult { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[], options?: { stdin?: string }) => Promise<GitResult>;

export interface DistillScopeInput {
	target?: string;
	baseline?: string;
	since?: string;
	until?: string;
	paths?: string[];
	workItems?: string[];
	includeDirty?: boolean;
	includeSession?: boolean;
	focus?: string[];
	sessionIds?: string[];
	sessionStartEntry?: string;
	sessionEndEntry?: string;
	knowledgeProviders?: string[];
	knowledgeProviderFingerprint?: Array<{ id: string; locality: "local" | "remote" }>;
	/** Harness-supplied fingerprints keep mutable local evidence runs distinct. */
	sessionKey?: string;
	externalInputDigest?: string;
}

export interface ResolvedDistillScope {
	schemaVersion: 1;
	runId: string;
	previewToken: string;
	target: { ref: string; commit: string; tipCommit?: string };
	baseline: { source: "explicit" | "time-range" | "workflow-base" | "develop-merge-base" | "main-merge-base" | "root"; ref?: string; commit: string };
	since?: string;
	until?: string;
	paths: string[];
	workItems: string[];
	includeDirty: boolean;
	includeSession: boolean;
	focus: string[];
	sessionIds: string[];
	sessionStartEntry?: string;
	sessionEndEntry?: string;
	knowledgeProviders: string[];
	knowledgeProviderFingerprint: Array<{ id: string; locality: "local" | "remote" }>;
	sessionKey?: string;
	externalInputDigest?: string;
	dirtyDigest?: string;
	commits: string[];
	commitCount: number;
	changedFiles: number;
	dirty: boolean;
	estimatedPartitions: number;
	resolvedAt: string;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
	return JSON.stringify(value);
}

function digest(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
function validPath(value: string): boolean { return Boolean(value) && !value.startsWith("/") && !value.split(/[\\/]/).includes(".."); }
function validWorkItem(value: string): boolean { return /^[a-z0-9][a-z0-9._-]*$/.test(value); }

async function gitRequiredRaw(git: GitRunner, args: string[], stdin?: string): Promise<string> {
	const result = await git(args, stdin === undefined ? undefined : { stdin });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

async function gitRequired(git: GitRunner, args: string[], stdin?: string): Promise<string> {
	return (await gitRequiredRaw(git, args, stdin)).trim();
}

function gitStdin(revisions: string[], paths: string[]): string {
	for (const value of [...revisions, ...paths]) if (/[\r\n\0]/.test(value)) throw new Error("Git revisions and pathspecs must not contain line separators or NUL bytes.");
	return `${[...revisions, ...(paths.length ? ["--", ...paths] : [])].join("\n")}\n`;
}

function argumentBatches(values: string[]): string[][] {
	if (!values.length) return [[]];
	const batches: string[][] = [];
	let batch: string[] = [];
	let bytes = 0;
	for (const value of values) {
		const valueBytes = Buffer.byteLength(value) + 1;
		if (valueBytes > GIT_BATCH_BYTES) throw new Error("A Git revision or pathspec exceeds the safe process argument size.");
		if (batch.length && (batch.length >= GIT_BATCH_ARGUMENTS || bytes + valueBytes > GIT_BATCH_BYTES)) {
			batches.push(batch); batch = []; bytes = 0;
		}
		batch.push(value); bytes += valueBytes;
	}
	if (batch.length) batches.push(batch);
	return batches;
}

async function gitRequiredForPaths(git: GitRunner, args: string[], paths: string[]): Promise<string> {
	return paths.length ? gitRequired(git, [...args, "--stdin"], gitStdin([], paths)) : gitRequired(git, args);
}

async function revListForPaths(git: GitRunner, args: string[], paths: string[]): Promise<string[]> {
	return lines(paths.length ? await gitRequired(git, [...args, "--stdin"], gitStdin([], paths)) : await gitRequired(git, args));
}

async function gitShowSelected(git: GitRunner, args: string[], commits: string[], paths: string[] = []): Promise<string> {
	return gitRequired(git, [...args, "--stdin"], gitStdin(commits, paths));
}

function includedPathspec(pathspec: string): string | undefined {
	if (pathspec.startsWith(":!") || pathspec.startsWith(":^")) return pathspec.slice(2);
	const magic = pathspec.match(/^:\(([^)]*)\)(.*)$/);
	if (!magic) return undefined;
	const attributes = magic[1]!.split(",");
	if (!attributes.includes("exclude") && !attributes.includes("!")) return undefined;
	const included = attributes.filter((attribute) => attribute !== "exclude" && attribute !== "!");
	return included.length ? `:(${included.join(",")})${magic[2]}` : magic[2]!;
}

async function gitStatusForPaths(git: GitRunner, args: string[], paths: string[]): Promise<string> {
	if (!paths.length) return gitRequiredRaw(git, [...args, "--no-renames"]);
	const positive = paths.filter((path) => includedPathspec(path) === undefined);
	const excluded = paths.map(includedPathspec).filter((path): path is string => path !== undefined);
	const records = new Map<string, string>();
	const collect = async (pathspecs: string[], remove: boolean) => {
		for (const batch of argumentBatches(pathspecs)) {
			if (!batch.length) continue;
			const output = await gitRequiredRaw(git, [...args, "--no-renames", "--", ...batch]);
			for (const record of output.split("\0").filter(Boolean)) {
				const path = record.slice(3);
				if (remove) records.delete(path); else records.set(path, record);
			}
		}
	};
	if (positive.length) await collect(positive, false);
	else {
		const output = await gitRequiredRaw(git, [...args, "--no-renames"]);
		for (const record of output.split("\0").filter(Boolean)) records.set(record.slice(3), record);
	}
	await collect(excluded, true);
	return [...records.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, record]) => `${record}\0`).join("");
}

async function resolveCommit(git: GitRunner, ref: string): Promise<string> {
	return gitRequired(git, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function isoDate(value: string | undefined, field: string): string | undefined {
	if (!value) return undefined;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid date or ISO timestamp.`);
	return new Date(timestamp).toISOString();
}

export interface DirtySnapshot {
	status: string;
	trackedDiff: string;
	untracked: Array<{ path: string; sha256: string }>;
	digest: string;
}

export async function currentDirtySnapshot(git: GitRunner, paths: string[]): Promise<DirtySnapshot> {
	const [status, trackedDiff] = await Promise.all([
		gitStatusForPaths(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], paths),
		gitRequiredForPaths(git, ["diff", "--no-ext-diff", "HEAD"], paths),
	]);
	const untrackedPaths = status.split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
	let untracked: Array<{ path: string; sha256: string }> = [];
	if (untrackedPaths.length) {
		const hashes: string[] = [];
		for (const batch of argumentBatches(untrackedPaths)) hashes.push(...lines(await gitRequired(git, ["hash-object", "--no-filters", "--", ...batch])));
		if (hashes.length !== untrackedPaths.length) throw new Error("Unable to hash every untracked file for the dirty preview.");
		untracked = untrackedPaths.map((path, index) => ({ path, sha256: hashes[index]! }));
	}
	return { status, trackedDiff, untracked, digest: digest({ status, trackedDiff, untracked }) };
}

export async function currentDirtyDigest(git: GitRunner, paths: string[]): Promise<string> {
	return (await currentDirtySnapshot(git, paths)).digest;
}

export async function resolveDistillScope(git: GitRunner, input: DistillScopeInput): Promise<ResolvedDistillScope> {
	const targetRef = input.target?.trim() || "HEAD";
	const targetTipCommit = await resolveCommit(git, targetRef);
	let targetCommit = targetTipCommit;
	const since = isoDate(input.since, "since");
	const until = isoDate(input.until, "until");
	if (since && until && Date.parse(since) > Date.parse(until)) throw new Error("since must not be later than until.");
	const paths = [...new Set(input.paths ?? [])].sort();
	if (paths.some((path) => !validPath(path))) throw new Error("paths must be repository-relative.");
	const workItems = [...new Set(input.workItems ?? [])].sort();
	if (workItems.some((id) => !validWorkItem(id))) throw new Error("workItems must be safe identifiers.");
	const sessionIds = [...new Set(input.sessionIds ?? [])].sort();
	if (sessionIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(id))) throw new Error("sessionIds must be safe identifiers.");
	for (const [field, value] of [["sessionStartEntry", input.sessionStartEntry], ["sessionEndEntry", input.sessionEndEntry]] as const) if (value && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(`${field} must be a safe session entry ID.`);
	const knowledgeProviders = [...new Set(input.knowledgeProviders ?? [])].sort();
	if (knowledgeProviders.some((id) => !validWorkItem(id))) throw new Error("knowledgeProviders must be safe identifiers.");
	const providerFingerprint = input.knowledgeProviderFingerprint ?? [];
	if (providerFingerprint.length !== knowledgeProviders.length || providerFingerprint.some((entry) => !knowledgeProviders.includes(entry.id) || !["local", "remote"].includes(entry.locality))) throw new Error("knowledgeProviderFingerprint must bind every selected provider ID and locality.");
	let baseline: ResolvedDistillScope["baseline"];
	let selectedCommits: string[] | undefined;
	if (input.baseline?.trim()) {
		baseline = { source: "explicit", ref: input.baseline.trim(), commit: await resolveCommit(git, input.baseline.trim()) };
	} else if (since || until) {
		const args = ["rev-list", "--reverse", ...(since ? [`--since=${since}`] : []), ...(until ? [`--until=${until}`] : []), targetTipCommit];
		selectedCommits = await revListForPaths(git, args, paths);
		if (selectedCommits.length) {
			const parent = await git(["rev-parse", "--verify", `${selectedCommits[0]}^`]);
			baseline = { source: "time-range", commit: parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE };
		} else baseline = { source: "time-range", commit: targetCommit };
	} else {
		let resolved: ResolvedDistillScope["baseline"] | undefined;
		if (workItems.length) {
			const bases = new Set<string>();
			for (const id of workItems) {
				const index = await git(["show", `${targetTipCommit}:agent-artifacts/${id}/index.yaml`]);
				if (index.code !== 0) throw new Error(`Work item ${id} does not exist at target ${targetRef}.`);
				const value = parse(index.stdout) as any;
				if (typeof value?.delivery?.createdFromCommit === "string") bases.add(value.delivery.createdFromCommit);
			}
			if (bases.size > 1) throw new Error("Selected work items have different recorded bases; provide an explicit baseline.");
			if (bases.size === 1) resolved = { source: "workflow-base", commit: [...bases][0]! };
		}
		for (const ref of ["develop", "main"] as const) {
			if (resolved) break;
			const candidate = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
			if (candidate.code !== 0) continue;
			const mergeBase = await git(["merge-base", targetTipCommit, candidate.stdout.trim()]);
			if (mergeBase.code === 0) { resolved = { source: `${ref}-merge-base`, ref, commit: mergeBase.stdout.trim() }; break; }
		}
		baseline = resolved ?? { source: "root", commit: EMPTY_TREE };
	}
	if (!selectedCommits) {
		selectedCommits = await revListForPaths(git, ["rev-list", "--reverse", `${baseline.commit}..${targetTipCommit}`, ...(since ? [`--since=${since}`] : []), ...(until ? [`--until=${until}`] : [])], paths);
	}
	if ((since || until) && selectedCommits.length) targetCommit = selectedCommits.at(-1)!;
	if (input.includeDirty && targetCommit !== targetTipCommit) throw new Error("includeDirty cannot be combined with a historical time endpoint.");
	const changed = [...new Set(since || until
		? selectedCommits.length ? lines(await gitShowSelected(git, ["show", "--format=", "--name-only"], selectedCommits, paths)) : []
		: lines(await gitRequiredForPaths(git, ["diff", "--name-only", baseline.commit, targetCommit], paths)))];
	const status = await gitStatusForPaths(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], paths);
	const dirty = Boolean(status);
	if (input.includeDirty && targetRef !== "HEAD") throw new Error("includeDirty is supported only when target is HEAD.");
	const dirtyDigest = input.includeDirty ? await currentDirtyDigest(git, paths) : undefined;
	const basis = {
		target: { ref: targetRef, commit: targetCommit, ...(targetCommit !== targetTipCommit ? { tipCommit: targetTipCommit } : {}) }, baseline, ...(since ? { since } : {}), ...(until ? { until } : {}), paths, workItems,
		includeDirty: input.includeDirty === true, includeSession: input.includeSession !== false, focus: input.focus?.length ? [...new Set(input.focus)].sort() : ["knowledge"],
		sessionIds, ...(input.sessionStartEntry ? { sessionStartEntry: input.sessionStartEntry } : {}), ...(input.sessionEndEntry ? { sessionEndEntry: input.sessionEndEntry } : {}), knowledgeProviders,
		knowledgeProviderFingerprint: [...(input.knowledgeProviderFingerprint ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
		...(input.sessionKey && input.includeSession !== false ? { sessionKey: input.sessionKey } : {}), ...(input.externalInputDigest ? { externalInputDigest: input.externalInputDigest } : {}), ...(dirtyDigest ? { dirtyDigest } : {}),
	};
	const runId = `distill-${digest(basis).slice(0, 16)}`;
	return {
		schemaVersion: 1, runId, previewToken: digest({ ...basis, commitCount: selectedCommits.length, changedFiles: changed.length, dirty }),
		...basis, commits: selectedCommits, commitCount: selectedCommits.length, changedFiles: changed.length, dirty,
		estimatedPartitions: Math.max(1, Math.min(24, Math.ceil(changed.length / 30) + workItems.length)), resolvedAt: new Date().toISOString(),
	};
}

export function sanitizeDistillText(value: string): string {
	return value
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE MATERIAL]")
		// Authorization appears in plain headers, shell output, escaped JSON, and
		// nested serialized objects. Redact the whole line rather than trying to
		// preserve nearby diagnostics and risking a bearer credential fragment.
		.replace(/[^\r\n]+/g, (line) => /authorization/i.test(line) ? "[REDACTED AUTHORIZATION]" : line)
		.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
		.replace(/[A-Za-z0-9+/]{160,}={0,2}/g, "[REDACTED LONG ENCODED VALUE]")
		.replace(/\0/g, "");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part && typeof part === "object" && (part as any).type === "text").map((part) => String((part as any).text ?? "")).join("\n");
}

export function renderSessionTranscript(entries: any[]): string {
	const rows: string[] = ["# Current session transcript (sanitized)", ""];
	for (const entry of entries) {
		if (entry?.type === "compaction" || entry?.type === "branch_summary") {
			const summary = sanitizeDistillText(String(entry.summary ?? entry.message?.summary ?? ""));
			if (summary) rows.push(`## ${entry.type.replace("_", " ")} · ${entry.id ?? "unknown"}\n\n${summary}`);
			continue;
		}
		const message = entry?.message ?? (entry?.type === "message" ? entry.message : undefined);
		if (!message || message.role === "custom" || message.role === "thinking") continue;
		const id = typeof entry.id === "string" ? entry.id : "unknown";
		if (message.role === "user") {
			let text = contentText(message.content);
			const distillRequest = text.indexOf("## User distillation request");
			if (text.startsWith("# Distill\n") && distillRequest >= 0) text = text.slice(distillRequest + "## User distillation request".length).trim();
			rows.push(`## user · ${id}\n\n${sanitizeDistillText(text)}`);
		}
		else if (message.role === "assistant") {
			const text = sanitizeDistillText(contentText(message.content));
			const tools = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "toolCall").map((part: any) => part.name).filter(Boolean) : [];
			rows.push(`## assistant · ${id}${tools.length ? ` · tools: ${tools.join(", ")}` : ""}\n\n${text || "[no assistant text]"}`);
		} else if (message.role === "toolResult") {
			rows.push(`## tool · ${id} · ${String(message.toolName ?? "unknown")} · ${message.isError ? "error" : "ok"}\n\n${sanitizeDistillText(contentText(message.content))}`);
		}
	}
	return sanitizeDistillText(rows.join("\n\n"));
}

async function trackedText(git: GitRunner, commit: string, path: string): Promise<string | undefined> {
	const result = await git(["show", `${commit}:${path}`]);
	if (result.code !== 0) return undefined;
	return sanitizeDistillText(result.stdout);
}

async function guidanceSnapshot(git: GitRunner, commit: string): Promise<string> {
	const listed = await git(["ls-tree", "-r", "--name-only", commit]);
	if (listed.code !== 0) return "# Guidance inventory\n\nUnavailable.";
	const paths = lines(listed.stdout).filter((path) => path === "AGENTS.md" || path.endsWith("/AGENTS.md") || /^\.(?:pi|claude)\/rules\/.*\.md$/.test(path));
	const output = ["# Guidance inventory and measured burden", ""];
	for (const path of paths) {
		const text = await trackedText(git, commit, path);
		if (text === undefined) continue;
		output.push(`## ${path}\n\nCharacters: ${text.length}\nEstimated tokens: ${Math.ceil(text.length / 4)}\n\n${text}`);
	}
	return sanitizeDistillText(output.join("\n\n"));
}

async function workflowSnapshot(git: GitRunner, commit: string, workItems: string[]): Promise<string> {
	const output = ["# Managed workflow artifacts", ""];
	for (const id of workItems) {
		const prefix = `agent-artifacts/${id}`;
		const listed = await git(["ls-tree", "-r", "--name-only", commit, "--", prefix]);
		const priority = (path: string) => /(?:outcome\.md|story\.ya?ml|plan\.ya?ml)$/.test(path) ? 0 : /\/tasks\/[^/]+\.ya?ml$/.test(path) ? 1 : 2;
		const paths = lines(listed.stdout).filter((path) => /\.(?:md|ya?ml|json)$/.test(path)).sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
		output.push(`## ${id}\n\nFiles: ${paths.length}`);
		for (const path of paths) {
			const text = await trackedText(git, commit, path);
			if (text !== undefined) output.push(`### ${path}\n\n${text}`);
		}
	}
	return sanitizeDistillText(output.join("\n\n"));
}

export interface CollectOptions {
	repositoryRoot: string;
	privateRoot: string;
	scope: ResolvedDistillScope;
	entries: any[];
	dirtySnapshot?: DirtySnapshot;
}

export async function collectDistillRun(git: GitRunner, options: CollectOptions): Promise<{ runRoot: string; files: string[]; reused: boolean }> {
	const runRoot = join(options.privateRoot, "distill", options.scope.runId);
	const completePath = await assertSafeArtifactPath(options.privateRoot, options.scope.runId, "manifest.json");
	if (existsSync(completePath)) {
		const manifest = JSON.parse(await readFile(completePath, "utf8")) as { scopeDigest?: string; files?: Array<{ path?: string; sha256?: string }> };
		if (manifest.scopeDigest !== options.scope.previewToken || !Array.isArray(manifest.files)) throw new Error("Existing distillation manifest does not match the confirmed scope.");
		for (const file of manifest.files) {
			if (typeof file.path !== "string" || typeof file.sha256 !== "string") throw new Error("Existing distillation manifest is invalid.");
			const path = await assertSafeArtifactPath(options.privateRoot, options.scope.runId, file.path);
			const content = await readFile(path, "utf8").catch(() => undefined);
			if (content === undefined || createHash("sha256").update(content).digest("hex") !== file.sha256) throw new Error(`Existing distillation evidence changed after collection: ${file.path}`);
		}
		return { runRoot, files: [...manifest.files.map((file) => file.path!), "manifest.json"], reused: true };
	}
	await mkdir(runRoot, { recursive: true, mode: 0o700 });
	const dateScoped = Boolean(options.scope.since || options.scope.until);
	const [log, nameStatus, stat, diff] = dateScoped
		? options.scope.commits.length ? await Promise.all([
			gitShowSelected(git, ["show", "--no-patch", "--date=iso-strict", "--format=%H%x09%ad%x09%s"], options.scope.commits),
			gitShowSelected(git, ["show", "--format=", "--name-status"], options.scope.commits, options.scope.paths),
			gitShowSelected(git, ["show", "--format=commit %H", "--stat"], options.scope.commits, options.scope.paths),
			gitShowSelected(git, ["show", "--format=commit %H", "--no-ext-diff", "--unified=3"], options.scope.commits, options.scope.paths),
		]) : ["", "", "", ""]
		: await Promise.all([
			options.scope.commits.length ? gitShowSelected(git, ["show", "--no-patch", "--date=iso-strict", "--format=%H%x09%ad%x09%s"], options.scope.commits) : Promise.resolve(""),
			gitRequiredForPaths(git, ["diff", "--name-status", options.scope.baseline.commit, options.scope.target.commit], options.scope.paths),
			gitRequiredForPaths(git, ["diff", "--stat", options.scope.baseline.commit, options.scope.target.commit], options.scope.paths),
			gitRequiredForPaths(git, ["diff", "--no-ext-diff", "--unified=3", options.scope.baseline.commit, options.scope.target.commit], options.scope.paths),
		]);
	let dirty = "";
	let dirtyStatus = "";
	let untracked = "";
	if (options.scope.includeDirty) {
		if (!options.dirtySnapshot || options.dirtySnapshot.digest !== options.scope.dirtyDigest) throw new Error("Dirty evidence does not match the confirmed preview.");
		dirtyStatus = options.dirtySnapshot.status.split("\0").filter(Boolean).join("\n");
		dirty = options.dirtySnapshot.trackedDiff;
		untracked = options.dirtySnapshot.untracked.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n");
	}
	const changes = sanitizeDistillText(`# Change evidence\n\n## Commits\n\n${log || "None"}\n\n## Name status\n\n${nameStatus || "None"}\n\n## Statistics\n\n${stat || "None"}${dirtyStatus ? `\n\n## Dirty checkout status\n\n${dirtyStatus}` : ""}${untracked ? `\n\n## Untracked content hashes\n\n${untracked}\n\nUntracked content is not copied into distillation artifacts.` : ""}${dirty ? `\n\n## Dirty tracked diff\n\n\`\`\`diff\n${dirty}\n\`\`\`` : ""}\n\n## ${dateScoped ? "Selected commit patches" : "Endpoint diff"}\n\n\`\`\`diff\n${diff}\n\`\`\``);
	const transcript = options.scope.includeSession ? renderSessionTranscript(options.entries) : "# Current session transcript\n\nExcluded by scope.";
	const [guidance, workflow] = await Promise.all([
		guidanceSnapshot(git, options.scope.target.commit),
		workflowSnapshot(git, options.scope.target.commit, options.scope.workItems),
	]);
	const artifacts: Record<string, string> = {
		"scope.json": `${JSON.stringify(options.scope, null, 2)}\n`, "changes.md": changes, "transcript.md": transcript,
		"guidance.md": guidance, "workflow.md": workflow,
	};
	for (const [name, content] of Object.entries(artifacts)) await atomicWriteFile(join(runRoot, name), content, 0o600);
	const manifest = {
		schemaVersion: 1, runId: options.scope.runId, createdAt: new Date().toISOString(), scopeDigest: options.scope.previewToken,
		files: Object.entries(artifacts).map(([path, content]) => ({ path, chars: content.length, sha256: createHash("sha256").update(content).digest("hex") })),
	};
	await atomicWriteFile(completePath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
	return { runRoot, files: [...Object.keys(artifacts), "manifest.json"], reused: false };
}

export function safeArtifactPath(privateRoot: string, runId: string, relativePath: string): string {
	if (!/^distill-[a-f0-9]{16}$/.test(runId)) throw new Error("Invalid distill run ID.");
	if (!validPath(relativePath)) throw new Error("Artifact path must stay inside the distill run.");
	const root = resolve(privateRoot, "distill", runId);
	const path = resolve(root, relativePath);
	if (relative(root, path).startsWith("..")) throw new Error("Artifact path must stay inside the distill run.");
	return path;
}

export async function assertSafeArtifactPath(privateRoot: string, runId: string, relativePath: string): Promise<string> {
	const path = safeArtifactPath(privateRoot, runId, relativePath);
	for (const ancestor of [resolve(privateRoot), resolve(privateRoot, "distill")]) {
		try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("Distillation storage ancestors must not be symbolic links."); }
		catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	}
	const root = resolve(privateRoot, "distill", runId);
	const relativeParent = relative(root, dirname(path));
	try { if ((await lstat(root)).isSymbolicLink()) throw new Error("Distillation run root must not be a symbolic link."); }
	catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	let current = root;
	for (const segment of relativeParent.split(/[\\/]/).filter(Boolean)) {
		current = resolve(current, segment);
		try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Distillation artifact parents must not be symbolic links."); }
		catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	}
	try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Distillation artifacts must not be symbolic links."); }
	catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	return path;
}

export interface InstructionAssessment {
	eligibleForDiscussion: boolean;
	reasons: string[];
	burden: {
		targetPath: string;
		insertionText: string;
		currentCharacters: number;
		addedCharacters: number;
		resultingCharacters: number;
		currentEstimatedTokens: number;
		addedEstimatedTokens: number;
		resultingEstimatedTokens: number;
		percentageIncrease: number;
	};
}

const IMPERATIVE = /^(?:always\b|never\b|do not\b|must\b|use\b|keep\b|preserve\b|treat\b|require\b|run\b|avoid\b|ensure\b|validate\b|reject\b|prefer\b|store\b|load\b|read\b|write\b|update\b|remove\b|scope\b|route\b|derive\b|verify\b)/i;
const EXAMPLE = /(?:\bfor example\b|\be\.g\.|\bsuch as\b|\bexample\s*:|```|`[^`]+`\s*(?:is|means))/i;
const EXPLANATION = /(?:\bbecause\b|\bsince\b|\bso that\b|\btherefore\b|\bnoting\b|\bgiven that\b|\bas a result\b|\bthis (?:prevents|allows|means|ensures)\b|\bin order to\b)/i;
const DESCRIPTIVE_CLAUSE = /(?:\bwhile\b|\bwhereas\b|\balthough\b|\bwhich\b|\b(?:production|the (?:repository|system|service|application|code|data))\s+(?:is|are|has|contains|stores|uses|runs)\b)/i;

export function assessInstruction(input: { candidate: string; destination: "agents" | "rule"; targetPath: string; targetContent: string; paths?: string[]; evidencePaths: string[]; criticality: string; nonObviousness: string; repeatedApplicability: string; failureImpact: string }): InstructionAssessment {
	const candidate = input.candidate.replace(/\s+/g, " ").trim();
	const reasons: string[] = [];
	if (!candidate) reasons.push("candidate is empty");
	const clauses = candidate.split(/[.!?;]+|\b(?:and|or)\b/i).map((clause) => clause.trim()).filter(Boolean);
	if (!clauses.length || clauses.some((clause) => !IMPERATIVE.test(clause))) reasons.push("every sentence must be phrased as a pure imperative instruction");
	if (/[:,;()]/.test(candidate)) reasons.push("compound or parenthetical clauses are not allowed in instruction items");
	if (EXAMPLE.test(candidate)) reasons.push("examples are forbidden in AGENTS.md and rule files");
	if (EXPLANATION.test(candidate)) reasons.push("instruction contains explanatory prose");
	if (DESCRIPTIVE_CLAUSE.test(candidate)) reasons.push("instruction contains a descriptive subordinate clause");
	if (candidate.split(/[.!?]+/).filter(Boolean).length > 1) reasons.push("instruction must be exactly one concise imperative sentence");
	if (input.destination === "agents" && (input.paths?.length ?? 0) > 0) reasons.push("path-scoped instructions belong in a rule, not AGENTS.md");
	if (input.destination === "rule" && !(input.paths?.length ?? 0)) reasons.push("a rule requires an explicit path scope");
	if (!input.evidencePaths.length) reasons.push("instruction promotion requires repository evidence paths");
	const justifications = [["criticality", input.criticality, /(?:critical|security|privacy|production|irreversible|corrupt|data loss|safety|compatib)/i], ["non-obviousness", input.nonObviousness, /(?:non-obvious|not obvious|hidden|counterintuitive|easy to miss|similar|resembles|model may)/i], ["repeated applicability", input.repeatedApplicability, /(?:repeat|recur|across|every|multiple|frequent)/i], ["failure impact", input.failureImpact, /(?:security|privacy|production|irreversible|corrupt|data loss|break|incident|outage|expose)/i]] as const;
	const genericJustification = /(?:\bstatement\b|\bjustification\b|\bdeterministic gate\b|\bsufficiently long\b|\bcriteria\b|\bmultiple frequent context\b)/i;
	for (const [name, value, signal] of justifications) {
		const words = value.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
		const diversity = words.length ? new Set(words).size / words.length : 0;
		if (value.trim().length < 40 || !signal.test(value) || genericJustification.test(value) || diversity < 0.6) reasons.push(`${name} justification lacks required substantive risk/applicability signals`);
	}
	if (!/(?:task|workflow|change|release|deployment|integration|operation|maintenance|review|implementation|module|path)/i.test(input.repeatedApplicability)) reasons.push("repeated applicability must identify concrete recurring work scopes");
	const contextBody = input.targetContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	const insertionText = `${contextBody && !contextBody.endsWith("\n") ? "\n" : ""}- ${candidate}\n`;
	const currentCharacters = contextBody.length;
	const addedCharacters = insertionText.length;
	const resultingCharacters = currentCharacters + addedCharacters;
	return {
		eligibleForDiscussion: reasons.length === 0, reasons,
		burden: {
			targetPath: input.targetPath, insertionText, currentCharacters, addedCharacters, resultingCharacters,
			currentEstimatedTokens: Math.ceil(currentCharacters / 4), addedEstimatedTokens: Math.ceil(addedCharacters / 4),
			resultingEstimatedTokens: Math.ceil(resultingCharacters / 4),
			percentageIncrease: currentCharacters ? Number((addedCharacters / currentCharacters * 100).toFixed(2)) : 100,
		},
	};
}

export async function listDistillRuns(privateRoot: string): Promise<string[]> {
	try { return (await readdir(join(privateRoot, "distill"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse(); }
	catch { return []; }
}
