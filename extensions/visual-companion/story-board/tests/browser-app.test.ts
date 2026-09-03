import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequestGate, parseRoute, pathFor } from "../assets/app.js";
import * as appModule from "../assets/app.js";

const { stageDefaultExpanded, stageDisclosureLifecycle, stageHasActiveChildWork, stageIsExpanded } = appModule as unknown as {
	stageDefaultExpanded(stage: Record<string, unknown>): boolean;
	stageHasActiveChildWork(stage: Record<string, unknown>): boolean;
	stageDisclosureLifecycle(stage: Record<string, unknown>): string;
	stageIsExpanded(storyId: string, stage: Record<string, unknown>, choices?: Record<string, unknown>): boolean;
};
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

test("stage disclosure derives only from active or exceptional child lifecycle state", () => {
	const stage = (status = "running", taskStatus = "pending") => ({
		id: "delivery", status, tasks: [{ id: "build", status: taskStatus }],
		integration: { status: "pending" }, verification: { status: "pending" }, review: { status: "pending" },
	});
	for (const status of ["pending", "completed", "authored"]) assert.equal(stageDefaultExpanded(stage(status)), false);
	assert.equal(stageDefaultExpanded(stage("running", "pending")), false, "running with only capacity-waiting work remains collapsed");
	assert.equal(stageHasActiveChildWork(stage("running", "pending")), false, "stage status alone is not execution evidence");
	assert.equal(stageDefaultExpanded(stage("running", "repair_pending")), false);
	for (const status of ["implementing", "check_pending", "checking", "repairing"]) {
		assert.equal(stageHasActiveChildWork(stage("running", status)), true, status);
		assert.equal(stageDefaultExpanded(stage("running", status)), true, status);
	}

	const operations = [
		["integration", "integrating"], ["integration", "repairing"],
		["verification", "checking"], ["verification", "repairing"],
		["review", "reviewing"], ["review", "fixing"],
	] as const;
	for (const [phase, status] of operations) {
		const value = stage();
		value[phase].status = status;
		assert.equal(stageDefaultExpanded(value), true, `${phase} ${status}`);
	}
	for (const status of ["attention", "interrupted"]) {
		assert.equal(stageDefaultExpanded(stage(status)), true);
		const child = stage(); child.tasks[0]!.status = status;
		assert.equal(stageDefaultExpanded(child), true);
	}
});

test("manual disclosure is story-scoped, persists within a coarse lifecycle, and expires across classes", () => {
	const implementing = {
		id: "delivery", status: "running", tasks: [{ id: "build", status: "implementing" }],
		integration: { status: "pending" }, verification: { status: "pending" }, review: { status: "pending" },
	};
	assert.equal(stageDisclosureLifecycle(implementing), "active");
	const choices = { alpha: { delivery: { lifecycle: stageDisclosureLifecycle(implementing), expanded: false } } };
	assert.equal(stageIsExpanded("alpha", implementing, choices), false, "same-story manual choice wins");
	assert.equal(stageIsExpanded("beta", implementing, choices), true, "another story uses its derived default");

	const checking = structuredClone(implementing); checking.tasks[0]!.status = "checking";
	assert.equal(stageDisclosureLifecycle(checking), stageDisclosureLifecycle(implementing));
	assert.equal(stageIsExpanded("alpha", checking, choices), false, "ordinary active-work polling preserves the manual choice");

	const interrupted = structuredClone(checking); interrupted.tasks[0]!.status = "interrupted";
	assert.equal(stageDisclosureLifecycle(interrupted), "interrupted");
	assert.equal(stageIsExpanded("alpha", interrupted, choices), true, "a coarse lifecycle change invalidates the manual choice");

	const idleRunning = structuredClone(implementing); idleRunning.tasks[0]!.status = "repair_pending";
	assert.equal(stageDisclosureLifecycle(idleRunning), "capacity/idle-running");
	const completed = structuredClone(idleRunning); completed.status = "completed";
	assert.equal(stageDisclosureLifecycle(completed), "completed");
	completed.status = "pending";
	assert.equal(stageDisclosureLifecycle(completed), "pending/other");
	completed.tasks[0]!.status = "attention";
	assert.equal(stageDisclosureLifecycle(completed), "attention");
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
	assert.match(app, /if \(state\.route\.taskId \|\| state\.route\.reportId\) void loadDetail\(interaction, \{ preserveContent: true \}\)/);
	assert.match(app, /response\.status === 304[\s\S]*refreshTimingLabels\(\)/);
	assert.match(app, /data-timing-segment/); assert.match(app, /caption\.textContent/);
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
