import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, discoverRepository, isGitPathIgnored, readTextIfExists } from "../workflow/repository.js";
import { WorkflowMutex } from "../workflow-runtime/storage.js";
import {
	MAX_ARTIFACT_CHARS, assessInstruction, assertSafeArtifactPath, collectDistillRun, currentDirtySnapshot, listDistillRuns, resolveDistillScope, sanitizeDistillText, subagentInputDigest,
	type DistillScopeInput, type GitRunner, type ResolvedDistillScope,
} from "./core.js";
import {
	DISTILL_KNOWLEDGE_DISCOVERY_EVENT, type DistillKnowledgeDiscovery, type DistillKnowledgeItem, type DistillKnowledgeProvider,
} from "./provider.js";

const SCOPE_FIELDS = {
	target: Type.Optional(Type.String({ maxLength: 240 })),
	baseline: Type.Optional(Type.String({ maxLength: 240 })),
	since: Type.Optional(Type.String({ maxLength: 100 })),
	until: Type.Optional(Type.String({ maxLength: 100 })),
	paths: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
	workItems: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 20 })),
	includeDirty: Type.Optional(Type.Boolean()),
	includeSession: Type.Optional(Type.Boolean()),
	sessionIds: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
	sessionStartEntry: Type.Optional(Type.String({ maxLength: 200 })),
	sessionEndEntry: Type.Optional(Type.String({ maxLength: 200 })),
	knowledgeProviders: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 8 })),
	rawSubagents: Type.Optional(StringEnum(["none", "exceptional", "all"] as const)),
	focus: Type.Optional(Type.Array(StringEnum(["knowledge", "architecture", "failure-modes", "instructions", "contradictions", "process", "release-summary", "current-state"] as const), { maxItems: 8 })),
};

const result = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DISTILL_SKILL = parseFrontmatter(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/distill/SKILL.md"), "utf8")).body.trim();

function activeEntryBranch(entries: any[]): any[] {
	const byId = new Map(entries.filter((entry) => typeof entry?.id === "string").map((entry) => [entry.id, entry]));
	const branch: any[] = [];
	let current: any;
	for (let index = entries.length - 1; index >= 0; index--) if (typeof entries[index]?.id === "string") { current = entries[index]; break; }
	while (current) { branch.push(current); current = current.parentId ? byId.get(current.parentId) : undefined; }
	return branch.reverse();
}

function sliceEntryRange(entries: any[], scope: ResolvedDistillScope): any[] {
	let start = 0;
	let end = entries.length;
	if (scope.sessionStartEntry) {
		const index = entries.findIndex((entry) => entry?.id === scope.sessionStartEntry);
		if (index < 0) throw new Error(`Session start entry was not found in the selected sessions: ${scope.sessionStartEntry}`);
		start = index;
	}
	if (scope.sessionEndEntry) {
		const index = entries.findIndex((entry) => entry?.id === scope.sessionEndEntry);
		if (index < 0) throw new Error(`Session end entry was not found in the selected sessions: ${scope.sessionEndEntry}`);
		end = index + 1;
	}
	if (start >= end) throw new Error("Session entry range is reversed or empty.");
	return entries.slice(start, end);
}

export async function selectedSessionEntries(ctx: ExtensionContext, scope: ResolvedDistillScope, options: { includeCurrent?: boolean; applyRange?: boolean } = {}): Promise<any[]> {
	if (!scope.includeSession || !scope.sessionIds.length) return [];
	const currentId = sessionId(ctx);
	const manager = ctx.sessionManager as any;
	const currentEntries: any[] = manager.getBranch?.() ?? manager.buildContextEntries?.() ?? manager.getEntries?.() ?? [];
	const sessionFile = manager.getSessionFile?.() as string | undefined;
	const directory = sessionFile ? dirname(sessionFile) : undefined;
	const output: any[] = [];
	for (const id of scope.sessionIds) {
		if (id === currentId) {
			if (options.includeCurrent !== false) {
				const prefix = `${currentId}:`;
				const anchor = scope.sessionKey?.startsWith(prefix) ? scope.sessionKey.slice(prefix.length) : undefined;
				const anchorIndex = anchor && anchor !== "root" ? currentEntries.findIndex((entry) => entry?.id === anchor) : currentEntries.length - 1;
				if (anchor && anchor !== "root" && anchorIndex < 0) throw new Error("The previewed current-session leaf is no longer on the active branch.");
				output.push({ type: "branch_summary", id: `session-${id}`, summary: `Session ${id}` }, ...currentEntries.slice(0, Math.max(0, anchorIndex + 1)));
			}
			continue;
		}
		if (!directory) throw new Error(`Cannot locate persisted session ${id} from this headless session.`);
		let matched: any[] | undefined;
		for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".jsonl")).slice(0, 2_000)) {
			const path = resolve(directory, name);
			const info = await stat(path);
			if (info.size > 10_000_000) continue;
			const handle = await open(path, "r");
			const buffer = Buffer.alloc(Math.min(4_096, info.size));
			try { await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
			let header: any;
			try { header = JSON.parse(buffer.toString("utf8").split("\n", 1)[0] ?? ""); } catch { continue; }
			if (header?.type !== "session" || header?.id !== id) continue;
			const raw = await readFile(path, "utf8");
			const records = raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
			matched = activeEntryBranch(records.slice(1));
			break;
		}
		if (!matched) throw new Error(`Selected session was not found in this repository's Pi session directory: ${id}`);
		output.push({ type: "branch_summary", id: `session-${id}`, summary: `Session ${id}` }, ...matched);
	}
	return options.applyRange === false ? output : sliceEntryRange(output, scope);
}

function combinedInputDigest(reportDigest: string, historicalEntries: any[]): string {
	return createHash("sha256").update(JSON.stringify({ reportDigest, historicalEntries })).digest("hex");
}

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId?.() ?? "unknown-session";
}

function sessionScopeKey(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager as any;
	return `${sessionId(ctx)}:${manager.getLeafId?.() ?? "root"}`;
}

async function assertCollectedRun(privateRoot: string, runId: string): Promise<void> {
	const manifest = await assertSafeArtifactPath(privateRoot, runId, "manifest.json");
	if (!existsSync(manifest)) throw new Error(`Distillation run is not collected: ${runId}`);
}

function instructionTarget(root: string, path: string): string {
	if (!path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) throw new Error("targetPath must be repository-relative.");
	if (!(basename(path) === "AGENTS.md" || /^\.(?:pi|claude)\/rules\/.+\.md$/.test(path))) throw new Error("Instruction targets are limited to AGENTS.md and .pi/.claude rule files.");
	const target = resolve(root, path);
	if (relative(root, target).startsWith("..")) throw new Error("targetPath must stay inside the repository.");
	return target;
}

export default function distillExtension(pi: ExtensionAPI): void {
	const previews = new Map<string, { scope: ResolvedDistillScope; repositoryId: string; repositoryRoot: string }>();
	const providers = new Map<string, DistillKnowledgeProvider>();

	const repository = async (ctx: ExtensionContext) => discoverRepository(ctx.cwd);
	const gitFor = (pi: ExtensionAPI, cwd: string): GitRunner => async (args) => {
		const response = await pi.exec("git", args, { cwd, timeout: 20_000 });
		const cap = 2_000_000;
		return {
			code: response.code,
			stdout: response.stdout.length > cap ? `${response.stdout.slice(0, cap)}\n… [git output cap reached]` : response.stdout,
			stderr: response.stderr.length > 20_000 ? `${response.stderr.slice(0, 20_000)}\n… [stderr cap reached]` : response.stderr,
		};
	};
	const discoverProviders = () => {
		providers.clear();
		pi.events.emit(DISTILL_KNOWLEDGE_DISCOVERY_EVENT, {
			register(provider: DistillKnowledgeProvider) {
				if (!ID.test(provider.id)) throw new Error(`Invalid distillation knowledge provider ID: ${provider.id}`);
				if (!["local", "remote"].includes(provider.locality) || !provider.description?.trim()) throw new Error(`Invalid distillation knowledge provider metadata: ${provider.id}`);
				if (!providers.has(provider.id)) {
					if (providers.size >= 16) throw new Error("At most 16 distillation knowledge providers may register.");
					providers.set(provider.id, provider);
				}
			},
		} satisfies DistillKnowledgeDiscovery);
	};

	pi.registerTool({
		name: "distill_prepare", label: "Prepare Distillation Scope",
		description: "Resolve and preview a deterministic Git/workflow/session distillation scope without writing artifacts or changing Git. The returned previewToken must be confirmed by the user before collection.",
		promptSnippet: "Resolve a read-only distillation scope for user review",
		parameters: Type.Object(SCOPE_FIELDS, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await repository(ctx);
			discoverProviders();
			const requestedProviders = params.knowledgeProviders ?? [...providers.values()].filter((provider) => provider.locality === "local").map((provider) => provider.id);
			for (const id of requestedProviders) if (!providers.has(id)) throw new Error(`Unknown distillation knowledge provider: ${id}`);
			const requestedSessions = params.includeSession === false ? [] : params.sessionIds?.length ? params.sessionIds : params.workItems?.length ? [] : [sessionId(ctx)];
			const reportDigest = await subagentInputDigest(identity.privateRoot, requestedSessions, params.workItems ?? []);
			const knowledgeProviderFingerprint = requestedProviders.map((id) => ({ id, locality: providers.get(id)!.locality }));
			const scopeInput: DistillScopeInput = {
				...(params as DistillScopeInput), sessionIds: requestedSessions, knowledgeProviders: requestedProviders, knowledgeProviderFingerprint,
				...(params.includeSession !== false && requestedSessions.includes(sessionId(ctx)) ? { sessionKey: sessionScopeKey(ctx) } : {}),
			};
			let scope = await resolveDistillScope(gitFor(pi, identity.root), { ...scopeInput, externalInputDigest: reportDigest });
			const historicalEntries = await selectedSessionEntries(ctx, scope, { includeCurrent: false, applyRange: false });
			scope = await resolveDistillScope(gitFor(pi, identity.root), { ...scopeInput, externalInputDigest: combinedInputDigest(reportDigest, historicalEntries) });
			if (scope.sessionStartEntry || scope.sessionEndEntry) await selectedSessionEntries(ctx, scope);
			previews.set(scope.previewToken, { scope, repositoryId: identity.id, repositoryRoot: identity.root });
			const preview = {
				runId: scope.runId, previewToken: scope.previewToken, target: scope.target, baseline: scope.baseline,
				time: { since: scope.since ?? null, until: scope.until ?? null }, paths: scope.paths, workItems: scope.workItems,
				commitCount: scope.commitCount, changedFiles: scope.changedFiles, dirty: scope.dirty, includeDirty: scope.includeDirty,
				includeSession: scope.includeSession, sessionIds: scope.sessionIds, sessionEntries: { start: scope.sessionStartEntry ?? null, end: scope.sessionEndEntry ?? null },
				rawSubagents: scope.rawSubagents, focus: scope.focus, knowledgeProviders: scope.knowledgeProviders,
				availableKnowledgeProviders: [...providers.values()].map((provider) => ({ id: provider.id, locality: provider.locality, description: provider.description })), estimatedPartitions: scope.estimatedPartitions,
			};
			return result(`Distillation scope resolved. Review it with the user before collection.\n${JSON.stringify(preview, null, 2)}`, preview);
		},
	});

	pi.registerTool({
		name: "distill_collect", label: "Collect Distillation Evidence",
		description: "Collect a previously previewed and user-confirmed distillation scope into ignored .pibox/distill artifacts. This is read-only with respect to source, Git, guidance, and knowledge stores.",
		promptSnippet: "Collect confirmed read-only distillation evidence",
		parameters: Type.Object({ previewToken: Type.String({ minLength: 64, maxLength: 64 }) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const preview = previews.get(params.previewToken);
			if (!preview) throw new Error("Unknown or expired distillation preview. Run distill_prepare again.");
			const identity = await repository(ctx);
			if (identity.id !== preview.repositoryId || identity.root !== preview.repositoryRoot) throw new Error("Distillation preview belongs to another repository. Run distill_prepare again.");
			const scope = preview.scope;
			if (!await isGitPathIgnored(identity.root, ".pibox")) throw new Error("Refusing to collect distillation artifacts because .pibox is not ignored.");
			const git = gitFor(pi, identity.root);
			await assertSafeArtifactPath(identity.privateRoot, scope.runId, "manifest.json");
			const mutex = new WorkflowMutex(join(identity.privateRoot, "distill", scope.runId));
			const collected = await mutex.run(`distill:${scope.previewToken}`, async () => {
				const currentTarget = await git(["rev-parse", "--verify", `${scope.target.ref}^{commit}`]);
				if (currentTarget.code !== 0 || currentTarget.stdout.trim() !== (scope.target.tipCommit ?? scope.target.commit)) throw new Error("The target ref moved after preview. Run distill_prepare again.");
				const currentReportDigest = await subagentInputDigest(identity.privateRoot, scope.sessionIds, scope.workItems);
				const historicalEntries = await selectedSessionEntries(ctx, scope, { includeCurrent: false, applyRange: false });
				if (combinedInputDigest(currentReportDigest, historicalEntries) !== scope.externalInputDigest) throw new Error("Workflow, subagent, or historical session evidence changed after preview. Run distill_prepare again.");
				const dirtySnapshot = scope.includeDirty ? await currentDirtySnapshot(git, scope.paths) : undefined;
				if (dirtySnapshot && dirtySnapshot.digest !== scope.dirtyDigest) throw new Error("The dirty checkout changed after preview. Run distill_prepare again.");
				return collectDistillRun(git, {
					repositoryRoot: identity.root, privateRoot: identity.privateRoot, scope,
					entries: await selectedSessionEntries(ctx, scope), ...(dirtySnapshot ? { dirtySnapshot } : {}),
				});
			});
			return result(`${collected.reused ? "Reused" : "Collected"} distillation ${scope.runId}.\nArtifacts: ${collected.files.join(", ")}`, { runId: scope.runId, ...collected, scope });
		},
	});

	pi.registerTool({
		name: "distill_read", label: "Read Distillation Artifact",
		description: "List local distillation runs or read a bounded slice of one ignored run artifact.",
		parameters: Type.Object({ runId: Type.Optional(Type.String()), path: Type.Optional(Type.String()), sourcePath: Type.Optional(Type.String({ maxLength: 500 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30_000 })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await repository(ctx);
			if (!params.runId) {
				const runs = await listDistillRuns(identity.privateRoot);
				return result(runs.length ? runs.join("\n") : "No local distillation runs.", { runs });
			}
			if (Boolean(params.path) === Boolean(params.sourcePath)) throw new Error("Provide exactly one of path or sourcePath when runId is provided.");
			await assertCollectedRun(identity.privateRoot, params.runId);
			let content: string;
			let selectedPath: string;
			if (params.sourcePath) {
				if (params.sourcePath.startsWith("/") || params.sourcePath.split(/[\\/]/).includes("..")) throw new Error("sourcePath must be repository-relative.");
				const scopePath = await assertSafeArtifactPath(identity.privateRoot, params.runId, "scope.json");
				const scope = JSON.parse(await readFile(scopePath, "utf8")) as ResolvedDistillScope;
				const object = `${scope.target.commit}:${params.sourcePath}`;
				const size = await gitFor(pi, identity.root)(["cat-file", "-s", object]);
				if (size.code !== 0) throw new Error(`Target source not found: ${params.sourcePath}`);
				if (Number(size.stdout.trim()) > MAX_ARTIFACT_CHARS) throw new Error(`Target source exceeds the ${MAX_ARTIFACT_CHARS}-character read budget.`);
				const source = await gitFor(pi, identity.root)(["show", object]);
				if (source.code !== 0) throw new Error(`Target source not found: ${params.sourcePath}`);
				if (source.stdout.includes("\0")) throw new Error("Target source is binary and cannot be distilled as text.");
				content = sanitizeDistillText(source.stdout, MAX_ARTIFACT_CHARS);
				selectedPath = `source:${params.sourcePath}`;
			} else {
				const path = await assertSafeArtifactPath(identity.privateRoot, params.runId, params.path!);
				const artifact = await readTextIfExists(path);
				if (artifact === undefined) throw new Error(`Distillation artifact not found: ${params.path}`);
				content = artifact;
				selectedPath = params.path!;
			}
			const offset = params.offset ?? 0;
			const limit = params.limit ?? 12_000;
			const slice = content.slice(offset, offset + limit);
			return result(slice || "[empty slice]", { runId: params.runId, path: selectedPath, offset, returned: slice.length, total: content.length, nextOffset: offset + slice.length < content.length ? offset + slice.length : null });
		},
	});

	pi.registerTool({
		name: "distill_record", label: "Record Distillation Analysis",
		description: "Persist an analyst report, synthesis, knowledge comparison, or user decision inside an existing ignored distillation run. This never edits source guidance or memory.",
		parameters: Type.Object({
			runId: Type.String(), category: StringEnum(["finding", "synthesis", "comparison", "decision"] as const),
			id: Type.Optional(Type.String({ maxLength: 128 })), content: Type.String({ minLength: 1, maxLength: MAX_ARTIFACT_CHARS }),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await repository(ctx);
			await assertCollectedRun(identity.privateRoot, params.runId);
			if (params.category !== "synthesis" && !params.id) throw new Error(`id is required for ${params.category} records.`);
			const id = params.id ?? "synthesis";
			if (!ID.test(id)) throw new Error("id must be a safe lowercase identifier.");
			const relativePath = params.category === "finding" ? `findings/${id}.md` : params.category === "comparison" ? `comparisons/${id}.md` : params.category === "decision" ? `decisions/${id}.md` : "synthesis.md";
			const path = await assertSafeArtifactPath(identity.privateRoot, params.runId, relativePath);
			if (!existsSync(dirname(path))) await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true, mode: 0o700 }));
			await atomicWriteFile(path, sanitizeDistillText(params.content, MAX_ARTIFACT_CHARS), 0o600);
			return result(`Recorded ${relativePath} for ${params.runId}.`, { runId: params.runId, path: relativePath, chars: params.content.length });
		},
	});

	pi.registerTool({
		name: "distill_compare", label: "Compare Distilled Knowledge",
		description: "Search optional registered knowledge providers for existing items related to proposed findings. Works without a memory provider and never mutates knowledge.",
		parameters: Type.Object({ runId: Type.String(), claims: Type.Array(Type.Object({ id: Type.String({ maxLength: 128 }), query: Type.String({ minLength: 3, maxLength: 1_000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }), limitPerProvider: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			const identity = await repository(ctx);
			await assertCollectedRun(identity.privateRoot, params.runId);
			const scopePath = await assertSafeArtifactPath(identity.privateRoot, params.runId, "scope.json");
			const scope = JSON.parse(await readFile(scopePath, "utf8")) as ResolvedDistillScope;
			discoverProviders();
			const confirmedLocality = new Map(scope.knowledgeProviderFingerprint.map((entry) => [entry.id, entry.locality]));
			const selectedProviders = scope.knowledgeProviders.map((id) => ({ id, provider: providers.get(id) })).filter((entry): entry is { id: string; provider: DistillKnowledgeProvider } => Boolean(entry.provider) && entry.provider!.locality === confirmedLocality.get(entry.id)).map((entry) => entry.provider);
			const missingProviders = scope.knowledgeProviders.filter((id) => !providers.has(id) || providers.get(id)!.locality !== confirmedLocality.get(id));
			const comparisons: Array<{ claimId: string; providers: Record<string, DistillKnowledgeItem[]> }> = [];
			let remainingItems = 30;
			let remainingCharacters = MAX_ARTIFACT_CHARS - 8_000;
			let truncated = false;
			for (const claim of params.claims) {
				if (!ID.test(claim.id)) throw new Error(`Invalid claim id: ${claim.id}`);
				const found: Record<string, DistillKnowledgeItem[]> = {};
				for (const provider of selectedProviders) {
					if (remainingItems <= 0 || remainingCharacters <= 0) { truncated = true; break; }
					try {
						const requestLimit = Math.min(params.limitPerProvider ?? 5, remainingItems);
						const items = await provider.search(claim.query, { cwd: identity.root, limit: requestLimit, ...(signal ? { signal } : {}) });
						found[provider.id] = [];
						for (const item of items.slice(0, requestLimit)) {
							const normalized: DistillKnowledgeItem = {
								provider: provider.id, id: sanitizeDistillText(String(item.id), 160), kind: sanitizeDistillText(String(item.kind), 80),
								content: sanitizeDistillText(String(item.content), Math.min(4_000, remainingCharacters)),
								evidence: item.evidence.filter((path) => typeof path === "string").slice(0, 20).map((path) => sanitizeDistillText(path, 500)),
								...(item.metadata ? { metadata: Object.fromEntries(Object.entries(item.metadata).filter(([key, value]) => ["score", "status", "verified_at", "verified_commit", "type", "source"].includes(key) && ["string", "number", "boolean"].includes(typeof value))) } : {}),
							};
							const size = JSON.stringify(normalized).length;
							if (size > remainingCharacters) { truncated = true; break; }
							found[provider.id]!.push(normalized);
							remainingCharacters -= size;
							remainingItems--;
						}
					} catch (error) {
						const item = { provider: provider.id, id: "provider-error", kind: "error", content: sanitizeDistillText(error instanceof Error ? error.message : String(error), 1_000), evidence: [] };
						found[provider.id] = [item]; remainingCharacters -= JSON.stringify(item).length; remainingItems--;
					}
				}
				comparisons.push({ claimId: claim.id, providers: found });
				if (remainingItems <= 0 || remainingCharacters <= 0) { truncated = true; break; }
			}
			const payload = { generatedAt: new Date().toISOString(), selectedProviders: scope.knowledgeProviders, missingProviders, truncated, comparisons };
			const serialized = `${JSON.stringify(payload, null, 2)}\n`;
			if (serialized.length > MAX_ARTIFACT_CHARS) throw new Error("Knowledge comparison exceeded its aggregate artifact budget.");
			const path = await assertSafeArtifactPath(identity.privateRoot, params.runId, "comparisons/providers.json");
			await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true, mode: 0o700 }));
			await atomicWriteFile(path, serialized, 0o600);
			return result(selectedProviders.length ? JSON.stringify(payload, null, 2) : "No selected knowledge providers are available. Continue with repository guidance and prior distillation artifacts.", { providers: selectedProviders.map(({ id, locality }) => ({ id, locality })), missingProviders, truncated, comparisons, path: "comparisons/providers.json" });
		},
	});

	pi.registerTool({
		name: "distill_instruction_check", label: "Measure Instruction Promotion",
		description: "Apply the exceptional AGENTS.md/rule admission gate and measure exact context burden. It rejects examples and explanatory prose, but remains advisory and never edits guidance.",
		parameters: Type.Object({
			candidate: Type.String({ minLength: 1, maxLength: 2_000 }), destination: StringEnum(["agents", "rule"] as const), targetPath: Type.String({ maxLength: 500 }),
			paths: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })), evidencePaths: Type.Array(Type.String({ maxLength: 500 }), { minItems: 1, maxItems: 20 }), criticality: Type.String({ maxLength: 2_000 }), nonObviousness: Type.String({ maxLength: 2_000 }), repeatedApplicability: Type.String({ maxLength: 2_000 }), failureImpact: Type.String({ maxLength: 2_000 }),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const identity = await repository(ctx);
			const target = instructionTarget(identity.root, params.targetPath);
			for (const path of params.evidencePaths) {
				if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) throw new Error(`Instruction evidence must be an existing repository-relative file: ${path}`);
				let info;
				try { info = await stat(resolve(identity.root, path)); } catch { throw new Error(`Instruction evidence must be an existing repository-relative file: ${path}`); }
				if (!info.isFile()) throw new Error(`Instruction evidence must be a file, not a directory: ${path}`);
			}
			const tracked = await pi.exec("git", ["ls-files", "--error-unmatch", "--", ...params.evidencePaths], { cwd: identity.root, timeout: 5_000 });
			const trackedPaths = new Set(tracked.stdout.split("\n").filter(Boolean));
			if (tracked.code !== 0 || params.evidencePaths.some((path) => !trackedPaths.has(path))) throw new Error("Instruction evidence paths must be exact tracked repository files.");
			const targetContent = await readTextIfExists(target) ?? "";
			const assessment = assessInstruction({ ...params, targetContent });
			return result(`${assessment.eligibleForDiscussion ? "Eligible for exceptional user discussion; not approved." : "Rejected by deterministic instruction gate."}\n${JSON.stringify(assessment, null, 2)}`, assessment);
		},
	});

	pi.registerCommand("distill", {
		description: "Distill an explicit code, time, workflow, or session range into user-reviewed knowledge proposals",
		handler: async (args) => {
			const request = args.trim() || "Distill the current branch and session for durable technical knowledge.";
			pi.sendUserMessage(`${DISTILL_SKILL}\n\n## User distillation request\n\n${request}`);
		},
	});

	pi.on("session_start", () => { previews.clear(); discoverProviders(); });
	pi.on("session_shutdown", () => { previews.clear(); providers.clear(); });
}
