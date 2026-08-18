import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import test from "node:test";
import { discoverRepository } from "../repository.js";
import { VerificationRunner, verificationFailureSummary } from "../verification-runner.js";

const exec = promisify(execFile);

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-verification-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await mkdir(join(root, ".pibox"), { recursive: true });
	await mkdir(join(root, "scripts"), { recursive: true });
	await writeFile(join(root, "scripts", "env.sh"), "export VERIFIED_BOOTSTRAP=ready\n");
	await writeFile(join(root, ".pibox", "verification.yaml"), `schemaVersion: 1\ndefaultProfile: project\nprofiles:\n  project:\n    shell: /bin/bash\n    bootstrap: source scripts/env.sh\n    requiredEnvironment: [VERIFIED_BOOTSTRAP]\n`);
	await writeFile(join(root, "tracked.txt"), "tracked\n");
	await exec("git", ["add", "tracked.txt"], { cwd: root });
	await exec("git", ["commit", "-qm", "fixture"], { cwd: root });
	const identity = await discoverRepository(root);
	const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
	return { root, identity, commit };
}

test("runs a fresh profiled shell and persists complete immutable attempt evidence", async (t) => {
	const { root, identity, commit } = await fixture(t);
	const runner = new VerificationRunner(identity);
	const result = await runner.run("story", "delivery", { id: "profiled", command: "printf '%020000d\\n' 0; printf '%s\\n' \"$VERIFIED_BOOTSTRAP\"" }, root, commit);
	assert.equal(result.code, 0);
	assert.equal(result.profile, "project");
	assert.equal(result.id, "001");
	assert.match(result.stdout, /ready/);
	const attemptRoot = join(root, result.attemptPath);
	const stdout = await readFile(join(attemptRoot, "stdout.log"), "utf8");
	assert.ok(stdout.length > 20_000, "complete output is durable even though the returned tail is bounded");
	const attempt = parse(await readFile(join(attemptRoot, "attempt.yaml"), "utf8"));
	const terminal = parse(await readFile(join(attemptRoot, "result.yaml"), "utf8"));
	assert.equal(attempt.state, "passed");
	assert.equal(attempt.candidateCommit, commit);
	assert.equal(attempt.profile, "project");
	assert.equal(terminal.state, "passed");
	assert.match(terminal.stdout.checksum, /^sha256:/);
});

test("preserves failed retries and reports the terminal error with an evidence path", async (t) => {
	const { root, identity, commit } = await fixture(t);
	const runner = new VerificationRunner(identity);
	const first = await runner.run("story", "delivery", { id: "failing", command: "printf 'irrelevant first line\\n'; printf 'actual terminal failure\\n' >&2; exit 7" }, root, commit);
	const second = await runner.run("story", "delivery", { id: "failing", command: "printf 'fixed\\n'" }, root, commit);
	assert.equal(first.code, 7);
	assert.equal(first.id, "001");
	assert.equal(second.id, "002");
	assert.match(verificationFailureSummary(first), /actual terminal failure/);
	assert.match(verificationFailureSummary(first), /Durable verification evidence: \.pibox/);
	assert.equal(parse(await readFile(join(root, first.attemptPath, "result.yaml"), "utf8")).state, "failed");
	assert.equal(parse(await readFile(join(root, second.attemptPath, "result.yaml"), "utf8")).state, "passed");
});

test("does not miss a fast child settlement while persisting running metadata", async (t) => {
	const { root, identity, commit } = await fixture(t);
	const runner = new VerificationRunner(identity);
	for (let index = 0; index < 8; index++) {
		const result = await runner.run("story", "delivery", { id: "fast", command: "true" }, root, commit);
		assert.equal(result.code, 0);
		assert.equal(result.id, String(index + 1).padStart(3, "0"));
	}
});

test("reconciles an abandoned attempt before allocating the next retry", async (t) => {
	const { root, identity, commit } = await fixture(t);
	const attempts = join(identity.privateRoot, "work-items", "story", "verification", "delivery", "recover", "attempts");
	await mkdir(join(attempts, "001"), { recursive: true });
	await writeFile(join(attempts, "001", "attempt.yaml"), `schemaVersion: 1\nstate: running\npid: 99999999\n`);
	const result = await new VerificationRunner(identity).run("story", "delivery", { id: "recover", command: "true" }, root, commit);
	assert.equal(result.id, "002");
	assert.equal(parse(await readFile(join(attempts, "001", "result.yaml"), "utf8")).state, "interrupted");
});
