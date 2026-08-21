import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryEventStore } from "../event-store.js";
import { WorkflowEventJournal } from "../workflow-events.js";

test("uses one stable semantic event identity for live fan-out and replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new RepositoryEventStore({ id: "repo-id", root: "/repo", privateRoot: root });
	await store.initialize();
	const journal = new WorkflowEventJournal(store);
	let liveId: string | undefined;
	journal.subscribe((event) => { liveId = event.id; });

	const appended = await journal.append({
		type: "checkpoint.required",
		workItemId: "calendar",
		ownerGeneration: 3,
		correlationId: "evaluation:stage-3:attempt-2",
		stepRef: "work-item:calendar/evaluation:stage-3",
		activity: { kind: "review", generation: 1 },
		transition: { from: "rereviewing", to: "awaiting_manager", attention: true, nextAction: "Approve or request changes" },
	});
	const [replayed] = await new WorkflowEventJournal(new RepositoryEventStore(store.identity)).readSince(0, "calendar");

	assert.equal(liveId, appended.id);
	assert.deepEqual(replayed, appended);
	assert.equal(appended.id, "repo-id:1");
});

test("bounds large transition text while retaining the terminal metric boundary", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-events-bounded-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new RepositoryEventStore({ id: "repo-id", root: "/repo", privateRoot: root });
	await store.initialize();
	const journal = new WorkflowEventJournal(store);
	await journal.append({ type: "step.started", workItemId: "calendar", ownerGeneration: 1, correlationId: "large-step" });
	await journal.append({ type: "step.settled", workItemId: "calendar", ownerGeneration: 1, correlationId: "large-step", transition: { summary: "x".repeat(300_000), nextAction: "y".repeat(300_000) } });
	const events = await journal.readSince(0, "calendar");
	assert.deepEqual(events.map((event) => event.type), ["step.started", "step.settled"]);
	assert.ok((events[1]?.transition?.summary?.length ?? 0) <= 4_096);
	assert.ok((events[1]?.transition?.nextAction?.length ?? 0) <= 4_096);
});

test("replay ignores generic harness events and filters by work item", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-workflow-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new RepositoryEventStore({ id: "repo-id", root: "/repo", privateRoot: root });
	await store.initialize();
	const journal = new WorkflowEventJournal(store);
	await store.append("workflow.untyped_legacy", { workItemId: "calendar" });
	await journal.append({ type: "workflow.started", workItemId: "calendar", ownerGeneration: 1, correlationId: "start-calendar" });
	await journal.append({ type: "workflow.started", workItemId: "other", ownerGeneration: 1, correlationId: "start-other" });

	const events = await journal.readSince(0, "calendar");
	assert.deepEqual(events.map((event) => [event.sequence, event.type, event.workItemId]), [[2, "workflow.started", "calendar"]]);
});
