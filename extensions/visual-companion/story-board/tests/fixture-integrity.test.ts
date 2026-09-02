import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { ASSISTED_E2E_CASES, ASSISTED_FIXTURE_MARKER, createAssistedFixtureRepository, CURRENT_STORY_ID, RECOVERY_STORY_ID } from "../fixtures.js";
import { TASK_STATUSES } from "../projector.js";
import { StoryBoardReader } from "../reader.js";

test("canonical disposable fixture maps complete coverage to E2E-001 through E2E-006", async () => {
	const fixture = await createAssistedFixtureRepository();
	try {
		assert.deepEqual(fixture.cases, [...ASSISTED_E2E_CASES]);
		const marker = JSON.parse(await readFile(join(fixture.repositoryRoot, ASSISTED_FIXTURE_MARKER), "utf8")); assert.deepEqual(marker.cases, [...ASSISTED_E2E_CASES]);
		const reader = new StoryBoardReader(fixture.repositoryRoot); const catalog = await reader.readCatalog();
		assert.deepEqual(new Set(catalog.map((story) => story.id)), new Set(["active-delivery", "completed-story", "archived-story", "legacy-story", "degraded-siblings", "malformed-current", "current-precedence", CURRENT_STORY_ID, RECOVERY_STORY_ID]));
		assert.equal(catalog.find((story) => story.id === "current-precedence")?.title, "Current wins"); assert.equal(catalog.find((story) => story.id === CURRENT_STORY_ID)?.degraded, false, "catalog does not eagerly parse task bodies");
		const current = await reader.readWorkspace(CURRENT_STORY_ID); assert.ok(current); assert.equal(current.stages?.length, 4); assert.equal(current.tasks.length, 13); assert.equal(current.story.state, "completed"); assert.equal(current.story.degraded, true); assert.ok(current.diagnostics.some((item) => item.path.endsWith("tasks/malformed-task.yaml")));
		assert.deepEqual(current.stages?.map((stage) => stage.mode), ["sequential", "concurrent", "concurrent", "sequential"]); assert.ok(current.reports.some((report) => report.id === "final-e2e"));
		const currentReport = await reader.readReportDetail(CURRENT_STORY_ID, "final-e2e"); assert.ok(currentReport); assert.deepEqual(currentReport.history, []); assert.equal(currentReport.attempt, 1); assert.equal(currentReport.caseResults, undefined); assert.equal((await reader.readReportDetail(CURRENT_STORY_ID, "final-review"))?.attempt, 1); assert.doesNotMatch(JSON.stringify(await reader.readReportDetail(CURRENT_STORY_ID, "final-review")), /private\/worktrees/); assert.deepEqual(currentReport.evidence.map((item) => item.memberPath), ["evidence/summary.txt", "evidence/nested/shot.png", "evidence/data.json", "evidence/archive.zip"]);
		const serialized = JSON.stringify(current); assert.doesNotMatch(serialized, /private-session|private-process|private-activation|private\/integration|private\/worktrees|sha256:/);
		const workspace = await reader.readWorkspace("active-delivery"); assert.ok(workspace);
		assert.deepEqual(new Set(workspace.tasks.map((task) => task.status)), new Set(TASK_STATUSES));
		assert.ok(workspace.columns["To do"].length); assert.ok(workspace.columns["In progress"].length); assert.ok(workspace.columns.Done.length);
		assert.deepEqual(workspace.documentGroups.map((group) => group.group), ["Intent and scope", "Specifications", "Design", "Decisions", "Journey cases", "Outcome"]);
		assert.deepEqual(new Set(workspace.reports.map((report) => report.scope.kind)), new Set(["task", "story", "stage", "final", "e2e"]));
		const report = await reader.readReportDetail("active-delivery", "task-report"); assert.ok(report); assert.equal(report.history.length, 2); assert.equal(report.findings.length, 1); assert.ok(report.riskAcceptance);
		assert.deepEqual(report.evidence.map((item) => [item.id, item.available, item.supported]), [["EV-001", true, true], ["EV-002", true, true], ["EV-003", false, true], ["EV-004", true, false], ["EV-005", true, true]]);
		const currentStatePath = join(fixture.repositoryRoot, "agent-artifacts", CURRENT_STORY_ID, "state.yaml"); const currentState = parse(await readFile(currentStatePath, "utf8")); currentState.outcomeStatus = "failed"; await writeFile(currentStatePath, stringify(currentState)); const gatedReader = new StoryBoardReader(fixture.repositoryRoot); const gatedWorkspace = await gatedReader.readWorkspace(CURRENT_STORY_ID); assert.ok(gatedWorkspace); assert.equal(gatedWorkspace.documentGroups.flatMap((group) => group.documents).some((document) => document.id === "outcome"), false); assert.equal(await gatedReader.readDocumentDetail(CURRENT_STORY_ID, "outcome"), undefined);
		await stat(fixture.architectureArtifactPath); const architecture = JSON.parse(await readFile(fixture.architectureArtifactPath, "utf8")); assert.ok(architecture.views[0].nodes.length);
	} finally { await fixture.cleanup(); }
});

test("intentional malformed resource has a valid replacement and recovery stays contained", async () => {
	const fixture = await createAssistedFixtureRepository();
	try {
		const index = join(fixture.repositoryRoot, "agent-artifacts", RECOVERY_STORY_ID, "index.yaml"); const before = await readFile(index, "utf8"); assert.throws(() => parse(before));
		const sibling = join(fixture.repositoryRoot, "agent-artifacts", "active-delivery", "index.yaml"); const siblingBefore = await readFile(sibling, "utf8");
		await fixture.recoverMalformedResource(); const recovered = parse(await readFile(index, "utf8")); assert.equal(recovered.id, RECOVERY_STORY_ID); assert.equal(recovered.title, "Recovered historical story"); assert.equal(await readFile(sibling, "utf8"), siblingBefore);
	} finally { await fixture.cleanup(); }
});
