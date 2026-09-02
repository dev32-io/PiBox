import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderDeliveryHistory } from "../assets/app.js";
import { projectTaskCard } from "../projector.js";

const appPath = new URL("../assets/app.js", import.meta.url);
const stylesPath = new URL("../assets/styles.css", import.meta.url);

test("task board keeps exactly three semantic columns and preserves projected status text", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /const COLUMNS = \["To do", "In progress", "Done"\]/);
	assert.doesNotMatch(app.slice(app.indexOf("function board"), app.indexOf("function documents")), /workflowStage|stage\.integration|stage\.verification/);
	const tasks = [projectTaskCard({ id: "one", status: "ready" }), projectTaskCard({ id: "two", status: "running" }), projectTaskCard({ id: "three", status: "integrated" })];
	assert.deepEqual(tasks.map((task) => task.column), ["To do", "In progress", "Done"]);
	assert.deepEqual(tasks.map((task) => task.status), ["ready", "running", "integrated"]);
	assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
});

test("task delivery history renders only allowlisted projected fields", () => {
	const rendered = renderDeliveryHistory({ executionMode: "worktree", completedCommit: "abcdef1234567890", mergedCommit: "fedcba0987654321", worktree: "/private/worktree", lastRunId: "private-run-id", nested: { secret: true } });
	assert.match(rendered, /Execution mode/); assert.match(rendered, /abcdef1234567890/); assert.match(rendered, /fedcba0987654321/);
	assert.doesNotMatch(rendered, /private\/worktree|private-run-id|lastRunId|nested|secret|JSON\.stringify/);
});

test("workflow is an ordered, filterable operations pipeline with full task and gate signals", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /class=\"workflow-pipeline\"/);
	assert.match(app, /<ol class=\"stage-task-list/);
	assert.match(app, /sequential-chain/);
	assert.match(app, /concurrent-grid/);
	assert.match(app, /Fork ·/);
	assert.match(app, /Join ·/);
	assert.match(app, /gate\("Tasks"[\s\S]*gate\("Integration"[\s\S]*gate\("Verification"[\s\S]*gate\("Review"/);
	assert.match(app, /Whole-branch review/);
	assert.match(app, /Final E2E/);
	assert.match(app, /data-filter=/);
	assert.match(app, /data-density=/);
	assert.match(app, /collapse-completed/);
	for (const signal of ["task.status", "task.title", "task.id", "taskChecks(task)", "repairCount", "incompleteDependencyCount", "task?.result", "task?.failure"]) assert.match(app, new RegExp(signal.replace(/[?.()]/g, "\\$&")));
	assert.match(app, /ACTIVE_TASK_STATUSES = new Set\(\["implementing", "check_pending", "checking", "repair_pending", "repairing", "interrupted"\]\)/);
});

test("workflow markup and motion preserve accessibility and responsive contracts", async () => {
	const [app, styles] = await Promise.all([readFile(appPath, "utf8"), readFile(stylesPath, "utf8")]);
	assert.match(app, /role=\"progressbar\"/);
	assert.match(app, /aria-valuemin=\"0\"/);
	assert.match(app, /aria-label=\"Workflow display controls\"/);
	assert.match(app, /aria-pressed=/);
	assert.match(styles, /min-height: 44px/);
	assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(styles, /@media \(prefers-contrast: more\)/);
	assert.match(styles, /@media \(max-width: 620px\)/);
	assert.doesNotMatch(styles, /overflow-x:\s*auto/);
});

test("task and report details are action-loaded with accessible drawer and focus return", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /data-task=/);
	assert.match(app, /data-report=/);
	assert.match(app, /role="dialog"/);
	assert.match(app, /aria-modal="true"/);
	assert.match(app, /focusTarget \? root\.querySelector\(focusTarget\)/);
	assert.match(app, /captureInteractionState/); assert.match(app, /restoreInteractionState/); assert.match(app, /drawerScrollTop/);
	const workflowTask = app.slice(app.indexOf("function workflowTask"), app.indexOf("function gateDetails"));
	const workflowGate = app.slice(app.indexOf("function gate("), app.indexOf("function stageTasks"));
	assert.match(workflowTask, /<span class="sr-only">Open task detail/); assert.doesNotMatch(workflowTask, /aria-label="Open task/);
	assert.match(workflowGate, /<span class="sr-only">\$\{action\.label\}/); assert.doesNotMatch(workflowGate, /aria-label="Open \$\{escapeHtml\(label\)\} report/);
	assert.match(app, /event\.key === "Escape"/);
});
