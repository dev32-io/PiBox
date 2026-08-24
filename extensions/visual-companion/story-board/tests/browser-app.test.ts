import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGate, parseRoute, pathFor } from "../assets/app.js";

test("Story Board routes parse and restore every supported deep selection", () => {
	const routes = [
		{ view: "catalog" as const },
		{ view: "board" as const, storyId: "alpha-story" },
		{ view: "board" as const, storyId: "alpha-story", taskId: "build-ui" },
		{ view: "documents" as const, storyId: "alpha-story" },
		{ view: "documents" as const, storyId: "alpha-story", documentId: "design" },
		{ view: "reports" as const, storyId: "alpha-story" },
		{ view: "reports" as const, storyId: "alpha-story", reportId: "review-one" },
	];
	for (const route of routes) assert.deepEqual(parseRoute(pathFor(route)), route);
	assert.deepEqual(parseRoute("/story-board/../reports/x"), { view: "catalog" });
});

test("request generations suppress stale responses and cancel prior work", () => {
	const gate = createRequestGate();
	const first = gate.next();
	const second = gate.next();
	assert.equal(first.signal.aborted, true);
	assert.equal(gate.current(first.generation), false);
	assert.equal(gate.current(second.generation), true);
	gate.cancel();
	assert.equal(second.signal.aborted, true);
});
