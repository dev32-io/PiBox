import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { CanonicalMutationCoordinator, runManagedChild } from "../canonical-mutation.js";
import { HarnessError } from "../errors.js";
const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim(); }
async function repo(t: test.TestContext): Promise<string> { const root = await mkdtemp(join(tmpdir(), "pibox-canonical-")); t.after(() => rm(root, { recursive: true, force: true })); await git(root, "init", "--quiet"); await git(root, "config", "user.name", "Harness Test"); await git(root, "config", "user.email", "harness@example.test"); await writeFile(join(root, "README.md"), "fixture\n"); await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "initial"); return root; }

test("allowlisted authored metadata can bypass a failing hook while source commits cannot", async (t) => {
	const root = await repo(t); const hook = join(root, ".git", "hooks", "pre-commit"); await writeFile(hook, "#!/bin/sh\necho blocked >&2\nexit 1\n"); await chmod(hook, 0o755);
	const path = join(root, "agent-artifacts", "story", "story.yaml"); await mkdir(join(root, "agent-artifacts", "story"), { recursive: true }); await writeFile(path, "id: story\n");
	await new CanonicalMutationCoordinator(root).commitHarness([path], "harness(story): write story");
	await writeFile(join(root, "source.ts"), "source\n"); await git(root, "add", "source.ts"); await assert.rejects(git(root, "commit", "-m", "source"), /blocked/);
});

test("canonical repository children serialize while isolated worktree children remain independent", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
	const canonical = runManagedChild(coordinator, "repository", "canonical", async () => held); await new Promise((resolve) => setTimeout(resolve, 10));
	let isolated = false; await runManagedChild(coordinator, "worktree", "isolated", async () => { isolated = true; }); assert.equal(isolated, true);
	let serialized = false; const next = coordinator.run("metadata", async () => { serialized = true; }); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(serialized, false); release(); await canonical; await next; assert.equal(serialized, true);
});

test("canonical transactions reenter their own repository mutex", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root); const events: string[] = [];
	await coordinator.run("outer", async () => {
		events.push("outer:start");
		await coordinator.run("inner", async () => { events.push("inner"); });
		events.push("outer:end");
	});
	assert.deepEqual(events, ["outer:start", "inner", "outer:end"]);
});

test("an inherited async context cannot reuse a completed canonical lease", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	let trigger!: () => void;
	const triggered = new Promise<void>((resolve) => { trigger = resolve; });
	let late!: Promise<void>;
	let lateRan = false;
	await coordinator.run("parent", async () => {
		late = triggered.then(() => coordinator.run("late", async () => { lateRan = true; }));
	});

	let release!: () => void; let holderStarted!: () => void;
	const holderReady = new Promise<void>((resolve) => { holderStarted = resolve; });
	const holder = coordinator.run("holder", async () => {
		holderStarted();
		await new Promise<void>((resolve) => { release = resolve; });
	});
	await holderReady;
	trigger();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lateRan, false, "a detached continuation must queue after its parent lease expires");
	release();
	await holder;
	await late;
	assert.equal(lateRan, true);
});

test("aborting a queued canonical mutation does not run it or release the active holder", async (t) => {
	const root = await repo(t); const coordinator = new CanonicalMutationCoordinator(root);
	let release!: () => void;
	const active = coordinator.run("active", async () => {
		await new Promise<void>((resolve) => { release = resolve; });
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(typeof release, "function");

	const controller = new AbortController();
	const reason = new Error("cancel queued mutation");
	let cancelledRan = false;
	const cancelled = coordinator.run("cancelled", async () => { cancelledRan = true; }, controller.signal);
	controller.abort(reason);
	await assert.rejects(cancelled, (error: unknown) => error === reason);
	assert.equal(cancelledRan, false);

	let nextRan = false;
	const next = coordinator.run("next", async () => { nextRan = true; });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(nextRan, false, "an aborted waiter cannot release the active holder");
	release();
	await active;
	await next;
	assert.equal(nextRan, true);
});

test("harness commit refuses unrelated staged source paths", async (t) => {
	const root = await repo(t); const path = join(root, "agent-artifacts", "story", "story.yaml"); await mkdir(join(root, "agent-artifacts", "story"), { recursive: true }); await writeFile(path, "id: story\n"); await writeFile(join(root, "source.ts"), "source\n"); await git(root, "add", "source.ts");
	await assert.rejects(new CanonicalMutationCoordinator(root).commitHarness([path], "harness(story): write"), (error: unknown) => error instanceof HarnessError && /Unrelated staged paths/.test(error.message));
});
