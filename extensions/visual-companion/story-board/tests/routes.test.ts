import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisualCompanionBackend } from "../../backend.mjs";
import { createStoryBoardViewer } from "../index.js";

test("Story Board registration is idle and routes load progressively with single-flight", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-routes-")); t.after(() => rm(root, { recursive: true, force: true }));
	const calls = { catalog: 0, workspace: 0, task: 0, document: 0, report: 0 };
	let release!: () => void;
	const reader: any = {
		async readCatalog() { calls.catalog += 1; await new Promise<void>((resolve) => { release = resolve; }); return [{ id: "story" }]; },
		async readWorkspace() { calls.workspace += 1; return { story: { id: "story" }, tasks: [], documentGroups: [], reports: [] }; },
		async readTaskDetail() { calls.task += 1; return { id: "task", title: "Task", status: "ready", column: "To do", dependsOn: [], relatedReportIds: [], degraded: false, diagnostics: [], brief: "<b>Brief</b>", verification: { methods: [], taskChecks: [] } }; },
		async readDocumentDetail() { calls.document += 1; return { id: "doc", title: "Doc", type: "spec", group: "Specifications", path: "safe", status: "ok", available: true, diagnostics: [], body: "<script>bad()</script># Safe" }; },
		async readReportDetail() { calls.report += 1; return undefined; },
	};
	const viewer = createStoryBoardViewer({ repositoryRoot: root, reader });
	assert.deepEqual(calls, { catalog: 0, workspace: 0, task: 0, document: 0, report: 0 });
	const backend = await createVisualCompanionBackend({ viewers: [viewer] }); t.after(() => backend.close());
	assert.equal((await fetch(`${backend.url}/api/viewers`).then((r) => r.json()) as any).viewers[0], "story-board");
	assert.equal(calls.catalog, 0);
	const first = fetch(`${backend.url}/v/story-board/api/catalog`); const second = fetch(`${backend.url}/v/story-board/api/catalog`);
	while (!release) await new Promise((resolve) => setTimeout(resolve, 1)); assert.equal(calls.catalog, 1); release();
	assert.equal((await first.then((r) => r.json()) as any).stories[0].id, "story"); await second; assert.equal(calls.catalog, 1);
	await fetch(`${backend.url}/v/story-board/api/workspace?story=story`); assert.equal(calls.workspace, 1); assert.equal(calls.task, 0);
	const task = await fetch(`${backend.url}/v/story-board/api/task?story=story&task=task`).then((r) => r.json()) as any;
	assert.equal(task.task.brief, "Brief"); assert.equal(calls.task, 1); assert.equal(calls.document, 0);
	const document = await fetch(`${backend.url}/v/story-board/api/document?story=story&document=doc`).then((r) => r.json()) as any;
	assert.doesNotMatch(document.document.body, /<script>/); assert.equal(calls.document, 1);
	assert.equal((await fetch(`${backend.url}/v/story-board/api/workspace?story=../escape`)).status, 400);
});

test("Refresh returns before replacement discovery and only invalidates Story Board projections", async (t) => {
	let calls = 0; let release!: () => void;
	const reader: any = { async readCatalog() { calls += 1; if (calls === 2) await new Promise<void>((resolve) => { release = resolve; }); return []; }, async readWorkspace() {}, async readTaskDetail() {}, async readDocumentDetail() {}, async readReportDetail() {} };
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: process.cwd(), reader })] }); t.after(() => backend.close());
	await fetch(`${backend.url}/v/story-board/api/catalog`);
	const refresh = await fetch(`${backend.url}/v/story-board/api/refresh`, { method: "POST" }); assert.equal(refresh.status, 202);
	while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
	const diagnostics = await fetch(`${backend.url}/v/story-board/api/diagnostics`).then((r) => r.json()) as any;
	assert.equal(diagnostics.refreshes, 1); assert.equal(diagnostics.catalogReads, 2); release();
});
