import assert from "node:assert/strict";
import test from "node:test";
import { resourceDisplayDiff } from "../resource-diff.js";

test("builds a semantic update diff without revision and timestamp noise", () => {
	const display = resourceDisplayDiff(
		"update",
		"work-item:checkout/task:implement",
		{ id: "implement", revision: 2, updatedAt: "before", status: "draft", brief: "Old behavior" },
		{ id: "implement", revision: 3, updatedAt: "after", status: "ready", brief: "New behavior" },
	);
	assert.equal(display.action, "update");
	assert.match(display.diff, /-.*draft/);
	assert.match(display.diff, /\+.*ready/);
	assert.match(display.diff, /-.*Old behavior/);
	assert.match(display.diff, /\+.*New behavior/);
	assert.doesNotMatch(display.diff, /revision|updatedAt|before|after/);
});

test("renders creates as additions and deletes as removals", () => {
	const created = resourceDisplayDiff("create", "work-item:new", undefined, { id: "new", title: "New story" });
	assert.match(created.diff, /\+.*New story/);
	const deleted = resourceDisplayDiff("delete", "work-item:old/task:gone", { id: "gone", title: "Gone" }, undefined);
	assert.match(deleted.diff, /-.*Gone/);
});
