import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowLedgerStore, type WorkflowLedgerEntry } from "../workflow-ledger.js";

test("workflow ledger serializes concurrent rows and returns the latest ten", async (t) => {
	const privateRoot = await mkdtemp(join(tmpdir(), "pibox-ledger-"));
	t.after(() => rm(privateRoot, { recursive: true, force: true }));
	const identity = { id: "repo", root: privateRoot, privateRoot };
	const entries: WorkflowLedgerEntry[] = Array.from({ length: 20 }, (_, index) => ({
		schemaVersion: 1,
		id: `attempt-${index}`,
		at: new Date(1_700_000_000_000 + index).toISOString(),
		role: "implementer",
		taskId: `task-${index}`,
		text: `Important context from agent ${index}.`,
	}));

	await Promise.all(entries.map((entry) => new WorkflowLedgerStore(identity, "example").append(entry)));
	const store = new WorkflowLedgerStore(identity, "example");
	const all = await store.read(true);
	const recent = await store.read();

	assert.equal(all.length, 20);
	assert.equal(new Set(all.map((entry) => entry.id)).size, 20);
	assert.deepEqual(recent, all.slice(-10));
	assert.equal((await readFile(store.path, "utf8")).trim().split("\n").length, 20);
});

test("workflow ledger append is idempotent per process attempt", async (t) => {
	const privateRoot = await mkdtemp(join(tmpdir(), "pibox-ledger-idempotent-"));
	t.after(() => rm(privateRoot, { recursive: true, force: true }));
	const store = new WorkflowLedgerStore({ id: "repo", root: privateRoot, privateRoot }, "example");
	const entry: WorkflowLedgerEntry = { schemaVersion: 1, id: "attempt", at: new Date().toISOString(), role: "repair-implementer", text: "Preserve this invariant." };

	assert.equal((await store.append(entry)).appended, true);
	assert.equal((await store.append({ ...entry, at: new Date(Date.now() + 1_000).toISOString() })).appended, false);
	await assert.rejects(store.append({ ...entry, text: "Different context." }), /already wrote a different/i);
	assert.equal((await store.read(true)).length, 1);
});
