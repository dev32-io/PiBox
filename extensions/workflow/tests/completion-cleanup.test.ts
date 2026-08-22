import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { cleanupCompletedWorkItem } from "../completion-cleanup.js";
import { readVerificationAttempts } from "../verification-runner.js";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-completion-cleanup-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const privateRoot = join(root, ".pibox");
	await mkdir(privateRoot, { recursive: true });
	return { root, identity: { id: "repo", root, privateRoot } };
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(() => true, () => false);
}

async function processAttempt(root: string, id: string, content = "transport\n") {
	const attemptRoot = join(root, "attempts", id);
	await mkdir(attemptRoot, { recursive: true });
	for (const [name, value] of [["stdout.jsonl", content], ["stderr.log", "diagnostic\n"], ["heartbeat.json", "{}\n"], ["process-exit.json", "{}\n"], ["result.json", "{\"summary\":\"kept\"}\n"]] as const) {
		await writeFile(join(attemptRoot, name), value);
	}
	return attemptRoot;
}

test("completion cleanup spans session registries while preserving analysis and recovery state", async (t) => {
	const { identity } = await fixture(t);
	const sessions = join(identity.privateRoot, "sessions");
	const sessionA = join(sessions, "session-a");
	const sessionB = join(sessions, "session-b");
	for (const session of [sessionA, sessionB]) await mkdir(session, { recursive: true });
	const completedRoot = join(sessionA, "agents", "completed");
	const reportedRoot = join(sessionB, "agents", "reported");
	const runningRoot = join(sessionA, "agents", "running");
	const failedRoot = join(sessionA, "agents", "failed");
	const otherRoot = join(sessionA, "agents", "other");
	const completedAttempt = await processAttempt(completedRoot, "attempt-completed");
	const reportedAttempt = await processAttempt(reportedRoot, "attempt-reported");
	const runningAttempt = await processAttempt(runningRoot, "attempt-running");
	const failedAttempt = await processAttempt(failedRoot, "attempt-failed");
	const otherAttempt = await processAttempt(otherRoot, "attempt-other");
	await writeFile(join(completedRoot, "pi-session.jsonl"), "valuable session\n");
	await writeFile(join(completedRoot, "assignment.json"), "{\"task\":\"valuable\"}\n");
	await writeFile(join(sessionA, "agent-events.jsonl"), "legacy\n");
	await writeFile(join(sessionB, "agent-events.jsonl"), "legacy\n");
	const registry = (sessionId: string, agents: unknown[]) => ({ schemaVersion: 1, sessionId, mainAgentId: `main:${sessionId}`, revision: 0, eventSequence: 0, maxActiveAgents: 16, maxSubagentDepth: 1, agents });
	const agent = (id: string, workItemId: string, state: string, attempts: unknown[]) => ({
		schemaVersion: 1, id, sessionId: id === "reported" ? "session-b" : "session-a", parentAgentId: "main", depth: 1, role: "tester", state,
		provider: "test", model: "test", effort: "low", operationId: id, assignmentDigest: id, assignmentPath: "assignment.json", attempts,
		startedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", workItemId,
	});
	await writeFile(join(sessionA, "agents.yaml"), stringify(registry("session-a", [
		agent("completed", "story", "completed", [{ id: "attempt-completed", sequence: 1, state: "exited", startedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:01.000Z" }]),
		agent("running", "story", "running", [{ id: "attempt-running", sequence: 1, state: "running", pid: process.pid, startedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:01.000Z" }]),
		agent("failed", "story", "failed", [{ id: "attempt-failed", sequence: 1, state: "failed", exitCode: 1, startedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:01.000Z" }]),
		agent("other", "other", "completed", [{ id: "attempt-other", sequence: 1, state: "exited", startedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:01.000Z" }]),
	])));
	await writeFile(join(sessionB, "agents.yaml"), stringify(registry("session-b", [
		agent("reported", "story", "reported", [{ id: "attempt-reported", sequence: 1, state: "failed", exitCode: 1, startedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:01.000Z" }]),
	])));

	const completedRun = join(identity.privateRoot, "work-items", "story", "runs", "completed-run");
	const runningRun = join(identity.privateRoot, "work-items", "story", "runs", "running-run");
	for (const [root, state] of [[completedRun, "completed"], [runningRun, "running"]] as const) {
		await mkdir(join(root, "commands"), { recursive: true });
		await writeFile(join(root, "run.yaml"), stringify({ schemaVersion: 1, state }));
		await writeFile(join(root, "transcript.jsonl"), "duplicate\n");
		await writeFile(join(root, "events.jsonl"), "duplicate\n");
		await writeFile(join(root, "handoff.json"), "{\"kept\":true}\n");
	}

	const manifest = await cleanupCompletedWorkItem(identity, "story");
	assert.equal(manifest.status, "completed_with_skips");
	for (const root of [completedAttempt, reportedAttempt]) {
		for (const name of ["stdout.jsonl", "stderr.log", "heartbeat.json", "process-exit.json"]) assert.equal(await exists(join(root, name)), false);
		assert.equal(await exists(join(root, "result.json")), true, "terminal summary remains");
	}
	assert.equal(await readFile(join(completedRoot, "pi-session.jsonl"), "utf8"), "valuable session\n");
	assert.equal(await exists(join(completedRoot, "assignment.json")), true);
	assert.equal(await exists(join(runningAttempt, "stdout.jsonl")), true, "active recovery transport remains");
	assert.equal(await exists(join(failedAttempt, "stdout.jsonl")), true, "retryable failed-agent transport remains");
	assert.equal(await exists(join(otherAttempt, "stdout.jsonl")), true, "other work-item transport remains");
	assert.equal(await exists(join(sessionA, "agent-events.jsonl")), false, "authoritative snapshots replace legacy journals");
	assert.equal(await exists(join(sessionB, "agent-events.jsonl")), false);
	const finalized = parse(await readFile(join(sessionB, "agents.yaml"), "utf8"));
	assert.equal(finalized.agents[0].state, "completed", "reported logical agents close under the registry mutex before transport cleanup");
	assert.equal(await exists(join(completedRun, "transcript.jsonl")), false);
	assert.equal(await exists(join(completedRun, "events.jsonl")), false);
	assert.equal(await exists(join(completedRun, "handoff.json")), true);
	assert.equal(await exists(join(runningRun, "transcript.jsonl")), true);
	assert.ok(manifest.skipped.some((entry) => entry.reason.includes("agent remains running")));
	assert.deepEqual(await cleanupCompletedWorkItem(identity, "story"), manifest, "manifest makes cleanup idempotent");
});

test("completion cleanup compacts exact verification retries and retains checksummed bounded evidence", async (t) => {
	const { identity } = await fixture(t);
	const attemptsRoot = join(identity.privateRoot, "work-items", "story", "verification", "delivery", "check-1", "attempts");
	const stdout = "same deterministic failure\n";
	const stderr = "build failed\n";
	for (let index = 1; index <= 4; index++) {
		const id = String(index).padStart(3, "0");
		const root = join(attemptsRoot, id);
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "stdout.log"), stdout);
		await writeFile(join(root, "stderr.log"), stderr);
		await writeFile(join(root, "attempt.yaml"), stringify({
			schemaVersion: 1, id, workItemId: "story", stageId: "delivery", checkId: "check-1", state: "failed",
			candidateCommit: "a".repeat(40), command: "npm test", profileDigest: "sha256:profile",
			startedAt: `2026-08-21T00:00:0${index}.000Z`, completedAt: `2026-08-21T00:00:0${index}.500Z`,
		}));
		await writeFile(join(root, "result.yaml"), stringify({
			schemaVersion: 1, state: "failed", code: 1, durationMs: 500,
			stdout: { path: "stdout.log", bytes: Buffer.byteLength(stdout), checksum: digest(stdout) },
			stderr: { path: "stderr.log", bytes: Buffer.byteLength(stderr), checksum: digest(stderr) },
		}));
	}

	const manifest = await cleanupCompletedWorkItem(identity, "story");
	assert.equal(manifest.compactedVerificationAttempts, 2);
	assert.equal(await exists(join(attemptsRoot, "001")), true);
	assert.equal(await exists(join(attemptsRoot, "002")), false);
	assert.equal(await exists(join(attemptsRoot, "003")), false);
	assert.equal(await exists(join(attemptsRoot, "004")), true);
	for (const id of ["001", "004"]) {
		assert.equal(await exists(join(attemptsRoot, id, "stdout.log")), false);
		assert.equal(await exists(join(attemptsRoot, id, "stderr.log")), false);
		const result = parse(await readFile(join(attemptsRoot, id, "result.yaml"), "utf8"));
		assert.equal(result.stdout.checksum, digest(stdout));
		assert.equal(result.stdout.tail, stdout);
		assert.equal(result.stderr.tail, stderr);
	}
	const archive = JSON.parse(await readFile(join(attemptsRoot, "compacted-attempts.json"), "utf8"));
	assert.deepEqual(archive.attempts.map((entry: { id: string }) => entry.id), ["002", "003"]);
	assert.equal(Object.keys(archive.outputs).length, 2, "identical outputs are content-addressed once");
	assert.equal((await readVerificationAttempts(identity, "story")).length, 4, "metrics retain compacted attempt history");
});

test("completion cleanup refuses to remove verification output that fails its checksum contract", async (t) => {
	const { identity } = await fixture(t);
	const root = join(identity.privateRoot, "work-items", "story", "verification", "delivery", "check-1", "attempts", "001");
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "stdout.log"), "actual\n");
	await writeFile(join(root, "stderr.log"), "");
	await writeFile(join(root, "attempt.yaml"), stringify({ id: "001", state: "passed", candidateCommit: "b".repeat(40), command: "true", profileDigest: "profile", startedAt: "2026-08-21T00:00:00.000Z", completedAt: "2026-08-21T00:00:01.000Z" }));
	await writeFile(join(root, "result.yaml"), stringify({ state: "passed", code: 0, stdout: { path: "stdout.log", bytes: 7, checksum: digest("different\n") }, stderr: { path: "stderr.log", bytes: 0, checksum: digest("") } }));
	const manifest = await cleanupCompletedWorkItem(identity, "story");
	assert.equal(await exists(join(root, "stdout.log")), true);
	assert.ok(manifest.skipped.some((entry) => entry.reason.includes("checksum")));
});
