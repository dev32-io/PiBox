import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createRequestGate, createStoryBoardApp, parseRoute, pathFor } from "../assets/app.js";
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

test("failure disclosure participates in focus trapping and survives only same-detail live refreshes", async (t) => {
	const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/story-board/focus-story/workflow/task/task-one", pretendToBeVisual: true });
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document"); let app: ReturnType<typeof createStoryBoardApp> | undefined;
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window }); Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
	t.after(() => { app?.destroy(); if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as any).window; if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete (globalThis as any).document; dom.window.close(); });
	const timers = new Map<number, () => void>(); let timerId = 0;
	const originalSetTimeout = globalThis.setTimeout; const originalClearTimeout = globalThis.clearTimeout;
	(globalThis as any).setTimeout = (callback: () => void) => { timerId += 1; timers.set(timerId, callback); return timerId; };
	(globalThis as any).clearTimeout = (id: number) => timers.delete(id);
	t.after(() => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
	let workspaceCalls = 0; let detailCalls = 0;
	const failure = (taskId: string) => ({ code: "repair_exhausted", causeCode: "unavailable_destination", summary: "No matching destination.", diagnostic: { checkId: taskId === "task-one" ? "check-1" : "check-2", command: `check ${taskId}`, exitCode: 70, stdout: "one\ntwo", stderr: "three\nfour", outputTruncated: true } });
	const workspace = { story: { id: "focus-story", title: "Focus", format: "current", degraded: false }, workflow: { status: "attention", outcomeStatus: "pending", attention: { total: 1 }, totals: { tasks: { total: 0, completed: 0 }, repairs: 0 }, metrics: {} }, stages: [], tasks: [], columns: { "To do": [], "In progress": [], Done: [] }, documentGroups: [], reports: [], diagnostics: [] };
	const fetchImpl = async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("api/workspace")) { workspaceCalls += 1; return new Response(JSON.stringify({ workspace, observation: { status: "attention", outcomeStatus: "pending" } }), { status: 200, headers: { "content-type": "application/json", etag: `W/\"${workspaceCalls}\"` } }); }
		if (url.includes("api/task")) { detailCalls += 1; const taskId = new URL(url, "http://localhost").searchParams.get("task") || "task-one"; return new Response(JSON.stringify({ task: { id: taskId, title: taskId, status: "attention", dependsOn: [], verification: { methods: [], taskChecks: [] }, relatedReportIds: [], diagnostics: [], failure: failure(taskId) } }), { status: 200, headers: { "content-type": "application/json" } }); }
		throw new Error(`Unexpected request ${url}`);
	};
	const root = dom.window.document.querySelector<HTMLElement>("#app")!; app = createStoryBoardApp({ root, fetchImpl: fetchImpl as typeof fetch, navigationWindow: dom.window as unknown as Window });
	const waitFor = async (predicate: () => boolean) => { for (let count = 0; count < 50 && !predicate(); count += 1) await new Promise<void>((resolve) => originalSetTimeout(resolve, 0)); assert.equal(predicate(), true); };
	await waitFor(() => detailCalls === 1 && Boolean(root.querySelector("summary[data-disclosure-summary]")));
	let close = root.querySelector<HTMLElement>('.drawer [data-action="close-detail"]')!; let summary = root.querySelector<HTMLElement>("summary[data-disclosure-summary]")!;
	close.focus(); close.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); assert.equal(dom.window.document.activeElement, summary, "Shift+Tab wraps to the native summary");
	summary.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); assert.equal(dom.window.document.activeElement, close, "Tab wraps from summary to close");
	const details = summary.closest("details")!; details.open = true; summary.focus(); const stdout = details.querySelector<HTMLElement>('[data-detail-scroll$=":stdout"]')!; stdout.scrollTop = 37;
	const pendingPolls = [...timers.values()]; assert.ok(pendingPolls.length); for (const poll of pendingPolls) poll();
	await waitFor(() => workspaceCalls >= 2 && detailCalls >= 2);
	summary = root.querySelector<HTMLElement>("summary[data-disclosure-summary]")!; const refreshedDetails = summary.closest("details")!;
	assert.equal(refreshedDetails.open, true); assert.equal(refreshedDetails.querySelector<HTMLElement>('[data-detail-scroll$=":stdout"]')!.scrollTop, 37); assert.equal(dom.window.document.activeElement, summary);
	const firstKey = refreshedDetails.dataset.disclosureKey;
	dom.window.history.pushState({}, "", "/story-board/focus-story/workflow/task/task-two"); await app.loadRoute(); await waitFor(() => detailCalls >= 3 && Boolean(root.querySelector("[data-disclosure-key]")));
	const unrelated = root.querySelector<HTMLDetailsElement>("details[data-disclosure-key]")!; assert.notEqual(unrelated.dataset.disclosureKey, firstKey); assert.equal(unrelated.open, false); assert.equal(unrelated.querySelector<HTMLElement>('[data-detail-scroll$=":stdout"]')!.scrollTop, 0);
});

test("eight logical E2E cases expand across the table and preserve disclosure, focus, and scroll on live refresh", async (t) => {
	const dom = new JSDOM('<main id="app"></main>', { url: "http://localhost/story-board/focus-story/workflow/report/final-e2e", pretendToBeVisual: true });
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"); const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document"); let app: ReturnType<typeof createStoryBoardApp> | undefined;
	Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window }); Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
	t.after(() => { app?.destroy(); if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as any).window; if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete (globalThis as any).document; dom.window.close(); });
	const timers = new Map<number, () => void>(); let timerId = 0; const originalSetTimeout = globalThis.setTimeout; const originalClearTimeout = globalThis.clearTimeout;
	(globalThis as any).setTimeout = (callback: () => void) => { timerId += 1; timers.set(timerId, callback); return timerId; }; (globalThis as any).clearTimeout = (id: number) => timers.delete(id);
	t.after(() => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
	let workspaceCalls = 0; let reportCalls = 0;
	const cases = Array.from({ length: 8 }, (_, index) => ({ caseId: `E2E-${String(index + 1).padStart(3, "0")}`, title: `Journey ${index + 1}`, status: index === 7 ? "blocked" : "passed", executedActions: [`Action ${index + 1}`], observations: [index === 7 ? `<script>bad()</script> ${"Long observation ".repeat(80)}` : `Observed ${index + 1}`], evidenceRefs: index === 7 ? [{ label: "evidence/proof.txt", memberPath: "evidence/proof.txt" }] : [], recorded: true }));
	const workspace = { story: { id: "focus-story", title: "Focus", format: "current", degraded: false }, workflow: { status: "attention", outcomeStatus: "pending", attention: { total: 1 }, totals: { tasks: { total: 0, completed: 0 }, repairs: 1 }, metrics: {} }, stages: [], tasks: [], columns: { "To do": [], "In progress": [], Done: [] }, documentGroups: [], reports: [{ id: "final-e2e", status: "testing", available: true, scope: { kind: "e2e" }, findingCount: 0, hasRiskAcceptance: false }], diagnostics: [] };
	const report = { id: "final-e2e", title: "Final E2E", status: "testing", available: true, scope: { kind: "e2e" }, findingCount: 0, hasRiskAcceptance: false, findings: [], history: [], evidence: [], currentE2E: { phase: "testing", repairCount: 1, priorContext: false }, recordedE2E: { sourcePath: "evidence/report.json", sourceMemberPath: "evidence/report.json", result: "blocked", summary: "Recorded", findings: ["Finding"], cases, diagnostics: [] }, diagnostics: [] };
	const fetchImpl = async (input: string | URL | Request) => { const url = String(input); if (url.includes("api/workspace")) { workspaceCalls += 1; return new Response(JSON.stringify({ workspace, observation: { status: "attention", outcomeStatus: "pending" } }), { status: 200, headers: { "content-type": "application/json", etag: `W/\"${workspaceCalls}\"` } }); } if (url.includes("api/report")) { reportCalls += 1; return new Response(JSON.stringify({ report }), { status: 200, headers: { "content-type": "application/json" } }); } throw new Error(`Unexpected request ${url}`); };
	const root = dom.window.document.querySelector<HTMLElement>("#app")!; app = createStoryBoardApp({ root, fetchImpl: fetchImpl as typeof fetch, navigationWindow: dom.window as unknown as Window });
	const waitFor = async (predicate: () => boolean) => { for (let count = 0; count < 50 && !predicate(); count += 1) await new Promise<void>((resolve) => originalSetTimeout(resolve, 0)); assert.equal(predicate(), true); };
	await waitFor(() => reportCalls === 1 && root.querySelectorAll("[data-e2e-case-disclosure]").length === 8);
	let button = root.querySelectorAll<HTMLButtonElement>("[data-e2e-case-disclosure]")[7]!; button.click(); button.focus();
	let detailRow = root.querySelectorAll<HTMLTableRowElement>("[data-e2e-case-detail-row]")[7]!; assert.equal(detailRow.hidden, false); assert.equal(detailRow.querySelector("td")?.colSpan, 4); assert.match(detailRow.textContent || "", /Long observation/); assert.equal(detailRow.querySelector("script"), null); assert.equal(detailRow.querySelectorAll("a").length, 1);
	const drawer = root.querySelector<HTMLElement>(".drawer-content")!; drawer.scrollTop = 61; for (const poll of [...timers.values()]) poll();
	await waitFor(() => workspaceCalls >= 2 && reportCalls >= 2);
	button = root.querySelectorAll<HTMLButtonElement>("[data-e2e-case-disclosure]")[7]!; detailRow = root.querySelectorAll<HTMLTableRowElement>("[data-e2e-case-detail-row]")[7]!;
	assert.equal(button.getAttribute("aria-expanded"), "true"); assert.equal(detailRow.hidden, false); assert.equal(root.querySelector<HTMLElement>(".drawer-content")!.scrollTop, 61); assert.equal(dom.window.document.activeElement, button);
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
