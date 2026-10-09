import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	WorkspaceValidationError,
	createSessionScratchWorkspace,
	purgeSessionScratchWorkspace,
	restoreSessionScratchWorkspace,
	type SessionScratchBinding,
} from "../workspace.js";

const PREFIX = "pibox-session-";

function unusedBinding(sessionId = "pi-session-test"): SessionScratchBinding {
	return { workspaceId: randomBytes(16).toString("hex"), sessionId };
}

function rootFor(binding: SessionScratchBinding): string {
	return join("/tmp", `${PREFIX}${binding.workspaceId}`);
}

async function remove(binding: SessionScratchBinding): Promise<void> {
	await rm(rootFor(binding), { recursive: true, force: true });
}

function permissions(mode: number): number {
	return mode & 0o777;
}

test("creates an opaque canonical workspace with private layout and non-authoritative templates", async (t) => {
	const sessionId = "pi-session-visible-name";
	const workspace = await createSessionScratchWorkspace(sessionId);
	t.after(() => remove(workspace.binding));

	assert.match(workspace.binding.workspaceId, /^[0-9a-f]{32}$/);
	assert.equal(workspace.binding.sessionId, sessionId);
	assert.equal(workspace.paths.root, `/tmp/${PREFIX}${workspace.binding.workspaceId}`);
	assert.equal(workspace.paths.root.includes(sessionId), false);
	assert.deepEqual((await readdir(workspace.paths.root)).sort(), ["ledger.md", "plan.md", "results", "scripts"]);

	for (const path of [workspace.paths.root, workspace.paths.scripts, workspace.paths.results]) {
		assert.equal(permissions((await stat(path)).mode), 0o700);
	}
	for (const path of [workspace.paths.plan, workspace.paths.ledger]) {
		assert.equal(permissions((await stat(path)).mode), 0o600);
	}

	const plan = await readFile(workspace.paths.plan, "utf8");
	const ledger = await readFile(workspace.paths.ledger, "utf8");
	assert.match(plan, /non-authoritative private scratch/i);
	assert.match(plan, /# Goal[\s\S]+# Done when[\s\S]+# Plan/);
	assert.match(ledger, /non-authoritative/i);
	assert.match(ledger, /currently useful facts[\s\S]+decisions and rationale[\s\S]+unresolved issues/i);
	assert.match(ledger, /context, not a chronological activity log/i);
	for (const note of [plan, ledger]) {
		assert.match(note, /goal changes and completion[\s\S]+obsolete or superseded detail/i);
		assert.match(note, /summaries or pointers only where useful[\s\S]+without forced archives, hard caps, or automatic deletion/i);
	}
	assert.equal((await readdir(workspace.paths.root)).some((entry) => entry.endsWith(".tmp")), false);
});

test("restores bound private root without requiring legacy metadata or layout files", async (t) => {
	const workspace = await createSessionScratchWorkspace("pi-session-owner");
	t.after(() => remove(workspace.binding));
	await rm(workspace.paths.plan);
	await rm(workspace.paths.scripts, { recursive: true });
	assert.deepEqual(await restoreSessionScratchWorkspace(workspace.binding), workspace);
});

test("separate create calls allocate distinct workspaces", async (t) => {
	const first = await createSessionScratchWorkspace("pi-session-forked");
	const second = await createSessionScratchWorkspace("pi-session-forked");
	t.after(async () => {
		await Promise.all([remove(first.binding), remove(second.binding)]);
	});

	assert.notEqual(first.binding.workspaceId, second.binding.workspaceId);
	assert.notEqual(first.paths.root, second.paths.root);
});

test("rejects symlink and non-directory workspace roots", async (t) => {
	const symlinkBinding = unusedBinding();
	const targetBinding = unusedBinding();
	const fileBinding = unusedBinding();
	t.after(async () => {
		await Promise.all([remove(symlinkBinding), remove(targetBinding), remove(fileBinding)]);
	});

	await mkdir(rootFor(targetBinding), { mode: 0o700 });
	await symlink(rootFor(targetBinding), rootFor(symlinkBinding));
	await writeFile(rootFor(fileBinding), "not a directory", { mode: 0o600 });

	await assert.rejects(restoreSessionScratchWorkspace(symlinkBinding), WorkspaceValidationError);
	await assert.rejects(restoreSessionScratchWorkspace(fileBinding), WorkspaceValidationError);
});

test("purge removes bound private root even if layout changed", async (t) => {
	const workspace = await createSessionScratchWorkspace("pi-session-purge");
	t.after(() => remove(workspace.binding));
	await rm(workspace.paths.plan);
	await symlink(workspace.paths.ledger, workspace.paths.plan);
	await purgeSessionScratchWorkspace(workspace.binding);
	await assert.rejects(lstat(workspace.paths.root), { code: "ENOENT" });
});

test("initial files can be opened without following links and are regular", async (t) => {
	const workspace = await createSessionScratchWorkspace("pi-session-file-check");
	t.after(() => remove(workspace.binding));

	for (const path of [workspace.paths.plan, workspace.paths.ledger]) {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			assert.equal((await handle.stat()).isFile(), true);
		} finally {
			await handle.close();
		}
	}
});
