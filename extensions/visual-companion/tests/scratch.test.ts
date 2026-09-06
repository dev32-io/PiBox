import assert from "node:assert/strict";
import { rm, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import test from "node:test";
import { createSessionScratchWorkspace, MAX_SCRATCH_NOTE_BYTES, type SessionScratchBinding } from "../../session-scratch/workspace.js";
import { currentSessionScratchBinding, SESSION_SCRATCH_ENTRY_TYPE } from "../../session-scratch/binding.js";
import { createVisualCompanionBackend } from "../backend.mjs";
import { createScratchViewer } from "../scratch/index.js";

function entry(binding: SessionScratchBinding | null) {
	return { type: "custom", customType: SESSION_SCRATCH_ENTRY_TYPE, data: { schemaVersion: 1, binding } };
}

test("scratch discovery follows the active session branch without creating or inheriting notes", async () => {
	const workspace = await createSessionScratchWorkspace("owner");
	let branch: any[] = [];
	let sessionId = "owner";
	const ctx = { sessionManager: { getBranch: () => branch, getEntries: () => { throw new Error("must not inspect other branches"); }, getSessionId: () => sessionId } } as any;
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => currentSessionScratchBinding(ctx))] });
	const registry = async () => (await (await fetch(`${backend.url}/api/viewers`)).json()).viewers;
	const notes = () => fetch(`${backend.url}/v/scratch/api/notes`);
	try {
		assert.deepEqual(await registry(), []);
		assert.equal((await notes()).status, 404);
		branch = [entry(workspace.binding)];
		assert.deepEqual(await registry(), ["scratch"]);
		assert.equal((await notes()).status, 200);
		sessionId = "fork";
		assert.deepEqual(await registry(), [], "fork cannot browse its parent's mutable notes");
		assert.equal((await notes()).status, 404);
		sessionId = "owner";
		branch.push(entry(null));
		assert.deepEqual(await registry(), [], "purged binding immediately hides scratch");
		branch = [entry(workspace.binding)];
		await rm(workspace.paths.root, { recursive: true });
		assert.deepEqual(await registry(), [], "missing /tmp workspace is not recreated");
		assert.equal((await notes()).status, 404);
	} finally {
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});

test("scratch serves only bounded read-only notes, rejects foreign origins and arbitrary paths", async () => {
	const workspace = await createSessionScratchWorkspace("reader");
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	const url = `${backend.url}/v/scratch/api/notes`;
	try {
		await writeFile(workspace.paths.plan, "# Current\n- [ ] Next action\n");
		await writeFile(workspace.paths.ledger, "x".repeat(MAX_SCRATCH_NOTE_BYTES + 10));
		const response = await fetch(url);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const notes = await response.json();
		assert.deepEqual(notes.plan, { markdown: "# Current\n- [ ] Next action\n", truncated: false });
		assert.equal(notes.ledger.markdown.length, MAX_SCRATCH_NOTE_BYTES);
		assert.equal(notes.ledger.truncated, true);
		assert.equal(JSON.stringify(notes).includes(workspace.paths.root), false);
		await writeFile(workspace.paths.plan, "# Updated");
		assert.equal((await (await fetch(url)).json()).plan.markdown, "# Updated", "refresh reads current content");
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await fetch(url, { method })).status, 405);
		for (const headers of [{ origin: "https://untrusted.test" }, { "sec-fetch-site": "cross-site" }]) {
			assert.equal((await fetch(url, { headers })).status, 403, JSON.stringify(headers));
		}
		const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
			get(url, { headers: { host: "untrusted.test" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
		});
		assert.equal(foreignHostStatus, 403);
		assert.equal((await fetch(url, { headers: { origin: backend.url } })).status, 200);
		assert.equal((await fetch(`${url}?path=/etc/passwd`)).status, 400);
		for (const path of ["meta.json", "plan.md", "ledger.md", "scripts/private.sh", "results/private.txt"]) {
			assert.equal((await fetch(`${backend.url}/v/scratch/${path}`)).status, 404, path);
		}
		assert.equal((await fetch(`${backend.url}/scratch`)).status, 200);
		const page = await fetch(`${backend.url}/v/scratch/`);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /img-src 'none'/);
	} finally {
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});

test("scratch rejects invalid layouts and symlinked notes without disclosing paths", async () => {
	const workspace = await createSessionScratchWorkspace("invalid");
	const backend = await createVisualCompanionBackend({ viewers: [createScratchViewer(() => workspace.binding)] });
	try {
		await rm(workspace.paths.plan);
		await symlink(workspace.paths.meta, workspace.paths.plan);
		assert.deepEqual((await (await fetch(`${backend.url}/api/viewers`)).json()).viewers, []);
		const response = await fetch(`${backend.url}/v/scratch/api/notes`);
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: "Session scratch unavailable." });
	} finally {
		await backend.close();
		await rm(workspace.paths.root, { recursive: true, force: true });
	}
});
