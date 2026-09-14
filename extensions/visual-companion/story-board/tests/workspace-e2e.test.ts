import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createE2eEvaluation, createE2eWorkspace, retainE2eEvidence, submitE2eWorkspaceReport } from "../../../e2e-workspace/workspace.js";
import { createVisualCompanionBackend } from "../../backend.mjs";
import { createAssistedFixtureRepository, CURRENT_STORY_ID } from "../fixtures.js";
import { createStoryBoardViewer, StoryBoardReader } from "../index.js";

async function workspaceReport() {
	const workspace = await createE2eWorkspace({ sessionId: `board-${Date.now()}-${Math.random()}` });
	const evaluation = await createE2eEvaluation({ workspace });
	const proofPath = join(evaluation.outputDirectory, "witness.txt");
	await writeFile(proofPath, "safe temporary proof\n");
	const retained = await retainE2eEvidence({ evaluation, sourcePath: proofPath, reason: "Small witness for Board file-serving proof." });
	return submitE2eWorkspaceReport({ evaluation, nativeReportPath: join(workspace.root, "report.md"), submission: {
		summary: "Workspace <script>bad()</script> /private/report",
		cases: [{ case: "E2E-001", verdict: "passed", steps: ["Open <board>"], observed: "Observed result", evidence: [retained.reference], expected: "Expected <safe>", notes: "Notes <b>text</b>" }],
		findings: [{ summary: "Finding <img src=x onerror=bad()>", severity: "minor" }],
	} });
}

async function pointState(repositoryRoot: string, reference: unknown) {
	const path = join(repositoryRoot, "agent-artifacts", CURRENT_STORY_ID, "state.yaml");
	const state = parse(await readFile(path, "utf8"));
	state.e2e.workspaceReport = reference;
	state.e2e.currentReportRef = "evidence/e2e-legacy/report.json";
	state.e2e.evidenceRefs.push("evidence/e2e-legacy/report.json");
	await mkdir(join(repositoryRoot, "agent-artifacts", CURRENT_STORY_ID, "evidence"), { recursive: true });
	await mkdir(join(repositoryRoot, "agent-artifacts", CURRENT_STORY_ID, "evidence/e2e-legacy"), { recursive: true });
	await writeFile(join(repositoryRoot, "agent-artifacts", CURRENT_STORY_ID, "evidence/e2e-legacy/report.json"), JSON.stringify({ schemaVersion: 1, result: "passed", caseResults: [], findings: [] }));
	await writeFile(path, stringify(state));
}

test("Board reads authoritative temporary report and serves only its hash-validated evidence", async (t) => {
	const fixture = await createAssistedFixtureRepository(); t.after(() => fixture.cleanup());
	const snapshot = await workspaceReport(); t.after(() => rm(snapshot.workspaceRoot, { recursive: true, force: true }));
	await pointState(fixture.repositoryRoot, snapshot.reference);
	const reader = new StoryBoardReader(fixture.repositoryRoot); const report = await reader.readReportDetail(CURRENT_STORY_ID, "final-e2e");
	assert.equal(report?.recordedE2E?.result, "passed");
	assert.equal(report?.recordedE2E?.sourcePath, "Temporary E2E workspace snapshot");
	assert.deepEqual(report?.recordedE2E?.cases[0] && { expected: report.recordedE2E.cases[0].expected, notes: report.recordedE2E.cases[0].notes, actions: report.recordedE2E.cases[0].executedActions }, { expected: "Expected <safe>", notes: "Notes <b>text</b>", actions: ["Open <board>"] });
	const member = report?.recordedE2E?.cases[0]?.evidenceRefs[0]?.memberPath; assert.equal(member, snapshot.evidence[0]?.reference);
	assert.doesNotMatch(JSON.stringify(report), new RegExp(snapshot.workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: fixture.repositoryRoot })] }); t.after(() => backend.close());
	const route = `${backend.url}/v/story-board/api/evidence?story=${CURRENT_STORY_ID}&evaluation=final-e2e&path=${encodeURIComponent(member!)}`;
	const response = await fetch(route); assert.equal(response.status, 200); assert.equal(await response.text(), "safe temporary proof\n");
	const api = await fetch(`${backend.url}/v/story-board/api/report?story=${CURRENT_STORY_ID}&report=final-e2e`).then((value) => value.text());
	assert.doesNotMatch(api, /\/private\/report/); assert.match(api, /onerror=bad/); assert.doesNotMatch(api, new RegExp(snapshot.workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	await writeFile(snapshot.evidence[0]!.absolutePath, "changed temporary proof\n"); assert.equal((await fetch(route)).status, 404);
});

test("missing or foreign authoritative workspace never falls back to older passing report", async (t) => {
	const fixture = await createAssistedFixtureRepository(); t.after(() => fixture.cleanup());
	const snapshot = await workspaceReport();
	await pointState(fixture.repositoryRoot, snapshot.reference); await rm(snapshot.workspaceRoot, { recursive: true, force: true });
	let report = await new StoryBoardReader(fixture.repositoryRoot).readReportDetail(CURRENT_STORY_ID, "final-e2e");
	assert.equal(report?.recordedE2E?.result, "Unavailable"); assert.equal(report?.recordedE2E?.cases.length, 0); assert.equal(report?.evidence.length, 0);
	const foreign = await workspaceReport(); t.after(() => rm(foreign.workspaceRoot, { recursive: true, force: true }));
	await pointState(fixture.repositoryRoot, { ...foreign.reference, sessionId: "foreign-session" });
	report = await new StoryBoardReader(fixture.repositoryRoot).readReportDetail(CURRENT_STORY_ID, "final-e2e");
	assert.equal(report?.recordedE2E?.result, "Unavailable"); assert.equal(report?.recordedE2E?.cases.length, 0);
});


test("cached Board report becomes unavailable when temporary proof disappears without a state change", async (t) => {
	const fixture = await createAssistedFixtureRepository(); t.after(() => fixture.cleanup());
	const snapshot = await workspaceReport(); t.after(() => rm(snapshot.workspaceRoot, { recursive: true, force: true }));
	await pointState(fixture.repositoryRoot, snapshot.reference);
	const backend = await createVisualCompanionBackend({ viewers: [createStoryBoardViewer({ repositoryRoot: fixture.repositoryRoot })] }); t.after(() => backend.close());
	const route = `${backend.url}/v/story-board/api/report?story=${CURRENT_STORY_ID}&report=final-e2e`;
	const read = async () => { const response = await fetch(route); assert.equal(response.status, 200); return response.json(); };
	assert.equal((await read()).report.recordedE2E.result, "passed");
	await rm(snapshot.workspaceRoot, { recursive: true });
	const unavailable = (await read()).report;
	assert.equal(unavailable.recordedE2E.result, "Unavailable");
	assert.equal(unavailable.evidence.length, 0);
	assert.equal(unavailable.recordedE2E.cases.length, 0);
	const evidenceRoute = `${backend.url}/v/story-board/api/evidence?story=${CURRENT_STORY_ID}&evaluation=final-e2e&path=${encodeURIComponent(snapshot.evidence[0]!.reference)}`;
	assert.equal((await fetch(evidenceRoute)).status, 404);
});
