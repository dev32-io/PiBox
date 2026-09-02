import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createVisualCompanionBackend } from "../../backend.mjs";
import { createStoryBoardViewer } from "../index.js";
import { createAssistedFixtureRepository, CURRENT_STORY_ID } from "../fixtures.js";

async function put(root: string, path: string, content: string | Buffer) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }

test("current evidence serves only authoritative flat and nested E2E references", async (t) => {
	const fixture = await createAssistedFixtureRepository(); t.after(() => fixture.cleanup());
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: fixture.repositoryRoot })] }); t.after(() => backend.close());
	const base = `${backend.url}/v/story-board/api`; const route = `${base}/evidence?story=${CURRENT_STORY_ID}&evaluation=final-e2e&path=`;
	assert.equal((await fetch(`${route}${encodeURIComponent("evidence/summary.txt")}`)).status, 200);
	assert.equal((await fetch(`${route}${encodeURIComponent("evidence/nested/shot.png")}`)).status, 200);
	const jsonEvidence = await fetch(`${route}${encodeURIComponent("evidence/data.json")}`); assert.equal(jsonEvidence.status, 200); assert.equal(await jsonEvidence.text(), '{"literal":"<tag>"}\n');
	for (const denied of ["evidence/uncited.txt", "evidence/archive.zip", "../state.yaml", "state.yaml"]) assert.equal((await fetch(`${route}${encodeURIComponent(denied)}`)).status, 404);
	const statePath = join(fixture.repositoryRoot, "agent-artifacts", CURRENT_STORY_ID, "state.yaml"); const state = parse(await readFile(statePath, "utf8")); state.e2e.evidenceRefs = state.e2e.evidenceRefs.filter((item: string) => item !== "evidence/summary.txt"); await writeFile(statePath, stringify(state));
	assert.equal((await fetch(`${route}${encodeURIComponent("evidence/summary.txt")}`)).status, 404, "state authority is revalidated even when report metadata is cached");
	await writeFile(statePath, "x".repeat(2 * 1024 * 1024 + 1));
	assert.equal((await fetch(`${route}${encodeURIComponent("evidence/nested/shot.png")}`)).status, 404, "oversized state cannot authorize cached evidence metadata");
	const workspace = await fetch(`${base}/workspace?story=${CURRENT_STORY_ID}`).then((response) => response.text());
	assert.doesNotMatch(workspace, /private-session|private-process|private-activation|private\/integration|private\/worktrees|sha256:|activationOwner|contracts|integrationWorktree/);
});

test("current cited symlinks are denied without exposing their target", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-current-evidence-route-")); t.after(() => rm(root, { recursive: true, force: true })); const story = "current-story"; const base = `agent-artifacts/${story}`;
	await put(root, `${base}/story.yaml`, stringify({ schemaVersion: 1, id: story, title: "Current", kind: "story", spec: "Spec", design: "Design", e2e: "E2E" }));
	await put(root, `${base}/state.yaml`, stringify({ schemaVersion: 1, storyId: story, status: "completed", contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: {} }, git: { canonicalBranch: "main", baseCommit: "base" }, stages: [], finalReview: { status: "completed", iteration: 1, repairCount: 0, currentFindings: [] }, e2e: { status: "completed", repairCount: 0, evidenceRefs: ["evidence/link.txt"] }, metrics: { workflowMs: 0, categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0 }, incompleteIntervals: 0, incompleteCategories: [] } }));
	await put(root, "outside.txt", "PRIVATE_TARGET"); await mkdir(join(root, base, "evidence"), { recursive: true }); await symlink(join(root, "outside.txt"), join(root, base, "evidence/link.txt"));
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: root })] }); t.after(() => backend.close());
	const response = await fetch(`${backend.url}/v/story-board/api/evidence?story=${story}&evaluation=final-e2e&path=evidence%2Flink.txt`); assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /PRIVATE_TARGET/);
});

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
