import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loopbackMem0Url, Mem0Client, type MemoryRecord } from "./client.js";
import { deriveRepositoryScope, type RepositoryScope } from "./scope.js";
import { getService, operateService } from "../service-adapter/registry.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";
import { DISTILL_KNOWLEDGE_DISCOVERY_EVENT, type DistillKnowledgeDiscovery } from "../distill/provider.js";

const SCHEMA_VERSION = 1;
const USER_ID = "pibox";
const DEFAULT_RECALL_LIMIT = 5;
const AUTO_RECALL_CANDIDATES = 10;
const AUTO_RECALL_LIMIT = 5;
const AUTO_RECALL_MIN_TOP_SCORE = 0.64;
const AUTO_RECALL_MIN_SCORE = 0.62;
const AUTO_RECALL_SCORE_WINDOW = 0.1;
const AUTO_RECALL_MAX_QUERY_CHARS = 3_000;
const AUTO_RECALL_MAX_CONTEXT_CHARS = 4_000;
const MAX_RECALL_LIMIT = 10;
const MAX_AUDIT_CANDIDATES = 50;
const MAX_EVIDENCE_PATHS = 20;

export interface RecallSelection {
	selected: MemoryRecord[];
	skipped: Array<{ id: string; reason: string }>;
}

export interface RecallDiagnostics {
	status: "idle" | "pending" | "unavailable" | "empty" | "injected" | "error";
	at: string;
	query?: string;
	repository?: string;
	candidateCount?: number;
	selected?: Array<{ id: string; score?: number; type?: string }>;
	skipped?: Array<{ id: string; reason: string }>;
	injectedCharacters?: number;
	error?: string;
	subagent?: string;
}

const parameters = Type.Object({
	action: StringEnum(["status", "remember", "recall", "list", "get", "update", "delete", "history", "audit"] as const),
	query: Type.Optional(Type.String()),
	memory: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	type: Type.Optional(Type.String()),
	source: Type.Optional(Type.String()),
	evidencePaths: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_EVIDENCE_PATHS })),
	expiresAt: Type.Optional(Type.String({ description: "Optional YYYY-MM-DD expiration date." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RECALL_LIMIT })),
});

function client(): Mem0Client {
	const keyPath = join(homedir(), ".pi", "pibox", "services", "mem0", "api-key");
	const apiKey = process.env.PIBOX_MEM0_API_KEY ?? (existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : undefined);
	return new Mem0Client({
		baseUrl: loopbackMem0Url(process.env.PIBOX_MEM0_URL ?? "http://127.0.0.1:6001"),
		...(apiKey ? { apiKey } : {}),
	});
}

async function ensureRunning(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	if (await client().health(signal)) return;
	const service = getService("mem0");
	if (!service) throw new Error("Mem0 is unavailable and its PiBox service is not registered.");
	await operateService("mem0", "start", { ctx, ...(signal ? { signal } : {}) });
}

function validateEvidencePaths(scope: RepositoryScope, paths: string[] | undefined): void {
	if ((paths?.length ?? 0) > MAX_EVIDENCE_PATHS) throw new Error(`At most ${MAX_EVIDENCE_PATHS} evidence paths are allowed.`);
	for (const path of paths ?? []) {
		const fromRoot = relative(scope.root, resolve(scope.root, path));
		if (!path || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
			throw new Error(`Evidence path must stay inside the repository: ${path}`);
		}
	}
}

function memoryMetadata(scope: RepositoryScope, input: { type?: string; source?: string; evidencePaths?: string[] }): Record<string, unknown> {
	return {
		repo_id: scope.repoId,
		type: input.type ?? "project",
		source: input.source ?? "user-curated",
		evidence_paths: input.evidencePaths ?? [],
		verified_commit: scope.commit ?? null,
		verified_at: new Date().toISOString(),
		status: "active",
		schema_version: SCHEMA_VERSION,
	};
}

function formatRecords(records: MemoryRecord[]): string {
	if (records.length === 0) return "No repository memories found.";
	return records.map((record) => `- ${record.id}: ${record.memory}`).join("\n");
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (Array.isArray(message?.content)) return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
	return "";
}

export function buildRecallQuery(prompt: string, messages: any[]): string {
	const recent = messages
		.filter((message) => message?.role === "user")
		.map(messageText)
		.map((text) => text.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.slice(-3);
	const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
	if (normalizedPrompt && recent.at(-1) !== normalizedPrompt) recent.push(normalizedPrompt);
	return recent.join("\n\n").slice(-AUTO_RECALL_MAX_QUERY_CHARS);
}

function activeMemory(record: MemoryRecord, now = Date.now()): boolean {
	if (record.metadata?.status !== "active") return false;
	const expiration = record.expiration_date ?? (typeof record.metadata?.expires_at === "string" ? record.metadata.expires_at : undefined);
	return !expiration || Date.parse(expiration) > now;
}

export function selectRecallCandidates(records: MemoryRecord[]): RecallSelection {
	const skipped: Array<{ id: string; reason: string }> = [];
	const active = records.filter((record) => {
		if (activeMemory(record)) return true;
		skipped.push({ id: record.id, reason: "inactive or expired" });
		return false;
	}).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const topScore = active[0]?.score ?? 0;
	if (topScore < AUTO_RECALL_MIN_TOP_SCORE) {
		for (const record of active) skipped.push({ id: record.id, reason: `top score ${topScore.toFixed(3)} is below ${AUTO_RECALL_MIN_TOP_SCORE}` });
		return { selected: [], skipped };
	}
	const cutoff = Math.max(AUTO_RECALL_MIN_SCORE, topScore - AUTO_RECALL_SCORE_WINDOW);
	const selected: MemoryRecord[] = [];
	for (const record of active) {
		if ((record.score ?? 0) < cutoff) skipped.push({ id: record.id, reason: `score ${(record.score ?? 0).toFixed(3)} is below ${cutoff.toFixed(3)}` });
		else if (selected.length >= AUTO_RECALL_LIMIT) skipped.push({ id: record.id, reason: `selection capped at ${AUTO_RECALL_LIMIT}` });
		else selected.push(record);
	}
	return { selected, skipped };
}

export function formatRecallContext(records: MemoryRecord[]): { content: string; included: MemoryRecord[]; skipped: Array<{ id: string; reason: string }> } {
	const header = "Retrieved repository memory for the current task follows. Use it only when relevant, cite its memory ID when it materially affects a decision, and verify claims against current source. Current source and reviewed contracts outrank memory.";
	let content = header;
	const included: MemoryRecord[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	for (const record of records) {
		const type = typeof record.metadata?.type === "string" ? record.metadata.type : "project";
		const evidence = Array.isArray(record.metadata?.evidence_paths)
			? record.metadata.evidence_paths.filter((path): path is string => typeof path === "string").slice(0, 3)
			: [];
		const qualifiers = [`id=${record.id}`, `type=${type}`, ...(typeof record.score === "number" ? [`score=${record.score.toFixed(3)}`] : [])].join(" ");
		const memory = record.memory.length > 900 ? `${record.memory.slice(0, 899)}…` : record.memory;
		const row = `\n- [${qualifiers}] ${memory}\n  Evidence: ${evidence.join(", ")}`;
		if (content.length + row.length > AUTO_RECALL_MAX_CONTEXT_CHARS) {
			skipped.push({ id: record.id, reason: `context budget capped at ${AUTO_RECALL_MAX_CONTEXT_CHARS} characters` });
			continue;
		}
		content += row;
		included.push(record);
	}
	return { content, included, skipped };
}

async function deterministicAudit(pi: ExtensionAPI, records: MemoryRecord[], scope: RepositoryScope): Promise<Array<{ id: string; memory: string; reasons: string[]; metadata?: Record<string, unknown> }>> {
	const now = Date.now();
	const staleBefore = now - 90 * 24 * 60 * 60 * 1_000;
	const findings: Array<{ id: string; memory: string; reasons: string[]; metadata?: Record<string, unknown> }> = [];
	for (const record of records.slice(0, MAX_AUDIT_CANDIDATES)) {
		const metadata = record.metadata ?? {};
		const reasons: string[] = [];
		if (metadata.repo_id !== scope.repoId) reasons.push("repository namespace mismatch");
		if (typeof metadata.source !== "string" || !metadata.source) reasons.push("missing source");
		if (metadata.status !== "active") reasons.push(`status is ${String(metadata.status ?? "missing")}`);
		const verifiedAt = typeof metadata.verified_at === "string" ? Date.parse(metadata.verified_at) : Number.NaN;
		if (!Number.isFinite(verifiedAt)) reasons.push("missing verification date");
		else if (verifiedAt < staleBefore) reasons.push("verification older than 90 days");
		const verifiedCommit = typeof metadata.verified_commit === "string" ? metadata.verified_commit : undefined;
		if (!verifiedCommit) reasons.push("missing verified commit");
		const allEvidence = Array.isArray(metadata.evidence_paths) ? metadata.evidence_paths.filter((path): path is string => typeof path === "string") : [];
		if (allEvidence.length > MAX_EVIDENCE_PATHS) reasons.push(`too many evidence paths (${allEvidence.length}; maximum ${MAX_EVIDENCE_PATHS})`);
		const evidence = allEvidence.slice(0, MAX_EVIDENCE_PATHS);
		if (evidence.length === 0) reasons.push("no evidence paths");
		for (const path of evidence) if (!existsSync(resolve(scope.root, path))) reasons.push(`missing evidence: ${path}`);
		if (verifiedCommit) {
			const commit = await pi.exec("git", ["cat-file", "-e", `${verifiedCommit}^{commit}`], { cwd: scope.root, timeout: 3_000 });
			if (commit.code !== 0) reasons.push("verified commit is unavailable");
			else if (evidence.length > 0) {
				const changed = await pi.exec("git", ["diff", "--quiet", verifiedCommit, "--", ...evidence], { cwd: scope.root, timeout: 5_000 });
				if (changed.code === 1) reasons.push("evidence changed since verification");
				else if (changed.code !== 0) reasons.push("could not compare evidence with verified commit");
			}
		}
		const expiration = record.expiration_date ?? (typeof metadata.expires_at === "string" ? metadata.expires_at : undefined);
		if (expiration && Date.parse(expiration) <= now) reasons.push("expired");
		if (reasons.length) findings.push({ id: record.id, memory: record.memory, reasons, ...(record.metadata ? { metadata: record.metadata } : {}) });
	}
	return findings;
}

export default function memoryAdapter(pi: ExtensionAPI): void {
	const scopes = new Map<string, Promise<Omit<RepositoryScope, "commit">>>();
	let recallRun: { prompt: string; cwd: string; promise?: Promise<string | undefined> } | undefined;
	let recallDiagnostics: RecallDiagnostics = { status: "idle", at: new Date().toISOString() };
	const getScope = async (cwd: string): Promise<RepositoryScope> => {
		const key = resolve(cwd);
		let pending = scopes.get(key);
		if (!pending) {
			pending = deriveRepositoryScope(pi, key).then(({ repoId, root }) => ({ repoId, root }));
			scopes.set(key, pending);
		}
		const stable = await pending;
		const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: stable.root, timeout: 3_000 });
		return { ...stable, ...(head.code === 0 ? { commit: head.stdout.trim() } : {}) };
	};

	const retrieveForRun = async (prompt: string, messages: any[], cwd: string): Promise<string | undefined> => {
		const query = buildRecallQuery(prompt, messages);
		const at = new Date().toISOString();
		const subagent = process.env.PIBOX_SUBAGENT_ID;
		if (!query) {
			recallDiagnostics = { status: "empty", at, ...(subagent ? { subagent } : {}) };
			return undefined;
		}
		try {
			const mem0 = client();
			if (!await mem0.health()) {
				recallDiagnostics = { status: "unavailable", at, query, ...(subagent ? { subagent } : {}) };
				return undefined;
			}
			const repository = await getScope(cwd);
			const candidates = await mem0.search(query, USER_ID, repository.repoId, AUTO_RECALL_CANDIDATES);
			const selection = selectRecallCandidates(candidates);
			const selected: MemoryRecord[] = [];
			for (const record of selection.selected) {
				const evidence = Array.isArray(record.metadata?.evidence_paths)
					? record.metadata.evidence_paths.filter((path): path is string => typeof path === "string")
					: [];
				if (!evidence.length) {
					selection.skipped.push({ id: record.id, reason: "automatic recall requires repository evidence" });
					continue;
				}
				if (evidence.length > MAX_EVIDENCE_PATHS) {
					selection.skipped.push({ id: record.id, reason: `evidence exceeds the ${MAX_EVIDENCE_PATHS}-path limit` });
					continue;
				}
				const verifiedCommit = typeof record.metadata?.verified_commit === "string" ? record.metadata.verified_commit : undefined;
				if (!verifiedCommit) {
					selection.skipped.push({ id: record.id, reason: "automatic recall requires a verified commit" });
					continue;
				}
				const missing = evidence.find((path) => !existsSync(resolve(repository.root, path)));
				if (missing) {
					selection.skipped.push({ id: record.id, reason: `missing evidence: ${missing}` });
					continue;
				}
				const tracked = await pi.exec("git", ["ls-tree", "--name-only", verifiedCommit, "--", ...evidence], { cwd: repository.root, timeout: 3_000 });
				const trackedPaths = new Set(tracked.stdout.split("\n").filter(Boolean));
				const unverified = tracked.code === 0 ? evidence.find((path) => !trackedPaths.has(path)) : evidence[0];
				if (unverified) {
					selection.skipped.push({ id: record.id, reason: `evidence was not tracked at verified commit: ${unverified}` });
					continue;
				}
				const changed = await pi.exec("git", ["diff", "--quiet", verifiedCommit, "--", ...evidence], { cwd: repository.root, timeout: 5_000 });
				if (changed.code !== 0) {
					selection.skipped.push({ id: record.id, reason: changed.code === 1 ? "evidence changed since verification" : "evidence freshness could not be verified" });
					continue;
				}
				selected.push(record);
			}
			if (!selected.length) {
				recallDiagnostics = { status: "empty", at, query, repository: repository.repoId, candidateCount: candidates.length, selected: [], skipped: selection.skipped, ...(subagent ? { subagent } : {}) };
				return undefined;
			}
			const packed = formatRecallContext(selected);
			selection.skipped.push(...packed.skipped);
			if (!packed.included.length) {
				recallDiagnostics = { status: "empty", at, query, repository: repository.repoId, candidateCount: candidates.length, selected: [], skipped: selection.skipped, ...(subagent ? { subagent } : {}) };
				return undefined;
			}
			recallDiagnostics = {
				status: "injected", at, query, repository: repository.repoId, candidateCount: candidates.length,
				selected: packed.included.map((record) => ({ id: record.id, ...(typeof record.score === "number" ? { score: record.score } : {}), ...(typeof record.metadata?.type === "string" ? { type: record.metadata.type } : {}) })),
				skipped: selection.skipped, injectedCharacters: packed.content.length, ...(subagent ? { subagent } : {}),
			};
			return packed.content;
		} catch (error) {
			recallDiagnostics = { status: "error", at, query, error: error instanceof Error ? error.message : String(error), ...(subagent ? { subagent } : {}) };
			return undefined;
		}
	};

	const execute = async (input: {
		action: "status" | "remember" | "recall" | "list" | "get" | "update" | "delete" | "history" | "audit";
		query?: string;
		memory?: string;
		id?: string;
		type?: string;
		source?: string;
		evidencePaths?: string[];
		expiresAt?: string;
		limit?: number;
	}, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ text: string; details: unknown }> => {
		const repository = await getScope(ctx.cwd);
		if (input.action === "status") {
			const healthy = await client().health(signal);
			return { text: `Mem0 is ${healthy ? "running" : "stopped or unhealthy"} for repository ${repository.repoId}.`, details: { healthy, repository } };
		}
		await ensureRunning(ctx, signal);
		const mem0 = client();
		if (input.action === "remember") {
			if (!input.memory?.trim()) throw new Error("memory is required.");
			validateEvidencePaths(repository, input.evidencePaths);
			const metadata = memoryMetadata(repository, input);
			const records = await mem0.add(input.memory.trim(), USER_ID, metadata, input.expiresAt, signal);
			return { text: records.length ? `Stored memory ${records.map(({ id }) => id).join(", ")}.` : "Stored the memory.", details: { records, metadata } };
		}
		if (input.action === "recall") {
			if (!input.query?.trim()) throw new Error("query is required.");
			const records = await mem0.search(input.query.trim(), USER_ID, repository.repoId, input.limit ?? DEFAULT_RECALL_LIMIT, signal);
			return { text: formatRecords(records), details: { records, repository } };
		}
		if (input.action === "list" || input.action === "audit") {
			const records = await mem0.list(USER_ID, repository.repoId, { limit: input.action === "audit" ? MAX_AUDIT_CANDIDATES + 1 : 1_000, ...(signal ? { signal } : {}) });
			if (input.action === "list") return { text: formatRecords(records), details: { records, repository } };
			const ordered = [...records].sort((left, right) => (right.updated_at ?? right.created_at ?? right.id).localeCompare(left.updated_at ?? left.created_at ?? left.id));
			const findings = await deterministicAudit(pi, ordered, repository);
			return { text: findings.length ? `${findings.length} memories require semantic review. No memories were changed.` : "No deterministic memory-audit findings. No memories were changed.", details: { findings, checked: Math.min(ordered.length, MAX_AUDIT_CANDIDATES), fetched: ordered.length, bounded: ordered.length > MAX_AUDIT_CANDIDATES, repository } };
		}
		if (!input.id) throw new Error("id is required.");
		if (input.action === "get") {
			const record = await mem0.get(input.id, USER_ID, repository.repoId, signal);
			return { text: JSON.stringify(record, null, 2), details: { record } };
		}
		if (input.action === "history") {
			const history = await mem0.history(input.id, USER_ID, repository.repoId, signal);
			return { text: JSON.stringify(history, null, 2), details: { history } };
		}
		if (input.action === "update") {
			if (!input.memory?.trim()) throw new Error("memory is required for update.");
			validateEvidencePaths(repository, input.evidencePaths);
			const current = await mem0.get(input.id, USER_ID, repository.repoId, signal);
			const metadata = {
				...(current.metadata ?? {}),
				repo_id: repository.repoId,
				...(input.type ? { type: input.type } : {}),
				...(input.source ? { source: input.source } : {}),
				...(input.evidencePaths ? { evidence_paths: input.evidencePaths } : {}),
				verified_commit: repository.commit ?? null,
				verified_at: new Date().toISOString(),
				status: "active",
				schema_version: SCHEMA_VERSION,
			};
			const result = await mem0.update(input.id, input.memory.trim(), metadata, USER_ID, repository.repoId, signal);
			return { text: `Updated memory ${input.id}.`, details: { result, metadata } };
		}
		await mem0.delete(input.id, USER_ID, repository.repoId, signal);
		return { text: `Deleted memory ${input.id}.`, details: { id: input.id } };
	};

	pi.registerTool({
		name: "memory_adapter",
		label: "Memory Adapter",
		description: "Explicitly curate and recall repository-scoped memories through local Mem0. Audit is advisory and never mutates memory.",
		promptSnippet: "Recall or explicitly curate repository-scoped local memory",
		promptGuidelines: [
			"Treat current source and reviewed repository contracts as more authoritative than recalled memory.",
			"Write, update, or delete memory only when the user explicitly requests that mutation.",
			"Use audit findings to discuss keep, reverify, update, supersede, archive, delete, or needs_user; do not apply recommendations without approval.",
		],
		parameters,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const result = await execute(input, ctx, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					action: input.action,
					...(input.id ? { requestedId: input.id } : {}),
					...(input.type ? { requestedType: input.type } : {}),
					...(result.details && typeof result.details === "object" ? result.details : {}),
				},
			};
		},
	});

	pi.events.on(DISTILL_KNOWLEDGE_DISCOVERY_EVENT, (value: unknown) => {
		const event = value as DistillKnowledgeDiscovery;
		event.register({
			id: "mem0",
			locality: "local",
			description: "Repository-scoped local Mem0 memories",
			async search(query, options) {
				const mem0 = client();
				if (!await mem0.health(options.signal)) return [];
				const repository = await getScope(options.cwd);
				const records = await mem0.search(query, USER_ID, repository.repoId, Math.min(options.limit, MAX_RECALL_LIMIT), options.signal);
				return records.filter((record) => record.metadata?.status === "active").map((record) => ({
					provider: "mem0", id: record.id, kind: typeof record.metadata?.type === "string" ? record.metadata.type : "memory",
					content: record.memory,
					evidence: Array.isArray(record.metadata?.evidence_paths) ? record.metadata.evidence_paths.filter((path): path is string => typeof path === "string") : [],
					metadata: { ...(record.metadata ?? {}), ...(typeof record.score === "number" ? { score: record.score } : {}) },
				}));
			},
		});
	});

	pi.registerCommand("memory-status", {
		description: "Show local Mem0 and repository namespace status",
		handler: async (_args, ctx) => {
			const result = await execute({ action: "status" }, ctx);
			ctx.ui.notify(result.text, "info");
		},
	});
	pi.registerCommand("memory-start", {
		description: "Start the shared local Mem0 service",
		handler: async (_args, ctx) => {
			try { await ensureRunning(ctx); ctx.ui.notify("Mem0 is running.", "info"); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	pi.registerCommand("memory-stop", {
		description: "Stop the shared local Mem0 service",
		handler: async (_args, ctx) => {
			try { await operateService("mem0", "stop", { ctx }); ctx.ui.notify("Mem0 is stopped.", "info"); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	pi.registerCommand("memory-audit", {
		description: "Run deterministic checks, then ask the main agent for a bounded semantic memory audit",
		handler: async (_args, ctx) => {
			try {
				const result = await execute({ action: "audit" }, ctx);
				const details = result.details as { findings: unknown[]; checked: number; bounded: boolean; repository: RepositoryScope };
				pi.sendUserMessage(renderBuiltInPrompt("memory-audit", {
					checked: details.checked,
					boundedNotice: details.bounded ? `; candidates were capped at ${MAX_AUDIT_CANDIDATES}` : "",
					repository: JSON.stringify(details.repository, null, 2),
					findings: JSON.stringify(details.findings, null, 2),
				}));
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("memory-debug", {
		description: "Show diagnostics for the most recent automatic memory retrieval",
		handler: async (_args, ctx) => {
			// A notification is deliberately transcript- and context-free: inspecting
			// retrieval must not itself become durable agent memory.
			ctx.ui.notify(JSON.stringify(recallDiagnostics, null, 2), recallDiagnostics.status === "error" ? "error" : "info");
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const prompt = event.prompt.trim();
		recallRun = prompt ? { prompt, cwd: ctx.cwd } : undefined;
		recallDiagnostics = {
			status: prompt ? "pending" : "empty",
			at: new Date().toISOString(),
			...(prompt ? { query: prompt.replace(/\s+/g, " ").slice(0, 500) } : {}),
			...(process.env.PIBOX_SUBAGENT_ID ? { subagent: process.env.PIBOX_SUBAGENT_ID } : {}),
		};
	});
	pi.on("context", async (event) => {
		const run = recallRun;
		if (!run) return;
		run.promise ??= retrieveForRun(run.prompt, event.messages, run.cwd);
		const content = await run.promise;
		if (!content) return;
		const messages = event.messages.filter((message: any) => !(message?.role === "custom" && message?.customType === "pibox-memory"));
		let insertion = messages.length;
		for (let index = messages.length - 1; index >= 0; index--) {
			if ((messages[index] as any)?.role === "user") { insertion = index; break; }
		}
		messages.splice(insertion, 0, {
			role: "custom",
			customType: "pibox-memory",
			content,
			display: false,
			details: { retrieval: recallDiagnostics },
			timestamp: Date.now(),
		});
		return { messages };
	});
	pi.on("agent_settled", () => { recallRun = undefined; });
	pi.on("session_start", () => { scopes.clear(); recallRun = undefined; recallDiagnostics = { status: "idle", at: new Date().toISOString() }; });
	pi.on("session_shutdown", () => { scopes.clear(); recallRun = undefined; });
}
