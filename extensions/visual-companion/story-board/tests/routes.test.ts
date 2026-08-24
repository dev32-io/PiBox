import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createVisualCompanionBackend } from "../../backend.mjs";
import { createStoryBoardViewer } from "../index.js";

async function put(root: string, path: string, content: string): Promise<void> { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
function storyIndex(id: string, tasks: Array<{ id: string; path: string }> = [], evaluations: Array<{ id: string; path: string }> = []) { return stringify({ schemaVersion: 1, id, kind: "story", title: id, phase: "execution", state: "active", planning: { revision: 1 }, artifacts: [], tasks, integrationUnits: [], evaluations }); }
function evaluation(id: string, story: string) { return stringify({ schemaVersion: 1, id, type: "quality-review", scope: { workItem: story }, status: "passed", required: true, attempt: 1, methods: [], findings: [], result: { verdict: "pass", report: "report.md" } }); }

test("Story Board registration is idle and routes load progressively with single-flight", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-routes-")); t.after(() => rm(root, { recursive: true, force: true }));
	const calls = { catalog: 0, workspace: 0, task: 0, document: 0, report: 0 };
	let release!: () => void;
	const reader: any = {
		async readCatalog() { calls.catalog += 1; await new Promise<void>((resolve) => { release = resolve; }); return [{ id: "story" }]; },
		async readWorkspace() { calls.workspace += 1; return { story: { id: "story" }, tasks: [], documentGroups: [], reports: [] }; },
		async readTaskDetail() { calls.task += 1; return { id: "task", title: "Task", status: "ready", column: "To do", dependsOn: [], relatedReportIds: [], degraded: false, diagnostics: [], brief: "<b>Brief</b>", verification: { methods: [], taskChecks: [] }, deliveryHistory: { executionMode: "worktree", completedCommit: "abcdef1234567890", worktree: "/private/worktree", lastRunId: "private-run-id" } }; },
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
	assert.equal(task.task.brief, "Brief"); assert.deepEqual(task.task.deliveryHistory, { executionMode: "worktree", completedCommit: "abcdef1234567890" });
	assert.doesNotMatch(JSON.stringify(task), /private\/worktree|private-run-id|lastRunId|"worktree":/); assert.equal(calls.task, 1); assert.equal(calls.document, 0);
	const document = await fetch(`${backend.url}/v/story-board/api/document?story=story&document=doc`).then((r) => r.json()) as any;
	assert.doesNotMatch(document.document.body, /<script>/); assert.equal(calls.document, 1);
	assert.equal((await fetch(`${backend.url}/v/story-board/api/workspace?story=../escape`)).status, 400);
});

test("direct routes deny symlinked external stories and tasks while healthy siblings remain available", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-routes-containment-")); const outside = await mkdtemp(join(tmpdir(), "story-routes-outside-"));
	t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
	await put(root, "agent-artifacts/healthy-story/index.yaml", storyIndex("healthy-story"));
	await put(outside, "external-story/index.yaml", storyIndex("external-story"));
	await mkdir(join(root, "agent-artifacts"), { recursive: true }); await symlink(join(outside, "external-story"), join(root, "agent-artifacts", "external-story"));
	await put(root, "agent-artifacts/task-story/index.yaml", storyIndex("task-story", [{ id: "external-task", path: "tasks/external-task/task.yaml" }]));
	await put(outside, "external-task/task.yaml", stringify({ schemaVersion: 1, id: "external-task", title: "External", status: "ready", dependsOn: [], execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "test" } }, verification: { timing: "task", methods: [], taskChecks: [] } }));
	await mkdir(join(root, "agent-artifacts/task-story/tasks"), { recursive: true }); await symlink(join(outside, "external-task"), join(root, "agent-artifacts/task-story/tasks/external-task"));
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: root })] }); t.after(() => backend.close());
	const base = `${backend.url}/v/story-board/api`;
	const catalog = await fetch(`${base}/catalog`).then((response) => response.json()) as any;
	assert.ok(catalog.stories.some((story: any) => story.id === "healthy-story")); assert.ok(!catalog.stories.some((story: any) => story.id === "external-story"));
	assert.equal((await fetch(`${base}/workspace?story=external-story`)).status, 404);
	assert.equal((await fetch(`${base}/task?story=external-story&task=external-task`)).status, 404);
	assert.equal((await fetch(`${base}/task?story=task-story&task=external-task`)).status, 404);
	assert.equal((await fetch(`${base}/workspace?story=healthy-story`)).status, 200);
});

test("report and evidence routes deny an evaluation directory symlinked to another story", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-routes-evaluation-")); t.after(() => rm(root, { recursive: true, force: true }));
	const listed = (id: string) => ({ id, path: `evaluations/${id}/evaluation.yaml` });
	await put(root, "agent-artifacts/story-a/index.yaml", storyIndex("story-a", [], [listed("shared-review"), listed("healthy-review")]));
	await put(root, "agent-artifacts/story-b/index.yaml", storyIndex("story-b", [], [listed("shared-review")]));
	await put(root, "agent-artifacts/story-b/evaluations/shared-review/evaluation.yaml", evaluation("shared-review", "story-b"));
	await put(root, "agent-artifacts/story-b/evaluations/shared-review/report.md", "# Story B private report\n\nSTORY_B_MARKER\n");
	await put(root, "agent-artifacts/story-a/evaluations/healthy-review/evaluation.yaml", evaluation("healthy-review", "story-a"));
	await put(root, "agent-artifacts/story-a/evaluations/healthy-review/report.md", "# Healthy Story A report\n");
	await put(root, "agent-artifacts/story-a/evidence/shared-review/files/private.txt", "STORY_B_EVIDENCE_MARKER");
	await put(root, "agent-artifacts/story-a/evidence/shared-review/manifest.yaml", stringify({ schemaVersion: 1, evaluation: "shared-review", entries: [{ id: "private", path: "files/private.txt" }] }));
	await symlink(join(root, "agent-artifacts/story-b/evaluations/shared-review"), join(root, "agent-artifacts/story-a/evaluations/shared-review"));
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: root })] }); t.after(() => backend.close());
	const base = `${backend.url}/v/story-board/api`;
	const workspaceResponse = await fetch(`${base}/workspace?story=story-a`); const workspaceBody = await workspaceResponse.text();
	assert.equal(workspaceResponse.status, 200); assert.doesNotMatch(workspaceBody, /STORY_B_MARKER/);
	const reportResponse = await fetch(`${base}/report?story=story-a&report=shared-review`); assert.equal(reportResponse.status, 404); assert.doesNotMatch(await reportResponse.text(), /STORY_B_MARKER/);
	const evidenceResponse = await fetch(`${base}/evidence?story=story-a&evaluation=shared-review&path=files%2Fprivate.txt`); assert.equal(evidenceResponse.status, 404); assert.doesNotMatch(await evidenceResponse.text(), /STORY_B_EVIDENCE_MARKER/);
	const healthyResponse = await fetch(`${base}/report?story=story-a&report=healthy-review`); assert.equal(healthyResponse.status, 200); assert.match(await healthyResponse.text(), /Healthy Story A report/);
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
