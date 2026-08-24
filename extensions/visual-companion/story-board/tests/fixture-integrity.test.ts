import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { ASSISTED_E2E_CASES, ASSISTED_FIXTURE_MARKER, createAssistedFixtureRepository, RECOVERY_STORY_ID } from "../fixtures.js";
import { TASK_STATUSES } from "../projector.js";
import { StoryBoardReader } from "../reader.js";

test("canonical disposable fixture maps complete coverage to E2E-001 through E2E-006", async () => {
	const fixture = await createAssistedFixtureRepository();
	try {
		assert.deepEqual(fixture.cases, [...ASSISTED_E2E_CASES]);
		const marker = JSON.parse(await readFile(join(fixture.repositoryRoot, ASSISTED_FIXTURE_MARKER), "utf8")); assert.deepEqual(marker.cases, [...ASSISTED_E2E_CASES]);
		const reader = new StoryBoardReader(fixture.repositoryRoot); const catalog = await reader.readCatalog();
		assert.deepEqual(new Set(catalog.map((story) => story.id)), new Set(["active-delivery", "completed-story", "archived-story", "legacy-story", "degraded-siblings", RECOVERY_STORY_ID]));
		const workspace = await reader.readWorkspace("active-delivery"); assert.ok(workspace);
		assert.deepEqual(new Set(workspace.tasks.map((task) => task.status)), new Set(TASK_STATUSES));
		assert.ok(workspace.columns["To do"].length); assert.ok(workspace.columns["In progress"].length); assert.ok(workspace.columns.Done.length);
		assert.deepEqual(workspace.documentGroups.map((group) => group.group), ["Intent and scope", "Specifications", "Design", "Decisions", "Journey cases", "Outcome"]);
		assert.deepEqual(new Set(workspace.reports.map((report) => report.scope.kind)), new Set(["task", "story", "stage", "final", "e2e"]));
		const report = await reader.readReportDetail("active-delivery", "task-report"); assert.ok(report); assert.equal(report.history.length, 2); assert.equal(report.findings.length, 1); assert.ok(report.riskAcceptance);
		assert.deepEqual(report.evidence.map((item) => [item.id, item.available, item.supported]), [["EV-001", true, true], ["EV-002", true, true], ["EV-003", false, true], ["EV-004", true, false], ["EV-005", true, true]]);
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
