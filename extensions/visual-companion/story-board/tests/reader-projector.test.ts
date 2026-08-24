import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { stringify } from "yaml";
import { StoryBoardReader, TASK_STATUSES, readStoryCatalog, taskColumn } from "../index.js";

const exec = promisify(execFile);
async function fixture(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "story-board-reader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function put(root: string, path: string, content: string): Promise<void> { const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, content); }

function index(id: string, title: string, state = "active") {
	return { schemaVersion: 1, id, kind: "story", title, phase: state === "complete" ? "complete" : "execution", state, planning: { revision: 2 }, artifacts: [{ id: "intent", type: "intent", path: "intent.md", status: "draft" }, { id: "spec", type: "spec", path: "specs/spec.md", status: "approved" }], tasks: [{ id: "healthy-task", path: "tasks/healthy-task/task.yaml" }, { id: "broken-task", path: "tasks/broken-task/task.yaml" }], integrationUnits: [], evaluations: [{ id: "task-review", path: "evaluations/task-review/evaluation.yaml" }] };
}
function taskManifest(id: string, status: string) {
	return { schemaVersion: 1, id, title: "Healthy task", status, dependsOn: [], execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "Appropriate capability" } }, assembly: { stageId: "foundation", intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [] } };
}

test("empty repositories and deterministic active-before-complete catalogs", async (t) => {
	const root = await fixture(t);
	assert.deepEqual(await readStoryCatalog(root), []);
	await put(root, "agent-artifacts/z-complete/index.yaml", stringify({ ...index("z-complete", "A complete", "complete"), tasks: [], evaluations: [] }));
	await put(root, "agent-artifacts/z-complete/intent.md", "# Intent\n\nCompleted work.\n");
	await put(root, "agent-artifacts/a-active/index.yaml", stringify({ ...index("a-active", "Z active"), tasks: [], evaluations: [] }));
	await put(root, "agent-artifacts/a-active/intent.md", "# Intent\n\nActive work.\n");
	assert.deepEqual((await readStoryCatalog(root)).map((story) => story.id), ["a-active", "z-complete"]);
});

test("workspace isolates malformed children and links task-scoped reports", async (t) => {
	const root = await fixture(t); const story = "mixed-story";
	await put(root, `agent-artifacts/${story}/index.yaml`, stringify(index(story, "Mixed story")));
	await put(root, `agent-artifacts/${story}/intent.md`, "# Intent\n\nA useful story intent.\n");
	await put(root, `agent-artifacts/${story}/specs/spec.md`, "# Specification\n\nBody.\n");
	await put(root, `agent-artifacts/${story}/tasks/healthy-task/task.yaml`, stringify(taskManifest("healthy-task", "ready")));
	await put(root, `agent-artifacts/${story}/tasks/healthy-task/brief.md`, "# Brief\n\nExact brief.\n");
	await put(root, `agent-artifacts/${story}/tasks/healthy-task/acceptance.md`, "# Acceptance\n\nExact acceptance.\n");
	await put(root, `agent-artifacts/${story}/tasks/broken-task/task.yaml`, "status: [not yaml\n");
	await put(root, `agent-artifacts/${story}/evaluations/task-review/evaluation.yaml`, stringify({ schemaVersion: 1, id: "task-review", type: "combined-review", scope: { task: "healthy-task" }, status: "passed", required: true, attempt: 2, methods: [], findings: [{ id: "F-1", severity: "low", status: "accepted", summary: "Known issue" }], result: { verdict: "pass", report: "report.md", riskAcceptance: "risk-acceptance.md" } }));
	await put(root, `agent-artifacts/${story}/evaluations/task-review/report.md`, "# Report\n\nPassed.\n");
	await put(root, `agent-artifacts/${story}/evaluations/task-review/risk-acceptance.md`, "# Accepted risk\n");
	const reader = new StoryBoardReader(root); const workspace = await reader.readWorkspace(story);
	assert.equal(workspace?.tasks.length, 2);
	assert.equal(workspace?.columns["To do"][0]?.status, "ready");
	assert.equal(workspace?.tasks.find((task) => task.id === "broken-task")?.degraded, true);
	assert.deepEqual(workspace?.tasks.find((task) => task.id === "healthy-task")?.relatedReportIds, ["task-review"]);
	assert.equal(workspace?.reports[0]?.taskId, "healthy-task");
	assert.deepEqual(workspace?.documentGroups.map((group) => group.group), ["Intent and scope", "Specifications"]);
	const detail = await reader.readTaskDetail(story, "healthy-task");
	assert.match(detail?.brief ?? "", /Exact brief/);
	const report = await reader.readReportDetail(story, "task-review");
	assert.equal(report?.findings[0]?.status, "accepted");
	assert.match(report?.riskAcceptance ?? "", /Accepted risk/);
});

test("story, task, stage, final, and E2E reports retain independent scopes", async (t) => {
	const root = await fixture(t); const story = "report-shapes";
	const evaluations = ["story-report", "task-report", "stage-report", "final-report", "e2e-report"].map((id) => ({ id, path: `evaluations/${id}/evaluation.yaml` }));
	await put(root, `agent-artifacts/${story}/index.yaml`, stringify({ ...index(story, "Report shapes"), tasks: [], artifacts: [], evaluations }));
	const manifests = [
		{ id: "story-report", type: "quality-review", scope: { workItem: story } },
		{ id: "task-report", type: "spec-review", scope: { task: "some-task" } },
		{ id: "stage-report", type: "combined-review", stageId: "foundation", scope: { workItem: story } },
		{ id: "final-report", type: "combined-review", checkpoint: "final-review", scope: { workItem: story } },
		{ id: "e2e-report", type: "e2e", checkpoint: "final-e2e", scope: { workItem: story } },
	];
	for (const manifest of manifests) await put(root, `agent-artifacts/${story}/evaluations/${manifest.id}/evaluation.yaml`, stringify({ schemaVersion: 1, status: "planned", required: true, attempt: 0, methods: [], ...manifest }));
	const reports = (await new StoryBoardReader(root).readWorkspace(story))?.reports ?? [];
	assert.deepEqual(Object.fromEntries(reports.map((report) => [report.id, report.scope.kind])), { "e2e-report": "e2e", "final-report": "final", "stage-report": "stage", "story-report": "story", "task-report": "task" });
});

test("all persisted statuses map exactly once while preserving exact text", () => {
	const grouped = new Map<string, string>(TASK_STATUSES.map((status) => [status, taskColumn(status)]));
	assert.equal(grouped.size, TASK_STATUSES.length);
	for (const status of ["draft", "blocked", "ready"]) assert.equal(grouped.get(status), "To do");
	for (const status of ["merged", "integrated", "cancelled"]) assert.equal(grouped.get(status), "Done");
	const edgeColumns = new Set<string>(["draft", "blocked", "ready", "merged", "integrated", "cancelled"]);
	for (const status of TASK_STATUSES.filter((value) => !edgeColumns.has(value))) assert.equal(grouped.get(status), "In progress");
});

test("bounded legacy recovery and reads leave source bytes unchanged", async (t) => {
	const root = await fixture(t); const path = "agent-artifacts/legacy-story/index.yaml";
	const content = "schemaVersion: 0\nid: legacy-story\nkind: story\ntitle: Legacy story\nphase: planning\nstate: active\nplanning:\n  revision: 1\nartifacts: []\ntasks: []\nevaluations: []\n";
	await put(root, path, content);
	await exec("git", ["init", "-q"], { cwd: root });
	const beforeStatus = (await exec("git", ["status", "--short"], { cwd: root })).stdout;
	const before = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
	const catalog = await readStoryCatalog(root); const after = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
	const afterStatus = (await exec("git", ["status", "--short"], { cwd: root })).stdout;
	assert.equal(catalog[0]?.title, "Legacy story"); assert.equal(catalog[0]?.degraded, true); assert.equal(after, before); assert.equal(afterStatus, beforeStatus);
	assert.ok(catalog[0]?.diagnostics.every((item) => !item.path.startsWith("/") && !item.message.includes(root)));
});
