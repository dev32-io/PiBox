import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createVisualCompanionBackend } from "../../backend.mjs";
import { createStoryBoardViewer } from "../api.js";
import { CurrentStoryReader } from "../current-reader.js";

async function put(root: string, path: string, content: string): Promise<void> { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
function workspace(id: string, marker: number) {
	return { story: { id, title: id, intentExcerpt: "", kind: "story", phase: "execution", state: "running", taskCount: 0, reportCount: 0, degraded: false, diagnostics: [] }, columns: { "To do": [], "In progress": [], Done: [] }, tasks: [], documentGroups: [], reports: [], diagnostics: [], marker };
}

test("workspace observation provides opaque ETags, avoids rereads, invalidates changes, and rejects a stale mid-read", async (t) => {
	const story = "reactive-story"; let seed = "state-a"; let status: "ready" | "running" = "ready"; let workspaceReads = 0; let catalogReads = 0; let changeDuringRead = false;
	const reader: any = {
		async observeWorkspace() { return { versionSeed: seed, status, outcomeStatus: "pending" }; },
		async readCatalog() { catalogReads += 1; return []; },
		async readWorkspace() { workspaceReads += 1; if (changeDuringRead) { changeDuringRead = false; seed = "state-d"; status = "running"; } return workspace(story, workspaceReads); },
		async readTaskDetail() {}, async readDocumentDetail() {}, async readReportDetail() {},
	};
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: process.cwd(), reader })] }); t.after(() => backend.close());
	const url = `${backend.url}/v/story-board/api/workspace?story=${story}`;
	const first = await fetch(url); const firstBody = await first.json() as any; const firstEtag = first.headers.get("etag")!;
	assert.equal(first.status, 200); assert.match(firstEtag, /^W\/[\"][-\w]+[\"]$/); assert.equal(firstBody.observation.status, "ready"); assert.equal(firstBody.observation.outcomeStatus, "pending");
	assert.notEqual(firstBody.observation.revision, seed); assert.equal(firstEtag, `W/"${firstBody.observation.revision}"`); assert.equal(workspaceReads, 1); assert.equal(catalogReads, 0);

	// Writing the same state bytes yields the same seed and does not reload projections.
	seed = "state-a";
	const unchanged = await fetch(url, { headers: { "If-None-Match": firstEtag } }); assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), ""); assert.equal(workspaceReads, 1); assert.equal(catalogReads, 0);

	seed = "state-b"; status = "running";
	const changed = await fetch(url, { headers: { "If-None-Match": firstEtag } }); const changedBody = await changed.json() as any; const changedEtag = changed.headers.get("etag")!;
	assert.equal(changed.status, 200); assert.equal(changedBody.observation.status, "running"); assert.notEqual(changedEtag, firstEtag); assert.equal(workspaceReads, 2);

	seed = "state-c"; changeDuringRead = true;
	const stale = await fetch(url, { headers: { "If-None-Match": changedEtag } }); assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { retry: true }); assert.equal(workspaceReads, 3);
	const retry = await fetch(url); const retryEtag = retry.headers.get("etag")!; assert.equal(retry.status, 200); assert.equal(workspaceReads, 4);

	const refresh = await fetch(`${backend.url}/v/story-board/api/refresh`, { method: "POST" }); assert.equal(refresh.status, 202);
	const afterRefresh = await fetch(url, { headers: { "If-None-Match": retryEtag } }); assert.equal(afterRefresh.status, 200); assert.equal(workspaceReads, 5, "manual refresh clears observation and projection state");
});

function runtimeState(storyId: string, status: "ready" | "running" = "ready"): string {
	return stringify({
		schemaVersion: 1, storyId, status,
		contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: {} }, git: { canonicalBranch: "main", baseCommit: "base" }, stages: [],
		finalReview: { status: "pending", iteration: 0, repairCount: 0, currentFindings: [] }, e2e: { status: "pending", repairCount: 0, evidenceRefs: [] },
		metrics: { workflowMs: 0, categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0 }, incompleteIntervals: 0, incompleteCategories: [] }, outcomeStatus: "pending",
	});
}

test("current-state observation is bounded to a valid contained regular state file and ignores ledger and events", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "story-state-observation-")); const outside = await mkdtemp(join(tmpdir(), "story-state-observation-outside-"));
	t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
	const story = "observed-story"; const base = `agent-artifacts/${story}`; const statePath = join(root, base, "state.yaml"); const bytes = runtimeState(story);
	await put(root, `${base}/story.yaml`, stringify({ schemaVersion: 1, id: story, title: "Observed", kind: "story", spec: "Spec", design: "Design", e2e: "E2E" })); await put(root, `${base}/state.yaml`, bytes);
	const reader = new CurrentStoryReader(root); const initial = await reader.observeWorkspace(story); assert.ok(initial); assert.equal(initial.status, "ready"); assert.equal(initial.outcomeStatus, "pending");

	await put(root, `${base}/ledger.yaml`, "private ledger change"); await put(root, `${base}/events.jsonl`, '{"private":"event"}\n');
	assert.equal((await reader.observeWorkspace(story))?.versionSeed, initial.versionSeed, "ledger and event bytes are irrelevant");
	await writeFile(statePath, bytes); assert.equal((await reader.observeWorkspace(story))?.versionSeed, initial.versionSeed, "identical state bytes are a no-op");
	await writeFile(statePath, runtimeState(story, "running")); const changed = await reader.observeWorkspace(story); assert.equal(changed?.status, "running"); assert.notEqual(changed?.versionSeed, initial.versionSeed);

	await writeFile(statePath, "not: valid runtime state\n"); assert.equal(await reader.observeWorkspace(story), undefined, "malformed state disables observation");
	await writeFile(statePath, "x".repeat(2 * 1024 * 1024 + 1)); assert.equal(await reader.observeWorkspace(story), undefined, "oversized state disables observation");
	const oversized = await reader.readWorkspace(story, join(root, base)); assert.equal(oversized.workflow, undefined, "oversized state is never parsed into a projection"); assert.ok(oversized.diagnostics.some((item) => item.path.endsWith("/state.yaml") && item.message.includes("oversized")));
	await unlink(statePath); assert.equal(await reader.observeWorkspace(story), undefined, "missing state disables observation");
	const outsideState = join(outside, "state.yaml"); await writeFile(outsideState, bytes); await symlink(outsideState, statePath);
	assert.equal(await reader.observeWorkspace(story), undefined, "symlinked state disables observation");
});
