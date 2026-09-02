import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequestGate, parseRoute, pathFor } from "../assets/app.js";

const appPath = new URL("../assets/app.js", import.meta.url);

test("Story Board routes parse and restore workflow task/report selections and legacy sections", () => {
	const routes: Array<Record<string, string>> = [
		{ view: "catalog" },
		{ view: "workflow", storyId: "alpha-story" },
		{ view: "workflow", storyId: "alpha-story", taskId: "build-ui" },
		{ view: "workflow", storyId: "alpha-story", reportId: "review-one" },
		{ view: "board", storyId: "alpha-story" },
		{ view: "board", storyId: "alpha-story", taskId: "build-ui" },
		{ view: "documents", storyId: "alpha-story" },
		{ view: "documents", storyId: "alpha-story", documentId: "design" },
		{ view: "reports", storyId: "alpha-story" },
		{ view: "reports", storyId: "alpha-story", reportId: "review-one" },
	];
	const routePath = pathFor as (route: Record<string, string>) => string;
	for (const route of routes) assert.deepEqual(parseRoute(routePath(route)), route);
	assert.deepEqual(parseRoute("/story-board/alpha-story"), { view: "workflow", storyId: "alpha-story" });
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

test("reactive workflow client uses one conditional timeout chain and bounded conflict/backoff behavior", async () => {
	const app = await readFile(appPath, "utf8");
	assert.equal(app.match(/setTimeout\(/g)?.length, 1, "polling must use one chained setTimeout");
	assert.match(app, /headers: state\.etag \? \{ "If-None-Match": state\.etag \}/);
	assert.match(app, /response\.status === 304/);
	assert.match(app, /response\.status !== 409 \|\| attempt === 1/);
	assert.match(app, /error\?\.status !== 409 \|\| attempt === 1/, "initial workspace load also retries one conflict immediately");
	assert.match(app, /const delays = \[5000, 15000, 30000\]/);
	assert.match(app, /\["running", "completed_pending"\]\.includes\(status\)[\s\S]*return 3000/);
	assert.match(app, /\["ready", "paused", "attention", "needs_user"\][\s\S]*return 12000/);
	assert.match(app, /signal: token\.signal/);
	assert.match(app, /pollGate\.cancel\(\)/);
	assert.match(app, /payload\.workspace[\s\S]*Object\.assign\(state, \{ workspace: payload\.workspace, observation: payload\.observation, etag/);
	assert.match(app, /if \(state\.route\.taskId \|\| state\.route\.reportId\) void loadDetail\(interaction\)/);
});

test("polling stops outside a visible active current workflow and validates shell messages", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /state\.route\.view !== "workflow"/);
	assert.match(app, /story\?\.format === "current"/);
	assert.match(app, /\["failed", "stopped"\]/);
	assert.match(app, /status === "completed" && outcome === "written"/);
	assert.match(app, /document\.visibilityState === "hidden"/);
	assert.match(app, /window\.addEventListener\("pagehide"/);
	assert.match(app, /window\.addEventListener\("pageshow", handlePageShow\)/);
	assert.match(app, /pageHidden = false; syncPolling\(\{ immediate: true \}\)/);
	assert.match(app, /handlePopState\(\).*currentPath\(\).*\/story-board/s);
	assert.match(app, /event\.source !== navigationWindow \|\| event\.origin !== navigationWindow\.location\.origin/);
	assert.match(app, /if \(shellActive\) syncPolling\(\{ immediate: true \}\); else stopPolling\(\)/);
	assert.match(app, /destroyed = true; stopPolling\(\)/);
});
