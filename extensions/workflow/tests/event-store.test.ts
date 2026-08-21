import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryEventStore, type HarnessEvent } from "../event-store.js";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-harness-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { id: "repo-id", root: "/repo", privateRoot: join(root, "private") };
}

test("serializes independent event writers into one contiguous durable history", async (t) => {
	const identity = await fixture(t);
	const first = new RepositoryEventStore(identity);
	const second = new RepositoryEventStore(identity);
	await Promise.all([first.initialize(), second.initialize()]);

	const writes = Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).append(`event-${index}`, { index }));
	const results = await Promise.all(writes);
	const events = await new RepositoryEventStore(identity).readAll();

	assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
	assert.equal(new Set(results.map((event) => event.sequence)).size, 20, "independent writers never allocate the same sequence");
	assert.deepEqual(new Set(events.map((event) => event.type)), new Set(Array.from({ length: 20 }, (_, index) => `event-${index}`)));
	assert.match(await readFile(join(identity.privateRoot, "repository.yaml"), "utf8"), /id: repo-id/);
});

test("publishes local wake-ups only after the event is durable", async (t) => {
	const identity = await fixture(t);
	const store = new RepositoryEventStore(identity);
	await store.initialize();
	let observed!: (value: HarnessEvent[]) => void;
	const durableObservation = new Promise<HarnessEvent[]>((resolve) => { observed = resolve; });
	store.subscribe(() => { void store.readAll().then(observed); });

	const committed = await store.append("workflow.started", { workItemId: "calendar" });
	const visibleInsideWakeUp = await durableObservation;
	assert.deepEqual(visibleInsideWakeUp, [committed]);
});

test("replays every event after a durable cursor when live wake-ups were missed", async (t) => {
	const identity = await fixture(t);
	const producer = new RepositoryEventStore(identity);
	await producer.initialize();
	await producer.append("one", {});
	await producer.append("two", {});
	const cursor = 2;
	await producer.append("three", {});
	await producer.append("four", {});

	const restoredConsumer = new RepositoryEventStore(identity);
	await restoredConsumer.initialize();
	assert.deepEqual((await restoredConsumer.readSince(cursor)).map((event) => [event.sequence, event.type]), [[3, "three"], [4, "four"]]);
});

test("duplicate wake-ups do not duplicate cursor-based consumption", async (t) => {
	const identity = await fixture(t);
	const store = new RepositoryEventStore(identity);
	await store.initialize();
	await store.append("checkpoint.required", { workItemId: "calendar" });
	let cursor = 0;
	const delivered: number[] = [];
	const consume = async () => {
		for (const event of await store.readSince(cursor)) {
			delivered.push(event.sequence);
			cursor = event.sequence;
		}
	};

	await consume();
	await consume();
	assert.deepEqual(delivered, [1]);
});

test("a separate event-store instance wakes a live consumer without polling", async (t) => {
	const identity = await fixture(t);
	const consumer = new RepositoryEventStore(identity);
	const producer = new RepositoryEventStore(identity);
	await consumer.initialize();
	let wake!: () => void;
	const woke = new Promise<void>((resolve) => { wake = resolve; });
	const stop = consumer.watch(wake);
	await producer.append("agent.reported", { workItemId: "calendar" });
	await Promise.race([woke, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("filesystem wake-up was not delivered")), 2_000))]);
	stop();
	assert.deepEqual((await consumer.readSince(0)).map((event) => event.type), ["agent.reported"]);
});

test("starts the serialized suffix after the maximum legacy process-local sequence", async (t) => {
	const identity = await fixture(t);
	const store = new RepositoryEventStore(identity);
	await store.initialize();
	await appendFile(store.eventsPath, [
		JSON.stringify({ sequence: 1, at: new Date().toISOString(), type: "legacy-a", data: {} }),
		JSON.stringify({ sequence: 5, at: new Date().toISOString(), type: "legacy-b", data: {} }),
		JSON.stringify({ sequence: 3, at: new Date().toISOString(), type: "legacy-c", data: {} }),
		"",
	].join("\n"), "utf8");
	const appended = await store.append("serialized", {});
	assert.equal(appended.sequence, 6);
});

test("surfaces malformed durable history instead of sequencing over it", async (t) => {
	const identity = await fixture(t);
	const store = new RepositoryEventStore(identity);
	await store.initialize();
	await store.append("valid", {});
	await appendFile(store.eventsPath, "{not-json}\n", "utf8");

	await assert.rejects(() => store.readAll(), /Malformed repository event log at line 2/);
	await assert.rejects(() => store.append("must-not-append", {}), /Malformed repository event log/);
	const content = await readFile(store.eventsPath, "utf8");
	assert.equal(content.includes("must-not-append"), false);
});
