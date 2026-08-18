import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { CanonicalMutationCoordinator, runManagedChild } from "../canonical-mutation.js";
import { HarnessError } from "../errors.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim(); }
async function repo(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-canonical-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet"); await git(root, "config", "user.name", "Harness Test"); await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n"); await writeFile(join(root, ".gitignore"), "/.pibox/\n"); await git(root, "add", "README.md", ".gitignore"); await git(root, "commit", "--quiet", "-m", "initial"); await git(root, "branch", "-M", "develop");
	return root;
}

test("allowlisted harness metadata settles through a deliberately failing pre-commit hook", async (t) => {
	const root = await repo(t); const hook = join(root, ".git", "hooks", "pre-commit");
	await writeFile(hook, "#!/bin/sh\necho hook-blocked >&2\nexit 1\n"); await chmod(hook, 0o755);
	const path = join(root, "agent-artifacts", "run", "index.yaml");
	await mkdir(join(root, "agent-artifacts", "run"), { recursive: true });
	await writeFile(path, "state: settled\n", "utf8");
	const coordinator = new CanonicalMutationCoordinator(root);
	await coordinator.commitHarness([path], "harness: settle metadata");
	assert.equal(await git(root, "show", "-s", "--format=%s"), "harness: settle metadata");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("source commits remain blocked by the deliberately failing pre-commit hook", async (t) => {
	const root = await repo(t); const hook = join(root, ".git", "hooks", "pre-commit");
	await writeFile(hook, "#!/bin/sh\necho source-hook-blocked >&2\nexit 1\n"); await chmod(hook, 0o755);
	const source = join(root, "source.ts"); await writeFile(source, "source\n"); await git(root, "add", "source.ts");
	await assert.rejects(git(root, "commit", "-m", "source: must verify"), /source-hook-blocked/);
	assert.match(await git(root, "status", "--porcelain"), /source\.ts/);
	assert.equal(await git(root, "log", "-1", "--format=%s"), "initial");
});

test("evaluation settlement waits behind a checkpoint and observes one coherent awaiting_manager state", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	let settlementEntered!: () => void; const entered = new Promise<void>((resolve) => { settlementEntered = resolve; });
	let releaseSettlement!: () => void; const release = new Promise<void>((resolve) => { releaseSettlement = resolve; });
	const settlement = coordinator.run("evaluation-settlement", async () => {
			await mkdir(join(root, "agent-artifacts"), { recursive: true });
		await writeFile(join(root, "agent-artifacts", "evaluation.yaml"), "loop: awaiting_manager\nattempt: 1\n");
		settlementEntered(); await release;
		await coordinator.commitHarness([join(root, "agent-artifacts", "evaluation.yaml")], "harness: evaluation settlement");
	});
	await entered;
	let checkpointStarted = false;
	const checkpoint = coordinator.run("checkpoint-decision", async () => {
		checkpointStarted = true;
		const state = await readFile(join(root, "agent-artifacts", "evaluation.yaml"), "utf8");
		assert.match(state, /loop: awaiting_manager/);
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(checkpointStarted, false, "checkpoint must wait for the settlement transaction");
	releaseSettlement(); await settlement; await checkpoint;
	assert.equal((await git(root, "diff", "--cached", "--name-only")), "");
	assert.equal(await git(root, "status", "--porcelain"), "");
	await assert.rejects(access(join(root, ".git", "index.lock")), /ENOENT/);
	const settlementCommits = (await git(root, "log", "--oneline", "--all")).split("\n").filter((line) => /evaluation settlement/.test(line));
	assert.equal(settlementCommits.length, 1);
});

test("forced canonical mutation rollback failure reports both failures and preserves external source work and private handoff", async (t) => {
	const root = await repo(t); const store = new (await import("../work-items.js")).WorkItemStore(root);
	await store.create({ id: "rollback", title: "Rollback", kind: "change", branchKind: "feature", intent: "rollback" });
	await store.defineEvaluation("rollback", { schemaVersion: 1, id: "review", type: "deterministic", scope: { workItem: "rollback" }, status: "planned", required: true, attempt: 0, methods: ["test"] });
	const handoff = join(root, ".pibox", "work-items", "rollback", "handoff-private.json");
	await mkdir(join(root, ".pibox", "work-items", "rollback"), { recursive: true }); await writeFile(handoff, "private reviewer evidence\n");
	await writeFile(join(root, "source.ts"), "external source\n"); await git(root, "add", "source.ts"); await git(root, "commit", "--quiet", "-m", "external source baseline");
	const original = new Error("canonical commit failed");
	(store as any).commit = async () => { await writeFile(join(root, "source.ts"), "external source retained\n"); await git(root, "reset", "HEAD", "--", "agent-artifacts"); await git(root, "add", "source.ts"); await git(root, "commit", "--quiet", "-m", "external source commit"); throw original; };
	await assert.rejects(store.recordEvaluation({ workItemId: "rollback", evaluationId: "review", verdict: "fail", report: "report", evidence: [], findings: [] }), (error: unknown) => {
		assert.match(String(error), /canonical commit failed/); assert.match(String(error), /rollback failed/); return true;
	});
	assert.equal(await git(root, "show", "-s", "--format=%s"), "external source commit");
	assert.equal(await readFile(join(root, "source.ts"), "utf8"), "external source retained\n");
	assert.equal(await readFile(handoff, "utf8"), "private reviewer evidence\n");
});

test("canonical mutating child holds the common-dir lock until exit and settlement", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void; const childDone = new Promise<void>((resolve) => { release = resolve; });
	const child = runManagedChild(coordinator, "repository", "managed-child", async () => { entered(); await childDone; });
	await started;
	let metadataRan = false;
	const metadata = coordinator.run("metadata", async () => { metadataRan = true; });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(metadataRan, false);
	release(); await child; await metadata; assert.equal(metadataRan, true);
});

test("reviewer/evaluator launch leaves the parent lock available to evaluation_record", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	const reviewer = (async () => { await new Promise((resolve) => setTimeout(resolve, 60)); })();
	const record = coordinator.run("evaluation_record", async () => "recorded");
	await reviewer; assert.equal(await record, "recorded");
});

test("parallel isolated worktree children do not wait on the canonical child lock", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
	const canonical = runManagedChild(coordinator, "repository", "canonical-child", async () => held);
	await new Promise((resolve) => setTimeout(resolve, 20));
	let isolatedRan = false;
	await runManagedChild(coordinator, "worktree", "parallel-child", async () => { isolatedRan = true; });
	assert.equal(isolatedRan, true); release(); await canonical;
});

test("canonical child lock releases after failure and cancellation", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	await assert.rejects(runManagedChild(coordinator, "repository", "failed-child", async () => { throw new Error("child failed"); }), /child failed/);
	let ran = false; await coordinator.run("after-failure", async () => { ran = true; }); assert.equal(ran, true);
	await assert.rejects(runManagedChild(coordinator, "repository", "cancelled-child", async () => { throw new Error("cancelled"); }), /cancelled/);
	await coordinator.run("after-cancel", async () => undefined);
});

test("harness no-verify rejects unrelated staged paths and leaves source work visible", async (t) => {
	const root = await repo(t); const metadata = join(root, "agent-artifacts", "run", "index.yaml"); const source = join(root, "source.ts");
	await mkdir(join(root, "agent-artifacts", "run"), { recursive: true }); await writeFile(metadata, "state: settled\n", "utf8"); await writeFile(source, "external\n", "utf8"); await git(root, "add", "--", "source.ts");
	const coordinator = new CanonicalMutationCoordinator(root);
	await assert.rejects(coordinator.commitHarness([metadata], "harness: settle metadata"), (error: unknown) => error instanceof HarnessError && /Unrelated staged paths/.test(error.message));
	assert.match(await git(root, "status", "--porcelain"), /source\.ts/);
	assert.equal(await git(root, "log", "-1", "--format=%s"), "initial");
});
