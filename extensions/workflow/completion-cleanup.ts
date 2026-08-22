import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import type { RepositoryIdentity } from "./repository.js";
import { atomicWriteFile, readTextIfExists } from "./repository.js";
import { SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";

const OUTPUT_TAIL_BYTES = 16 * 1024;
const SETTLED_AGENT_STATES = new Set(["completed", "cancelled"]);
const SETTLED_ATTEMPT_STATES = new Set(["exited", "failed"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "protocol_failed", "cancelled"]);
const TERMINAL_VERIFICATION_STATES = new Set(["passed", "failed", "interrupted"]);
const ATTEMPT_FILES_SAFE_TO_COMPACT = new Set(["attempt.yaml", "result.yaml", "stdout.log", "stderr.log"]);

interface RemovedEntry { path: string; bytes: number }
interface SkippedEntry { path: string; reason: string }

export interface WorkItemCleanupManifest {
	schemaVersion: 1;
	workItemId: string;
	completedAt: string;
	status: "completed" | "completed_with_skips";
	removed: RemovedEntry[];
	compactedVerificationAttempts: number;
	preserved: string[];
	skipped: SkippedEntry[];
}

interface CompactedVerificationEntry {
	id: string;
	attempt: Record<string, unknown>;
	result: Record<string, unknown>;
}

interface CompactedVerificationArchive {
	schemaVersion: 1;
	updatedAt: string;
	attempts: CompactedVerificationEntry[];
	outputs: Record<string, { bytes: number; tail?: string }>;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeSegment(value: string): boolean {
	return Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.includes("\0") && value !== "." && value !== "..";
}

function processAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return false;
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

async function yaml(path: string): Promise<Record<string, unknown> | undefined> {
	const content = await readTextIfExists(path);
	if (!content) return undefined;
	try { return object(parse(content)); }
	catch { return undefined; }
}

async function json<T>(path: string): Promise<T | undefined> {
	const content = await readTextIfExists(path);
	if (!content) return undefined;
	try { return JSON.parse(content) as T; }
	catch { return undefined; }
}

async function checksum(path: string): Promise<string> {
	const hash = createHash("sha256");
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally { await handle.close(); }
	return `sha256:${hash.digest("hex")}`;
}

async function tail(path: string, bytes = OUTPUT_TAIL_BYTES): Promise<string> {
	const info = await stat(path);
	const length = Math.min(info.size, bytes);
	if (length === 0) return "";
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, info.size - length);
		return buffer.toString("utf8");
	} finally { await handle.close(); }
}

async function removeKnownFile(identity: RepositoryIdentity, path: string, removed: RemovedEntry[]): Promise<void> {
	const info = await lstat(path).catch(() => undefined);
	if (!info) return;
	if (!info.isFile()) return;
	await rm(path, { force: true });
	removed.push({ path: relative(identity.privateRoot, path), bytes: info.size });
}

function outputRecord(result: Record<string, unknown>, name: "stdout" | "stderr"): Record<string, unknown> | undefined {
	return object(result[name]);
}

async function captureOutput(
	path: string,
	recorded: Record<string, unknown> | undefined,
	outputs: CompactedVerificationArchive["outputs"],
): Promise<{ valid: boolean; record?: Record<string, unknown> }> {
	const info = await stat(path).catch(() => undefined);
	if (!info) return { valid: true, ...(recorded ? { record: recorded } : {}) };
	if (!info.isFile() || !recorded || recorded.bytes !== info.size || typeof recorded.checksum !== "string") return { valid: false };
	const actual = await checksum(path);
	if (actual !== recorded.checksum) return { valid: false };
	const outputTail = await tail(path);
	outputs[actual] ??= { bytes: info.size, ...(outputTail ? { tail: outputTail } : {}) };
	return {
		valid: true,
		record: { ...recorded, retained: "bounded-tail", ...(outputTail ? { tail: outputTail } : {}) },
	};
}

function verificationFingerprint(attempt: Record<string, unknown>, result: Record<string, unknown>): string | undefined {
	const stdout = outputRecord(result, "stdout");
	const stderr = outputRecord(result, "stderr");
	if (typeof attempt.candidateCommit !== "string" || typeof attempt.command !== "string" || typeof attempt.state !== "string") return undefined;
	if (typeof stdout?.checksum !== "string" || typeof stderr?.checksum !== "string") return undefined;
	return JSON.stringify([
		attempt.candidateCommit,
		attempt.command,
		attempt.profileDigest ?? attempt.profile ?? "",
		attempt.state,
		result.code ?? "",
		stdout.checksum,
		stderr.checksum,
	]);
}

async function cleanVerificationCheck(
	identity: RepositoryIdentity,
	attemptsRoot: string,
	removed: RemovedEntry[],
	skipped: SkippedEntry[],
): Promise<number> {
	const archivePath = join(attemptsRoot, "compacted-attempts.json");
	const prior = await json<CompactedVerificationArchive>(archivePath);
	const archive: CompactedVerificationArchive = prior?.schemaVersion === 1
		? { ...prior, attempts: [...prior.attempts], outputs: { ...prior.outputs }, updatedAt: new Date().toISOString() }
		: { schemaVersion: 1, updatedAt: new Date().toISOString(), attempts: [], outputs: {} };
	const archivedIds = new Set(archive.attempts.map((entry) => entry.id));
	const physical: Array<{ id: string; root: string; attempt: Record<string, unknown>; result: Record<string, unknown>; fingerprint: string }> = [];
	for (const id of (await readdir(attemptsRoot).catch(() => [])).filter((name) => /^\d{3,}$/.test(name)).sort((left, right) => Number(left) - Number(right))) {
		const root = join(attemptsRoot, id);
		const attempt = await yaml(join(root, "attempt.yaml"));
		const result = await yaml(join(root, "result.yaml"));
		if (!attempt || !result || !TERMINAL_VERIFICATION_STATES.has(String(attempt.state)) || !TERMINAL_VERIFICATION_STATES.has(String(result.state))) continue;
		const fingerprint = verificationFingerprint(attempt, result);
		if (fingerprint) physical.push({ id, root, attempt, result, fingerprint });
	}
	const groups = new Map<string, typeof physical>();
	for (const entry of physical) {
		const group = groups.get(entry.fingerprint) ?? [];
		group.push(entry);
		groups.set(entry.fingerprint, group);
	}
	const compact = new Set<string>();
	for (const group of groups.values()) {
		if (group.length <= 2) continue;
		for (const entry of group.slice(1, -1)) compact.add(entry.id);
	}
	let compacted = 0;
	let archiveChanged = false;
	for (const entry of physical) {
		const stdoutPath = join(entry.root, "stdout.log");
		const stderrPath = join(entry.root, "stderr.log");
		const stdout = await captureOutput(stdoutPath, outputRecord(entry.result, "stdout"), archive.outputs);
		const stderr = await captureOutput(stderrPath, outputRecord(entry.result, "stderr"), archive.outputs);
		if (!stdout.valid || !stderr.valid) {
			skipped.push({ path: relative(identity.privateRoot, entry.root), reason: "verification output did not match its durable checksum" });
			continue;
		}
		const boundedResult = { ...entry.result, ...(stdout.record ? { stdout: stdout.record } : {}), ...(stderr.record ? { stderr: stderr.record } : {}) };
		if (compact.has(entry.id)) {
			const names = await readdir(entry.root).catch(() => []);
			if (names.some((name) => !ATTEMPT_FILES_SAFE_TO_COMPACT.has(name))) {
				skipped.push({ path: relative(identity.privateRoot, entry.root), reason: "verification attempt contains unrecognized evidence" });
				continue;
			}
			if (!archivedIds.has(entry.id)) {
				// Output tails are content-addressed once in archive.outputs; keeping
				// them out of every repeated result is what makes retry storms compact.
				archive.attempts.push({ id: entry.id, attempt: entry.attempt, result: entry.result });
				archivedIds.add(entry.id);
				archiveChanged = true;
			}
			continue;
		}
		if (stdout.record || stderr.record) await atomicWriteFile(join(entry.root, "result.yaml"), stringify(boundedResult), 0o600);
		await removeKnownFile(identity, stdoutPath, removed);
		await removeKnownFile(identity, stderrPath, removed);
	}
	if (archiveChanged) {
		archive.attempts.sort((left, right) => Number(left.id) - Number(right.id));
		await atomicWriteFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, 0o600);
	}
	for (const entry of physical) {
		if (!compact.has(entry.id) || !archivedIds.has(entry.id)) continue;
		const names = await readdir(entry.root).catch(() => []);
		if (names.some((name) => !ATTEMPT_FILES_SAFE_TO_COMPACT.has(name))) continue;
		let bytes = 0;
		for (const name of names) bytes += (await stat(join(entry.root, name)).catch(() => undefined))?.size ?? 0;
		await rm(entry.root, { recursive: true, force: true });
		removed.push({ path: relative(identity.privateRoot, entry.root), bytes });
		compacted++;
	}
	return compacted;
}

async function cleanupVerification(
	identity: RepositoryIdentity,
	workItemId: string,
	removed: RemovedEntry[],
	skipped: SkippedEntry[],
): Promise<number> {
	const root = join(identity.privateRoot, "work-items", workItemId, "verification");
	let compacted = 0;
	for (const stage of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!stage.isDirectory()) continue;
		for (const check of await readdir(join(root, stage.name), { withFileTypes: true }).catch(() => [])) {
			if (!check.isDirectory()) continue;
			compacted += await cleanVerificationCheck(identity, join(root, stage.name, check.name, "attempts"), removed, skipped);
		}
	}
	return compacted;
}

async function cleanupSessions(
	identity: RepositoryIdentity,
	workItemId: string,
	removed: RemovedEntry[],
	skipped: SkippedEntry[],
): Promise<void> {
	const sessionsRoot = join(identity.privateRoot, "sessions");
	for (const session of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
		if (!session.isDirectory() || !safeSegment(session.name)) continue;
		const root = join(sessionsRoot, session.name);
		let snapshot = await yaml(join(root, "agents.yaml"));
		if (!snapshot || snapshot.sessionId !== session.name || !Array.isArray(snapshot.agents)) continue;
		// Work-item completion closes successful reviewer/fixer identities. Perform
		// the state transition through the registry mutex so a concurrent retry
		// either wins and remains untouched or loses to the immutable completion.
		const registry = new SessionAgentRegistry(identity.privateRoot, session.name);
		for (const value of snapshot.agents) {
			const agent = object(value);
			if (!agent || agent.workItemId !== workItemId || agent.state !== "reported" || typeof agent.id !== "string" || !safeSegment(agent.id)) continue;
			const transitionCleanup: Array<{ path: string; bytes: number }> = [];
			for (const attemptValue of Array.isArray(agent.attempts) ? agent.attempts : []) {
				const attempt = object(attemptValue);
				if (!attempt || attempt.exitCode !== 0 || typeof attempt.id !== "string" || !safeSegment(attempt.id)) continue;
				for (const name of ["stdout.jsonl", "stderr.log"]) {
					const path = join(root, "agents", agent.id, "attempts", attempt.id, name);
					const info = await lstat(path).catch(() => undefined);
					if (info?.isFile()) transitionCleanup.push({ path, bytes: info.size });
				}
			}
			const transitioned = await registry.transition(agent.id, "completed").then(() => true, () => false);
			if (transitioned) for (const entry of transitionCleanup) {
				if (!await lstat(entry.path).then(() => true, () => false)) removed.push({ path: relative(identity.privateRoot, entry.path), bytes: entry.bytes });
			}
		}
		snapshot = await yaml(join(root, "agents.yaml"));
		if (!snapshot || !Array.isArray(snapshot.agents)) continue;
		for (const value of snapshot.agents) {
			const agent = object(value);
			if (!agent || agent.workItemId !== workItemId || typeof agent.id !== "string" || !safeSegment(agent.id)) continue;
			if (!SETTLED_AGENT_STATES.has(String(agent.state))) {
				skipped.push({ path: relative(identity.privateRoot, join(root, "agents", agent.id)), reason: `agent remains ${String(agent.state)}` });
				continue;
			}
			if (!Array.isArray(agent.attempts)) continue;
			for (const attemptValue of agent.attempts) {
				const attempt = object(attemptValue);
				if (!attempt || typeof attempt.id !== "string" || !safeSegment(attempt.id)) continue;
				const attemptRoot = join(root, "agents", agent.id, "attempts", attempt.id);
				if (!SETTLED_ATTEMPT_STATES.has(String(attempt.state)) || processAlive(attempt.pid)) {
					skipped.push({ path: relative(identity.privateRoot, attemptRoot), reason: "process attempt is not safely settled" });
					continue;
				}
				for (const name of ["stdout.jsonl", "stderr.log", "heartbeat.json", "process-exit.json"]) {
					await removeKnownFile(identity, join(attemptRoot, name), removed);
				}
			}
		}
		// agents.yaml is authoritative in current runtimes; this journal is a legacy duplicate.
		await removeKnownFile(identity, join(root, "agent-events.jsonl"), removed);
	}
}

async function cleanupRuns(identity: RepositoryIdentity, workItemId: string, removed: RemovedEntry[]): Promise<void> {
	const root = join(identity.privateRoot, "work-items", workItemId, "runs");
	for (const run of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!run.isDirectory() || !safeSegment(run.name)) continue;
		const runRoot = join(root, run.name);
		const record = await yaml(join(runRoot, "run.yaml"));
		if (!record || !TERMINAL_RUN_STATES.has(String(record.state))) continue;
		for (const name of ["events.jsonl", "transcript.jsonl"]) await removeKnownFile(identity, join(runRoot, name), removed);
		const commands = join(runRoot, "commands");
		if ((await readdir(commands).catch(() => ["nonempty"])).length === 0) await rm(commands, { recursive: false }).catch(() => undefined);
	}
}

/**
 * Remove only completion-time ephemera. Canonical artifacts, Pi sessions,
 * assignments, handoffs, findings, terminal summaries, and bounded evidence
 * remain available for analysis.
 */
export async function cleanupCompletedWorkItem(identity: RepositoryIdentity, workItemId: string): Promise<WorkItemCleanupManifest> {
	if (!safeSegment(workItemId)) throw new Error(`Invalid work item id: ${workItemId}`);
	const cleanupRoot = join(identity.privateRoot, "work-items", workItemId, "cleanup");
	const manifestPath = join(cleanupRoot, "manifest.json");
	const existing = await json<WorkItemCleanupManifest>(manifestPath);
	if (existing?.schemaVersion === 1 && existing.workItemId === workItemId) return existing;
	const removed: RemovedEntry[] = [];
	const skipped: SkippedEntry[] = [];
	await cleanupSessions(identity, workItemId, removed, skipped);
	await cleanupRuns(identity, workItemId, removed);
	const compactedVerificationAttempts = await cleanupVerification(identity, workItemId, removed, skipped);
	const manifest: WorkItemCleanupManifest = {
		schemaVersion: 1,
		workItemId,
		completedAt: new Date().toISOString(),
		status: skipped.length ? "completed_with_skips" : "completed",
		removed: removed.sort((left, right) => left.path.localeCompare(right.path)),
		compactedVerificationAttempts,
		preserved: [
			"canonical work-item artifacts and outcome",
			"agent registries, assignments, Pi sessions, terminal summaries, and messages",
			"run handoffs, checkpoints, findings, and evaluation evidence",
			"verification metadata, checksums, and bounded output tails",
			"repository semantic event history",
		],
		skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
	};
	await mkdir(cleanupRoot, { recursive: true, mode: 0o700 });
	await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
	return manifest;
}

export async function readCompactedVerificationAttempts(attemptsRoot: string): Promise<CompactedVerificationEntry[]> {
	const archive = await json<CompactedVerificationArchive>(join(attemptsRoot, "compacted-attempts.json"));
	return archive?.schemaVersion === 1 && Array.isArray(archive.attempts) ? archive.attempts : [];
}
