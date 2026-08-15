import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Mem0Client, type MemoryRecord } from "./client.js";
import { deriveRepositoryScope, type RepositoryScope } from "./scope.js";
import { getService, operateService } from "../service-adapter/registry.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";

const SCHEMA_VERSION = 1;
const USER_ID = "pibox";
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 10;
const MAX_AUDIT_CANDIDATES = 50;

const parameters = Type.Object({
	action: StringEnum(["status", "remember", "recall", "list", "get", "update", "delete", "history", "audit"] as const),
	query: Type.Optional(Type.String()),
	memory: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	type: Type.Optional(Type.String()),
	source: Type.Optional(Type.String()),
	evidencePaths: Type.Optional(Type.Array(Type.String())),
	expiresAt: Type.Optional(Type.String({ description: "Optional YYYY-MM-DD expiration date." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RECALL_LIMIT })),
});

function client(): Mem0Client {
	const keyPath = join(homedir(), ".pi", "pibox", "services", "mem0", "api-key");
	const apiKey = process.env.PIBOX_MEM0_API_KEY ?? (existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : undefined);
	return new Mem0Client({
		baseUrl: process.env.PIBOX_MEM0_URL ?? "http://127.0.0.1:6001",
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
		const evidence = Array.isArray(metadata.evidence_paths) ? metadata.evidence_paths.filter((path): path is string => typeof path === "string") : [];
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

	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.prompt.trim() || getService("mem0")?.snapshot.state !== "running") return;
		try {
			const repository = await getScope(ctx.cwd);
			const records = await client().search(event.prompt, USER_ID, repository.repoId, DEFAULT_RECALL_LIMIT);
			if (!records.length) return;
			const content = records.map(({ id, memory }) => `- [${id}] ${memory}`).join("\n").slice(0, 6_000);
			return {
				message: {
					customType: "pibox-memory",
					content: `Potentially relevant repository memory follows. It may be stale; current source and reviewed contracts outrank it.\n${content}`,
					display: false,
				},
			};
		} catch { return; }
	});
	pi.on("session_start", () => { scopes.clear(); });
	pi.on("session_shutdown", () => { scopes.clear(); });
}
