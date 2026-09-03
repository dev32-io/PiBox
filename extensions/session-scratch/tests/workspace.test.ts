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
	assert.deepEqual((await readdir(workspace.paths.root)).sort(), ["ledger.md", "meta.json", "plan.md", "results", "scripts"]);

	for (const path of [workspace.paths.root, workspace.paths.scripts, workspace.paths.results]) {
		assert.equal(permissions((await stat(path)).mode), 0o700);
	}
	for (const path of [workspace.paths.meta, workspace.paths.plan, workspace.paths.ledger]) {
		assert.equal(permissions((await stat(path)).mode), 0o600);
	}

	const metadata = JSON.parse(await readFile(workspace.paths.meta, "utf8"));
	assert.equal(metadata.workspaceId, workspace.binding.workspaceId);
	assert.equal(metadata.sessionId, sessionId);
	assert.equal(metadata.schemaVersion, 1);
	assert.match(metadata.createdAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.match(await readFile(workspace.paths.plan, "utf8"), /non-authoritative/i);
	assert.match(await readFile(workspace.paths.ledger, "utf8"), /non-authoritative/i);
	assert.equal((await readdir(workspace.paths.root)).some((entry) => entry.endsWith(".tmp")), false);
});

test("restores only with the opaque id and owning Pi session id", async (t) => {
	const workspace = await createSessionScratchWorkspace("pi-session-owner");
	t.after(() => remove(workspace.binding));

	assert.deepEqual(await restoreSessionScratchWorkspace(workspace.binding), workspace);
	await assert.rejects(
		restoreSessionScratchWorkspace({ ...workspace.binding, sessionId: "pi-session-other" }),
		(error: unknown) => error instanceof WorkspaceValidationError && /does not match/.test(error.message),
	);
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

test("bounded no-follow metadata reads reject symlinks, non-regular files, and oversized files", async (t) => {
	const variants: Array<{ workspace: Awaited<ReturnType<typeof createSessionScratchWorkspace>>; replacement: "symlink" | "directory" | "oversized" }> = [];
	for (const replacement of ["symlink", "directory", "oversized"] as const) {
		const workspace = await createSessionScratchWorkspace(`pi-session-${replacement}`);
		variants.push({ workspace, replacement });
	}
	t.after(async () => Promise.all(variants.map(({ workspace }) => remove(workspace.binding))));

	for (const { workspace, replacement } of variants) {
		await rm(workspace.paths.meta);
		if (replacement === "symlink") {
			await symlink(workspace.paths.plan, workspace.paths.meta);
		} else if (replacement === "directory") {
			await mkdir(workspace.paths.meta, { mode: 0o700 });
		} else {
			await writeFile(workspace.paths.meta, "x".repeat(20 * 1024), { mode: 0o600 });
		}
		await assert.rejects(restoreSessionScratchWorkspace(workspace.binding), WorkspaceValidationError);
	}
});

test("purge is explicit and refuses an invalid layout", async (t) => {
	const invalid = await createSessionScratchWorkspace("pi-session-invalid-purge");
	const valid = await createSessionScratchWorkspace("pi-session-valid-purge");
	t.after(async () => Promise.all([remove(invalid.binding), remove(valid.binding)]));

	await rm(invalid.paths.plan);
	await symlink(invalid.paths.ledger, invalid.paths.plan);
	await assert.rejects(purgeSessionScratchWorkspace(invalid.binding), WorkspaceValidationError);
	assert.equal((await lstat(invalid.paths.root)).isDirectory(), true);

	await purgeSessionScratchWorkspace(valid.binding);
	await assert.rejects(lstat(valid.paths.root), (error: unknown) => {
		return error instanceof Error && "code" in error && error.code === "ENOENT";
	});
});

test("initial files can be opened without following links and are regular", async (t) => {
	const workspace = await createSessionScratchWorkspace("pi-session-file-check");
	t.after(() => remove(workspace.binding));

	for (const path of [workspace.paths.meta, workspace.paths.plan, workspace.paths.ledger]) {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			assert.equal((await handle.stat()).isFile(), true);
		} finally {
			await handle.close();
		}
	}
});
