import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { atomicWriteFile } from "./repository.js";
import type { RepositoryIdentity } from "./repository.js";
import type { NormalizedVerificationCheck } from "./verification-checks.js";
import { resolveVerificationProfile } from "./verification-config.js";

const TAIL_LIMIT = 16 * 1024;

export interface VerificationAttemptResult {
	id: string;
	profile: string;
	command: string;
	code: number;
	signal?: string;
	stdout: string;
	stderr: string;
	attemptPath: string;
	stdoutPath: string;
	stderrPath: string;
	startedAt: string;
	completedAt: string;
}

async function checksumFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(path);
	stream.on("data", (chunk) => hash.update(chunk));
	await once(stream, "end");
	return `sha256:${hash.digest("hex")}`;
}

async function readTail(path: string): Promise<Buffer<ArrayBufferLike>> {
	const info = await stat(path);
	const length = Math.min(info.size, TAIL_LIMIT);
	if (length === 0) return Buffer.alloc(0);
	const file = await open(path, "r");
	try {
		const buffer: Buffer<ArrayBufferLike> = Buffer.alloc(length);
		await file.read(buffer, 0, length, info.size - length);
		return buffer;
	} finally { await file.close(); }
}

function processAlive(pid: number | undefined): boolean {
	if (!pid || pid < 1) return false;
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

async function readYaml(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = parse(await readFile(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function reconcileIncompleteAttempts(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d{3,}$/.test(entry.name)) continue;
		const attemptRoot = join(root, entry.name);
		const attemptPath = join(attemptRoot, "attempt.yaml");
		const attempt = await readYaml(attemptPath);
		if (!attempt || !["starting", "running"].includes(String(attempt.state))) continue;
		const pid = typeof attempt.pid === "number" ? attempt.pid : undefined;
		if (processAlive(pid)) throw new HarnessError("RESOURCE_LOCKED", `Verification attempt ${entry.name} is still running as pid ${pid}`, { attemptPath });
		const completedAt = new Date().toISOString();
		await atomicWriteFile(join(attemptRoot, "result.yaml"), stringify({ schemaVersion: 1, state: "interrupted", reason: "runner process was not alive during recovery", completedAt }), 0o600);
		await atomicWriteFile(attemptPath, stringify({ ...attempt, state: "interrupted", completedAt }), 0o600);
	}
}

function terminalSummary(result: Pick<VerificationAttemptResult, "stdout" | "stderr">): string {
	return (result.stderr.trim() || result.stdout.trim() || "Verification command failed without output").slice(-4_000);
}

export function verificationFailureSummary(result: VerificationAttemptResult): string {
	return `${terminalSummary(result)}\nDurable verification evidence: ${result.attemptPath}`;
}

export class VerificationRunner {
	constructor(private readonly identity: RepositoryIdentity) {}

	async run(workItemId: string, stageId: string, check: NormalizedVerificationCheck, cwd: string, candidateCommit: string): Promise<VerificationAttemptResult> {
		const attemptsRoot = join(this.identity.privateRoot, "work-items", workItemId, "verification", stageId, check.id, "attempts");
		await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
		await reconcileIncompleteAttempts(attemptsRoot);
		const existing = (await readdir(attemptsRoot)).filter((name) => /^\d{3,}$/.test(name)).map(Number);
		const sequence = (existing.length ? Math.max(...existing) : 0) + 1;
		const id = String(sequence).padStart(3, "0");
		const attemptRoot = join(attemptsRoot, id);
		await mkdir(attemptRoot, { recursive: false, mode: 0o700 });
		const profile = await resolveVerificationProfile(this.identity.root, check);
		const startedAt = new Date().toISOString();
		const attemptPath = join(attemptRoot, "attempt.yaml");
		const stdoutPath = join(attemptRoot, "stdout.log");
		const stderrPath = join(attemptRoot, "stderr.log");
		const relativeAttemptPath = relative(this.identity.root, attemptRoot);
		const base = {
			schemaVersion: 1,
			state: "starting",
			id,
			workItemId,
			stageId,
			checkId: check.id,
			command: check.command,
			profile: profile.name,
			profileDigest: `sha256:${profile.digest}`,
			shell: profile.shell,
			legacyShell: profile.legacy,
			...(profile.configPath ? { configPath: relative(this.identity.root, profile.configPath) } : {}),
			requiredEnvironment: profile.requiredEnvironment,
			candidateCommit,
			cwd,
			startedAt,
			stdoutPath: relative(attemptRoot, stdoutPath),
			stderrPath: relative(attemptRoot, stderrPath),
		};
		await atomicWriteFile(attemptPath, stringify(base), 0o600);

		const requiredChecks = profile.requiredEnvironment.map((name) => `if [ -z "\${${name}:-}" ]; then printf '%s\\n' 'Required verification environment is missing: ${name}' >&2; exit 78; fi`);
		const script = [profile.legacy ? undefined : "set -e", profile.bootstrap, ...requiredChecks, check.command].filter(Boolean).join("\n");
		const stdoutFile = await open(stdoutPath, "wx", 0o600);
		const stderrFile = await open(stderrPath, "wx", 0o600);
		let spawnError: Error | undefined;
		let code: number | null = 1;
		let signal: NodeJS.Signals | null = null;
		let childPid: number | undefined;
		try {
			const child = spawn(profile.shell, [profile.legacy ? "-lc" : "-c", script], { cwd, stdio: ["ignore", stdoutFile.fd, stderrFile.fd], env: process.env });
			childPid = child.pid;
			// Subscribe before the first await: fast checks can exit while durable
			// running metadata is being written.
			const settlement = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
				let settled = false;
				child.once("error", (error) => {
					spawnError = error;
					if (!settled) { settled = true; resolve([1, null]); }
				});
				child.once("close", (exitCode, exitSignal) => {
					if (!settled) { settled = true; resolve([exitCode, exitSignal]); }
				});
			});
			await atomicWriteFile(attemptPath, stringify({ ...base, state: "running", pid: child.pid }), 0o600);
			[code, signal] = await settlement;
		} finally {
			await Promise.all([stdoutFile.close(), stderrFile.close()]);
		}
		let stdoutTail = await readTail(stdoutPath);
		let stderrTail = await readTail(stderrPath);
		if (spawnError) stderrTail = Buffer.concat([stderrTail, Buffer.from(`${spawnError.message}\n`)]).subarray(-TAIL_LIMIT);
		const completedAt = new Date().toISOString();
		const [stdoutInfo, stderrInfo, stdoutChecksum, stderrChecksum] = await Promise.all([stat(stdoutPath), stat(stderrPath), checksumFile(stdoutPath), checksumFile(stderrPath)]);
		const exitCode = code ?? 1;
		const state = exitCode === 0 ? "passed" : "failed";
		const resultRecord = {
			schemaVersion: 1,
			state,
			code: exitCode,
			...(signal ? { signal } : {}),
			completedAt,
			durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
			stdout: { path: "stdout.log", bytes: stdoutInfo.size, checksum: stdoutChecksum },
			stderr: { path: "stderr.log", bytes: stderrInfo.size, checksum: stderrChecksum },
		};
		await atomicWriteFile(join(attemptRoot, "result.yaml"), stringify(resultRecord), 0o600);
		await atomicWriteFile(attemptPath, stringify({ ...base, state, ...(childPid === undefined ? {} : { pid: childPid }), completedAt }), 0o600);
		return {
			id,
			profile: profile.name,
			command: check.command,
			code: exitCode,
			...(signal ? { signal } : {}),
			stdout: stdoutTail.toString("utf8"),
			stderr: stderrTail.toString("utf8"),
			attemptPath: relativeAttemptPath,
			stdoutPath,
			stderrPath,
			startedAt,
			completedAt,
		};
	}
}
