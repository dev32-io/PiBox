import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectTaskCard } from "../projector.js";

const appPath = new URL("../assets/app.js", import.meta.url);

test("board has exactly three semantic columns and preserves projected status text", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /const COLUMNS = \["To do", "In progress", "Done"\]/);
	const tasks = [projectTaskCard({ id: "one", status: "ready" }), projectTaskCard({ id: "two", status: "running" }), projectTaskCard({ id: "three", status: "integrated" })];
	assert.deepEqual(tasks.map((task) => task.column), ["To do", "In progress", "Done"]);
	assert.deepEqual(tasks.map((task) => task.status), ["ready", "running", "integrated"]);
	assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
});

test("task details are action-loaded and provide accessible drawer and focus return contracts", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /data-task=/);
	assert.match(app, /role=\\?"dialog/);
	assert.match(app, /aria-modal=\\?"true/);
	assert.match(app, /querySelector\(focusTarget\)\?\.focus/);
	assert.match(app, /event\.key === "Escape"/);
});
