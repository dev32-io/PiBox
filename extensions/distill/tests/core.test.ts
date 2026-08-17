import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assessInstruction, assertSafeArtifactPath, collectDistillRun, currentDirtySnapshot, resolveDistillScope, safeArtifactPath, sanitizeDistillText, type GitRunner } from "../core.js";
import { selectedSessionEntries } from "../index.js";

const exec = promisify(execFile);

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-distill-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = async (...args: string[]) => (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
	await git("init", "-b", "develop");
	await git("config", "user.email", "test@example.com");
	await git("config", "user.name", "Test");
	await writeFile(join(root, ".gitignore"), ".pibox/\n");
	await writeFile(join(root, "AGENTS.md"), "# Instructions\n\n- Preserve unrelated work.\n");
	await writeFile(join(root, "app.ts"), "export const version = 1;\n");
	await git("add", "."); await git("commit", "-m", "base");
	const base = await git("rev-parse", "HEAD");
	await git("checkout", "-b", "feature/distill-test");
	await writeFile(join(root, "app.ts"), "export const version = 2;\n");
	await mkdir(join(root, "agent-artifacts", "demo"), { recursive: true });
	await writeFile(join(root, "agent-artifacts", "demo", "index.yaml"), `schemaVersion: 1\nid: demo\ndelivery:\n  workingBranch: feature/distill-test\n  createdFromCommit: ${base}\n`);
	await writeFile(join(root, "agent-artifacts", "demo", "outcome.md"), "# Outcome\n\nDelivered version two.\n");
	await git("add", "."); await git("commit", "-m", "feature change");
	const head = await git("rev-parse", "HEAD");
	const runner: GitRunner = async (args) => {
		try { const result = await exec("git", args, { cwd: root, encoding: "utf8" }); return { code: 0, stdout: result.stdout, stderr: result.stderr }; }
		catch (error: any) { return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
	};
	return { root, base, head, git, runner };
}

test("resolves arbitrary immutable refs without switching the checkout", async (t) => {
	const f = await fixture(t);
	const branchBefore = await f.git("branch", "--show-current");
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", workItems: ["demo"], focus: ["knowledge"] });
	assert.equal(scope.target.commit, f.head);
	assert.equal(scope.baseline.commit, f.base);
	assert.equal(scope.baseline.source, "workflow-base");
	assert.equal(scope.commitCount, 1);
	assert.equal(scope.changedFiles, 3);
	assert.equal(await f.git("branch", "--show-current"), branchBefore);

	const boundedSession = await resolveDistillScope(f.runner, { target: "HEAD", baseline: f.base, sessionIds: ["session-a"], sessionStartEntry: "entry-1", sessionEndEntry: "entry-9" });
	assert.deepEqual(boundedSession.sessionIds, ["session-a"]);
	assert.equal(boundedSession.sessionStartEntry, "entry-1");
	assert.equal(boundedSession.sessionEndEntry, "entry-9");

	const develop = await resolveDistillScope(f.runner, { target: "develop", baseline: f.base, includeSession: false });
	assert.equal(develop.target.commit, f.base);
	assert.equal(develop.commitCount, 0);
	assert.equal(await f.git("branch", "--show-current"), branchBefore);
});

test("loads explicitly selected historical main-session transcripts", async (t) => {
	const f = await fixture(t);
	const sessionDirectory = join(f.root, "pi-sessions");
	await mkdir(sessionDirectory);
	const currentFile = join(sessionDirectory, "current.jsonl");
	await writeFile(currentFile, `${JSON.stringify({ type: "session", version: 3, id: "current-session", cwd: f.root })}\n`);
	await writeFile(join(sessionDirectory, "old.jsonl"), [
		{ type: "session", version: 3, id: "old-session", cwd: f.root },
		{ type: "message", id: "old-user", parentId: null, message: { role: "user", content: "historical learning", timestamp: 1 } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: f.base, sessionIds: ["old-session"], includeSession: true });
	const entries = await selectedSessionEntries({ sessionManager: { getSessionId: () => "current-session", getSessionFile: () => currentFile, getBranch: () => [] } } as any, scope);
	assert.equal(entries.some((entry) => entry.id === "old-user" && entry.message.content === "historical learning"), true);
	const currentScope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: f.base, sessionIds: ["current-session"], includeSession: true, sessionKey: "current-session:m1" });
	const frozen = await selectedSessionEntries({ sessionManager: { getSessionId: () => "current-session", getSessionFile: () => currentFile, getBranch: () => [
		{ type: "message", id: "m1", parentId: null, message: { role: "user", content: "previewed" } },
		{ type: "message", id: "m2", parentId: "m1", message: { role: "user", content: "added after preview" } },
	] } } as any, currentScope);
	assert.equal(frozen.some((entry) => entry.id === "m1"), true);
	assert.equal(frozen.some((entry) => entry.id === "m2"), false);
});

test("time-bounded scopes exclude commits after the approved until date", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, "later.ts"), "export const later = true;\n");
	await f.git("add", "later.ts");
	await exec("git", ["commit", "-m", "later change"], { cwd: f.root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" } });
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: f.base, until: "2029-01-01T00:00:00Z", includeSession: false });
	assert.equal(scope.target.commit, f.head);
	assert.equal(scope.commitCount, 1);
	assert.equal(scope.changedFiles, 3);
	const privateRoot = join(f.root, ".pibox");
	const collected = await collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot, scope, entries: [] });
	const changes = await readFile(join(collected.runRoot, "changes.md"), "utf8");
	assert.match(changes, /Selected commit patches/);
	assert.doesNotMatch(changes, /later\.ts|later change/);
});

test("empty dated scopes produce empty change evidence", async (t) => {
	const f = await fixture(t);
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: f.base, since: "2099-01-01T00:00:00Z", includeSession: false });
	assert.equal(scope.commitCount, 0);
	assert.equal(scope.changedFiles, 0);
	const collected = await collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot: join(f.root, ".pibox"), scope, entries: [] });
	const changes = await readFile(join(collected.runRoot, "changes.md"), "utf8");
	assert.doesNotMatch(changes, /app\.ts|feature change/);
});

test("collects bounded sanitized Git, workflow, guidance, transcript, and report artifacts", async (t) => {
	const f = await fixture(t);
	const privateRoot = join(f.root, ".pibox");
	const sessionId = "session-test";
	await mkdir(join(privateRoot, "sessions", sessionId), { recursive: true });
	await writeFile(join(privateRoot, "sessions", sessionId, "agents.yaml"), `schemaVersion: 1\nagents:\n  - id: child-1\n    role: implementer\n    state: completed\n    workItemId: demo\n    summary: Final task report\n    attempts:\n      - id: attempt\n        state: exited\n`);
	await mkdir(join(privateRoot, "sessions", "older-session"), { recursive: true });
	await writeFile(join(privateRoot, "sessions", "older-session", "agents.yaml"), `schemaVersion: 1\nagents:\n  - id: reviewer-1\n    role: code-reviewer\n    state: failed\n    workItemId: demo\n    summary: Review exposed a durable failure mode\n    attempts:\n      - id: attempt-1\n        state: exited\n      - id: attempt-2\n        state: exited\n`);
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", workItems: ["demo"], rawSubagents: "exceptional" });
	const collected = await collectDistillRun(f.runner, {
		repositoryRoot: f.root, privateRoot, scope,
		entries: [
			{ type: "message", id: "u1", message: { role: "user", content: "Deploy with api_key=super-secret-value" } },
			{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Updated it." }, { type: "thinking", thinking: "private reasoning" }, { type: "toolCall", name: "edit" }] } },
		],
	});
	assert.equal(collected.reused, false);
	const transcript = await readFile(join(collected.runRoot, "transcript.md"), "utf8");
	assert.match(transcript, /api_key=\[REDACTED\]/);
	assert.doesNotMatch(transcript, /super-secret-value|private reasoning/);
	const workflow = await readFile(join(collected.runRoot, "workflow.md"), "utf8");
	assert.match(workflow, /Delivered version two/);
	const reports = await readFile(join(collected.runRoot, "subagents.md"), "utf8");
	assert.match(reports, /Final task report/);
	assert.match(reports, /Review exposed a durable failure mode/);
	assert.match(reports, /\.pibox\/sessions\/older-session\/agents\/reviewer-1\/pi-session\.jsonl/);
	assert.doesNotMatch(reports.split("## code-reviewer")[0] ?? "", /Raw-session drill-down candidate/, "successful one-attempt reports do not open raw sessions");
	const guidance = await readFile(join(collected.runRoot, "guidance.md"), "utf8");
	assert.match(guidance, /Characters: \d+[\s\S]*Estimated tokens: \d+/);
	const manifest = JSON.parse(await readFile(join(collected.runRoot, "manifest.json"), "utf8"));
	assert.ok(manifest.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256)));
	assert.equal((await collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot, scope, entries: [] })).reused, true);
	await writeFile(join(collected.runRoot, "changes.md"), "tampered\n");
	await assert.rejects(collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot, scope, entries: [] }), /evidence changed after collection/);
	assert.equal(await f.git("status", "--porcelain"), "");
});

test("dirty scope integrity includes untracked content hashes", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, "untracked.txt"), "first\n");
	const first = await currentDirtySnapshot(f.runner, []);
	await writeFile(join(f.root, "untracked.txt"), "second\n");
	const second = await currentDirtySnapshot(f.runner, []);
	assert.notEqual(first.digest, second.digest);
	assert.notEqual(first.untracked[0]?.sha256, second.untracked[0]?.sha256);
});

test("confines local artifacts and redacts common secret forms", async (t) => {
	const f = await fixture(t);
	const runId = "distill-abcdef1234567890";
	assert.equal(safeArtifactPath(join(f.root, ".pibox"), runId, "findings/one.md"), join(f.root, ".pibox", "distill", runId, "findings", "one.md"));
	assert.throws(() => safeArtifactPath(join(f.root, ".pibox"), runId, "../outside"), /stay inside/);
	await mkdir(join(f.root, ".pibox", "distill", runId), { recursive: true });
	await symlink(f.root, join(f.root, ".pibox", "distill", runId, "findings"));
	await assert.rejects(assertSafeArtifactPath(join(f.root, ".pibox"), runId, "findings/escape.md"), /must not be symbolic links/);
	await symlink(join(f.root, "AGENTS.md"), join(f.root, ".pibox", "distill", runId, "synthesis.md"));
	await assert.rejects(assertSafeArtifactPath(join(f.root, ".pibox"), runId, "synthesis.md"), /artifacts must not be symbolic links/);
	const alternatePrivate = join(f.root, "alternate-private");
	await mkdir(alternatePrivate);
	await symlink(f.root, join(alternatePrivate, "distill"));
	await assert.rejects(assertSafeArtifactPath(alternatePrivate, runId, "manifest.json"), /storage ancestors must not be symbolic links/);
	assert.match(sanitizeDistillText("password=hunter2", 100), /password=\[REDACTED\]/);
	for (const source of ["Authorization: Bearer sensitive-token", "Authorization=Bearer sensitive-token", "Authorization\tBearer sensitive-token", '{"Authorization":"Bearer sensitive-token"}', String.raw`{\"Authorization\":\"Bearer sensitive-token\"}`, '{"Authorization":{"Bearer":"sensitive-token"}}']) {
		const authorization = sanitizeDistillText(source, 100);
		assert.match(authorization, /REDACTED/);
		assert.doesNotMatch(authorization, /sensitive-token|Bearer/);
	}
});

test("treats AGENTS and rule promotion as an exceptional measured instruction gate", () => {
	const accepted = assessInstruction({
		candidate: "Never mutate production without explicit user authorization.", destination: "agents", targetPath: "AGENTS.md", targetContent: "# Rules\n", evidencePaths: ["deploy/setup.ts"],
		criticality: "A mistaken production mutation can irreversibly alter private user data.",
		nonObviousness: "The repository includes operational commands whose local and production forms look similar.",
		repeatedApplicability: "Production-adjacent maintenance occurs repeatedly across deployment and debugging tasks.",
		failureImpact: "Missing the boundary can cause irreversible data loss and a security incident.",
	});
	assert.equal(accepted.eligibleForDiscussion, true);
	assert.ok(accepted.burden.addedEstimatedTokens > 0);
	assert.equal(accepted.burden.resultingCharacters, accepted.burden.currentCharacters + accepted.burden.addedCharacters);
	assert.equal(accepted.burden.resultingEstimatedTokens, Math.ceil(accepted.burden.resultingCharacters / 4));

	const example = assessInstruction({
		candidate: "Use safe commands; for example, run the staging command first.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", evidencePaths: ["deploy/setup.ts"],
		criticality: "This is a sufficiently long criticality explanation for the deterministic gate.",
		nonObviousness: "This is a sufficiently long non-obviousness explanation for the deterministic gate.",
		repeatedApplicability: "This is a sufficiently long repeated-applicability explanation for the deterministic gate.",
		failureImpact: "This is a sufficiently long failure-impact explanation for the deterministic gate.",
	});
	assert.equal(example.eligibleForDiscussion, false);
	assert.match(example.reasons.join("\n"), /examples are forbidden/);

	const descriptive = assessInstruction({
		candidate: "Always protect credentials. Production stores private customer data.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", evidencePaths: ["src/config.ts"],
		criticality: "Credential exposure can cause irreversible compromise across repository deployments.",
		nonObviousness: "Several neutral configuration fields can contain credentials without secret-like names.",
		repeatedApplicability: "Credential-bearing configuration is handled repeatedly across integrations and deployments.",
		failureImpact: "A missed instruction can expose private credentials and require emergency rotation.",
	});
	assert.equal(descriptive.eligibleForDiscussion, false);
	assert.match(descriptive.reasons.join("\n"), /every sentence must be phrased/);
	const embedded = assessInstruction({
		candidate: "Always protect credentials while production stores private customer data.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", evidencePaths: ["src/config.ts"],
		criticality: "Credential exposure can cause irreversible compromise across repository deployments.",
		nonObviousness: "Several neutral configuration fields can contain credentials without secret-like names.",
		repeatedApplicability: "Credential-bearing configuration is handled repeatedly across integrations and deployments.",
		failureImpact: "A missed instruction can expose private credentials and require emergency rotation.",
	});
	assert.equal(embedded.eligibleForDiscussion, false);
	assert.match(embedded.reasons.join("\n"), /descriptive subordinate clause/);
	const noting = assessInstruction({
		candidate: "Always protect credentials, noting customer data is private.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", evidencePaths: ["src/config.ts"],
		criticality: "Credential exposure creates a critical privacy incident across production deployments.",
		nonObviousness: "Neutral configuration fields hide secrets in a way that is easy to miss.",
		repeatedApplicability: "Credential handling recurs across multiple integrations and deployment paths.",
		failureImpact: "A missed instruction can expose private credentials and cause a security incident.",
	});
	assert.equal(noting.eligibleForDiscussion, false);
	assert.match(noting.reasons.join("\n"), /compound|explanatory/);
	const coordinated = assessInstruction({
		candidate: "Always protect credentials and credentials are private.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", evidencePaths: ["src/config.ts"],
		criticality: "Credential exposure creates a critical privacy incident across production deployments.",
		nonObviousness: "Neutral configuration fields hide secrets in a way that is easy to miss.",
		repeatedApplicability: "Credential handling recurs across multiple integration and deployment tasks.",
		failureImpact: "A missed instruction can expose private credentials and cause a security incident.",
	});
	assert.equal(coordinated.eligibleForDiscussion, false);
	assert.match(coordinated.reasons.join("\n"), /every sentence must be phrased/);
	const tautological = assessInstruction({
		candidate: "Always protect credentials.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", evidencePaths: ["src/config.ts"],
		criticality: "Credential exposure creates a critical privacy incident across production deployments.",
		nonObviousness: "Neutral configuration fields hide secrets in a way that is easy to miss.",
		repeatedApplicability: "This statement repeats repeatedly across every multiple frequent context.",
		failureImpact: "A missed instruction can expose private credentials and cause a security incident.",
	});
	assert.equal(tautological.eligibleForDiscussion, false);
	assert.match(tautological.reasons.join("\n"), /repeated applicability/);

	const scoped = assessInstruction({
		candidate: "Preserve generated API compatibility.", destination: "agents", targetPath: "AGENTS.md", targetContent: "", paths: ["src/api/**"], evidencePaths: ["src/api/schema.ts"],
		criticality: "Breaking the generated API creates widespread downstream compatibility failures.",
		nonObviousness: "Generated files resemble ordinary source and their authority boundary is not obvious.",
		repeatedApplicability: "The generated API is touched repeatedly by feature, release, and compatibility work.",
		failureImpact: "A missed instruction can break every downstream client during the next release.",
	});
	assert.equal(scoped.eligibleForDiscussion, false);
	assert.match(scoped.reasons.join("\n"), /belong in a rule/);
});
