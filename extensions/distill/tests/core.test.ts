import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertSafeArtifactPath, collectDistillRun, currentDirtySnapshot, renderSessionTranscript, resolveDistillScope, safeArtifactPath, sanitizeDistillText, type GitRunner } from "../core.js";
import { selectedSessionEntries } from "../index.js";

const exec = promisify(execFile);

function runnerAt(root: string): GitRunner {
	return async (args, options) => {
		if (options?.stdin === undefined) {
			try { const result = await exec("git", args, { cwd: root, encoding: "utf8" }); return { code: 0, stdout: result.stdout, stderr: result.stderr }; }
			catch (error: any) { return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
		}
		return new Promise((resolve) => {
			const child = spawn("git", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
			const stdout: Buffer[] = []; const stderr: Buffer[] = [];
			child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
			child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
			child.stdin.end(options.stdin);
		});
	};
}

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
	const runner = runnerAt(root);
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
	const largeHistoricalLearning = `historical learning ${"complete-session-content ".repeat(460_000)}`;
	await writeFile(join(sessionDirectory, "old.jsonl"), [
		{ type: "session", version: 3, id: "old-session", cwd: f.root },
		{ type: "message", id: "old-user", parentId: null, message: { role: "user", content: largeHistoricalLearning, timestamp: 1 } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: f.base, sessionIds: ["old-session"], includeSession: true });
	const entries = await selectedSessionEntries({ sessionManager: { getSessionId: () => "current-session", getSessionFile: () => currentFile, getBranch: () => [] } } as any, scope);
	assert.equal(entries.some((entry) => entry.id === "old-user" && entry.message.content === largeHistoricalLearning), true, "an explicitly selected session larger than 10 MB is found and read intact");
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

test("collects sanitized Git, workflow, guidance, and main-session artifacts", async (t) => {
	const f = await fixture(t);
	const privateRoot = join(f.root, ".pibox");
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", workItems: ["demo"] });
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
	await assert.rejects(readFile(join(collected.runRoot, "subagents.md")), /ENOENT/);
	const guidance = await readFile(join(collected.runRoot, "guidance.md"), "utf8");
	assert.match(guidance, /Characters: \d+[\s\S]*Estimated tokens: \d+/);
	const manifest = JSON.parse(await readFile(join(collected.runRoot, "manifest.json"), "utf8"));
	assert.ok(manifest.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.sha256)));
	assert.equal((await collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot, scope, entries: [] })).reused, true);
	await writeFile(join(collected.runRoot, "changes.md"), "tampered\n");
	await assert.rejects(collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot, scope, entries: [] }), /evidence changed after collection/);
	assert.equal(await f.git("status", "--porcelain"), "");
});

test("collected artifacts preserve complete selected source, workflow, guidance, and transcript content", async (t) => {
	const f = await fixture(t);
	const sourceMarker = `SOURCE-END-${"source body ".repeat(20_000)}`;
	const guidanceMarker = `GUIDANCE-END-${"Preserve complete context. ".repeat(1_000)}`;
	const workflowMarker = `WORKFLOW-END-${"delivery detail ".repeat(2_000)}`;
	await writeFile(join(f.root, "app.ts"), sourceMarker);
	await writeFile(join(f.root, "AGENTS.md"), guidanceMarker);
	await writeFile(join(f.root, "agent-artifacts", "demo", "outcome.md"), workflowMarker);
	await f.git("add", "."); await f.git("commit", "-m", "large complete evidence");
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", workItems: ["demo"] });
	const userText = `USER-END-${"user evidence ".repeat(500)}`;
	const toolText = `TOOL-END-${"tool evidence ".repeat(500)}`;
	const collected = await collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot: join(f.root, ".pibox"), scope, entries: [
		{ type: "message", id: "u", message: { role: "user", content: userText } },
		{ type: "message", id: "t", message: { role: "toolResult", toolName: "read", content: toolText } },
	] });
	assert.match(await readFile(join(collected.runRoot, "changes.md"), "utf8"), new RegExp(sourceMarker.slice(-80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok((await readFile(join(collected.runRoot, "guidance.md"), "utf8")).includes(guidanceMarker));
	assert.ok((await readFile(join(collected.runRoot, "workflow.md"), "utf8")).includes(workflowMarker));
	const transcript = await readFile(join(collected.runRoot, "transcript.md"), "utf8");
	assert.ok(transcript.includes(userText)); assert.ok(transcript.includes(toolText));
	assert.doesNotMatch([await readFile(join(collected.runRoot, "changes.md"), "utf8"), transcript].join("\n"), /truncated by distill|cap reached/);
	assert.ok(renderSessionTranscript([{ type: "message", id: "u", message: { role: "user", content: userText } }]).includes(userText));
});

test("large scopes and dirty snapshots consume every entry through bounded Git transport", async (t) => {
	const commits = Array.from({ length: 30_001 }, (_, index) => String(index).padStart(40, "0"));
	const files = Array.from({ length: 5_001 }, (_, index) => `src/file-${index}.ts`);
	const calls: Array<{ args: string[]; stdin: string | undefined }> = [];
	const runner: GitRunner = async (args, options) => {
		calls.push({ args, stdin: options?.stdin });
		if (args[0] === "rev-parse") return { code: 0, stdout: args.at(-1)?.endsWith("^") ? `${"b".repeat(40)}\n` : `${"a".repeat(40)}\n`, stderr: "" };
		if (args[0] === "rev-list") return { code: 0, stdout: `${commits.join("\n")}\n`, stderr: "" };
		if (args[0] === "show" && args.includes("--name-only")) return { code: 0, stdout: `${files.join("\n")}\n`, stderr: "" };
		if (args[0] === "show" && args.includes("--no-patch")) return { code: 0, stdout: `${options?.stdin?.split("\n").filter((line) => /^[0-9]{40}$/.test(line)).join("\n")}\n`, stderr: "" };
		if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const manySessions = Array.from({ length: 21 }, (_, index) => `session-${index}`);
	const manyProviders = Array.from({ length: 9 }, (_, index) => `provider-${index}`);
	const scope = await resolveDistillScope(runner, { target: "HEAD", until: "2030-01-01", sessionIds: manySessions, knowledgeProviders: manyProviders, knowledgeProviderFingerprint: manyProviders.map((id) => ({ id, locality: "local" })) });
	assert.equal(scope.commitCount, commits.length); assert.equal(scope.changedFiles, files.length); assert.equal(scope.sessionIds.length, manySessions.length);
	const root = await mkdtemp(join(tmpdir(), "pibox-distill-large-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await collectDistillRun(runner, { repositoryRoot: root, privateRoot: root, scope, entries: [] });
	const shownCommits = calls.filter(({ args }) => args[0] === "show" && args.includes("--no-patch")).flatMap(({ stdin }) => stdin?.split("\n").filter((line) => /^[0-9]{40}$/.test(line)) ?? []);
	assert.deepEqual(shownCommits, commits);
	assert.ok(calls.every(({ args }) => args.length <= 263), "every Git argv remains bounded");

	const manyPaths = Array.from({ length: 501 }, (_, index) => `scope-${index}`);
	const pathCalls: Array<{ args: string[]; stdin: string | undefined }> = [];
	const pathRunner: GitRunner = async (args, options) => {
		pathCalls.push({ args, stdin: options?.stdin });
		if (args[0] === "rev-parse") return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
		if (args[0] === "rev-list") return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const pathScope = await resolveDistillScope(pathRunner, { target: "HEAD", baseline: "base", paths: manyPaths });
	assert.equal(pathScope.paths.length, manyPaths.length);
	assert.deepEqual(pathCalls.find(({ args }) => args[0] === "rev-list")?.stdin?.trim().split("\n").slice(1), [...manyPaths].sort());
	assert.ok(pathCalls.every(({ args }) => args.length <= 263), "pathspec Git argv remains bounded");

	const untrackedPaths = Array.from({ length: 1_001 }, (_, index) => `file-${index}`);
	const dirtyCalls: string[][] = [];
	const dirtyRunner: GitRunner = async (args) => {
		dirtyCalls.push(args);
		if (args[0] === "status") return { code: 0, stdout: untrackedPaths.map((path) => `?? ${path}\0`).join(""), stderr: "" };
		if (args[0] === "hash-object") return { code: 0, stdout: `${args.slice(args.indexOf("--") + 1).map((path) => String(Number(path.slice(5))).padStart(40, "0")).join("\n")}\n`, stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const snapshot = await currentDirtySnapshot(dirtyRunner, []);
	assert.deepEqual(snapshot.untracked.map((entry) => entry.path), untrackedPaths);
	assert.deepEqual(snapshot.untracked.map((entry) => entry.sha256), untrackedPaths.map((path) => String(Number(path.slice(5))).padStart(40, "0")));
	assert.ok(dirtyCalls.every((args) => args.length <= 260), "untracked hash argv remains bounded");
});

test("real Git keeps overlapping and excluded pathspecs combined across large scopes", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "src"), { recursive: true });
	await writeFile(join(f.root, "src", "visible.ts"), "export const visible = 1;\n");
	await writeFile(join(f.root, "src", "secret.ts"), "export const secret = 1;\n");
	await writeFile(join(f.root, "src", "quote\"name.ts"), "export const quoted = 1;\n");
	await f.git("add", "src"); await f.git("commit", "-m", "pathspec base");
	const base = await f.git("rev-parse", "HEAD");
	await writeFile(join(f.root, "src", "visible.ts"), "export const visible = 2;\n");
	await writeFile(join(f.root, "src", "secret.ts"), "export const secret = 2;\n");
	await writeFile(join(f.root, "src", "quote\"name.ts"), "export const quoted = 2;\n");
	await f.git("add", "src"); await f.git("commit", "-m", "pathspec changes");
	const paths = ["src", "src/visible.ts", "src/quote\"name.ts", ":!src/secret.ts", ...Array.from({ length: 254 }, (_, index) => `unused-${index}`)];
	const scope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: base, paths, includeSession: false });
	assert.equal(scope.paths.length, 258);
	assert.equal(scope.changedFiles, 2);
	const collected = await collectDistillRun(f.runner, { repositoryRoot: f.root, privateRoot: join(f.root, ".pibox"), scope, entries: [] });
	const changes = await readFile(join(collected.runRoot, "changes.md"), "utf8");
	assert.equal((changes.match(/^M\tsrc\/visible\.ts$/gm) ?? []).length, 1);
	assert.equal((changes.match(/^diff --git a\/src\/visible\.ts b\/src\/visible\.ts$/gm) ?? []).length, 1);
	assert.match(changes, /quote\\"name\.ts/);
	assert.doesNotMatch(changes, /secret\.ts|export const secret/);
	await writeFile(join(f.root, "src", "secret.ts"), "excluded dirty content\n");
	const dirtyScope = await resolveDistillScope(f.runner, { target: "HEAD", baseline: "HEAD", paths, includeDirty: true, includeSession: false });
	assert.equal(dirtyScope.dirty, false);
	const dirtySnapshot = await currentDirtySnapshot(f.runner, dirtyScope.paths);
	assert.equal(dirtySnapshot.status, "");
	assert.equal(dirtySnapshot.trackedDiff, "");
	await assert.rejects(resolveDistillScope(f.runner, { target: "HEAD", baseline: base, paths: ["src/new\nline"] }), /must not contain line separators/);
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
	assert.match(sanitizeDistillText("password=hunter2"), /password=\[REDACTED\]/);
	for (const source of ["Authorization: Bearer sensitive-token", "Authorization=Bearer sensitive-token", "Authorization\tBearer sensitive-token", '{"Authorization":"Bearer sensitive-token"}', String.raw`{\"Authorization\":\"Bearer sensitive-token\"}`, '{"Authorization":{"Bearer":"sensitive-token"}}', "prefix\u2028Authorization:\u2028Bearer opaque-credential-12345\u2029suffix", "prefix\r\nAuthorization: Bearer crlf-secret\r\nsuffix"]) {
		const authorization = sanitizeDistillText(source);
		assert.match(authorization, /REDACTED/);
		assert.doesNotMatch(authorization, /sensitive-token|opaque-credential|crlf-secret|Bearer/);
	}
	assert.equal(sanitizeDistillText("before\u2028plain text\u2029after\r\nlast"), "before\u2028plain text\u2029after\r\nlast");
	const longNonSecret = `ordinary diagnostic text \u2028 ${"non-auth diagnostic value. ".repeat(80_000)}\u2029 done`;
	assert.equal(sanitizeDistillText(longNonSecret), longNonSecret);
});
