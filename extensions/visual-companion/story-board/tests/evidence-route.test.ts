import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createVisualCompanionBackend } from "../../backend.mjs";
import { createStoryBoardViewer } from "../index.js";

async function put(root: string, path: string, content: string | Buffer) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }

test("evidence route requires canonical evaluation membership and contained manifest-listed files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-evidence-route-")); t.after(() => rm(root, { recursive: true, force: true }));
	const story = "safe-story", evaluation = "review"; const base = `agent-artifacts/${story}`; const evidence = `${base}/evidence/${evaluation}`;
	await put(root, `${base}/index.yaml`, stringify({ schemaVersion: 1, id: story, kind: "story", title: "Safe", phase: "execution", state: "active", planning: { revision: 1 }, artifacts: [], tasks: [], integrationUnits: [], evaluations: [{ id: evaluation, path: `evaluations/${evaluation}/evaluation.yaml` }] }));
	await put(root, `${base}/evaluations/${evaluation}/evaluation.yaml`, stringify({ schemaVersion: 1, id: evaluation, type: "quality-review", scope: { workItem: story }, status: "passed", required: true, attempt: 1, methods: [], findings: [], result: { verdict: "pass", report: "report.md" } }));
	await put(root, `${base}/evaluations/${evaluation}/report.md`, "# Fine\n");
	await put(root, `${evidence}/files/note.md`, "<script>bad()</script>Visible");
	await put(root, `${evidence}/files/archive.zip`, "zip");
	await put(root, "outside.txt", "private");
	await symlink(join(root, "outside.txt"), join(root, evidence, "files/link.txt"));
	await put(root, `${evidence}/manifest.yaml`, stringify({ schemaVersion: 1, evaluation, entries: [{ id: "note", path: "files/note.md" }, { id: "archive", path: "files/archive.zip" }, { id: "link", path: "files/link.txt" }] }));
	const before = createHash("sha256").update(await readFile(join(root, evidence, "files/note.md"))).digest("hex");
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: root })] }); t.after(() => backend.close());
	const route = `${backend.url}/v/story-board/api/evidence?story=${story}&evaluation=${evaluation}&path=`;
	const response = await fetch(`${route}${encodeURIComponent("files/note.md")}`); assert.equal(response.status, 200); assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
	const body = await response.text(); assert.doesNotMatch(body, /<script>/); assert.match(body, /Visible/);
	assert.equal((await fetch(`${route}${encodeURIComponent("files/archive.zip")}`)).status, 404);
	assert.equal((await fetch(`${route}${encodeURIComponent("files/link.txt")}`)).status, 404);
	assert.equal((await fetch(`${route}${encodeURIComponent("../manifest.yaml")}`)).status, 404);
	assert.equal((await fetch(`${backend.url}/v/story-board/api/evidence?story=${story}&evaluation=unlisted&path=files%2Fnote.md`)).status, 404);
	const after = createHash("sha256").update(await readFile(join(root, evidence, "files/note.md"))).digest("hex"); assert.equal(after, before);
});
