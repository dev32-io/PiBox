import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryEventStore } from "../event-store.js";

test("persists append-only sequenced repository events", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-harness-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity = { id: "repo-id", root: "/repo", privateRoot: join(root, "private") };
	const first = new RepositoryEventStore(identity);
	await first.initialize();
	await Promise.all([first.append("one", { value: 1 }), first.append("two", { value: 2 })]);
	await first.flush();
	assert.deepEqual((await first.readAll()).map((event) => [event.sequence, event.type]), [
		[1, "one"],
		[2, "two"],
	]);

	const recovered = new RepositoryEventStore(identity);
	await recovered.initialize();
	const third = await recovered.append("three", {});
	assert.equal(third.sequence, 3);
	assert.match(await readFile(join(identity.privateRoot, "repository.yaml"), "utf8"), /id: repo-id/);
});
