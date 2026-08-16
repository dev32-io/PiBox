import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRoutineModelFixture, type RoutineModelFixture } from "./model-suite.js";
import { WorkItemStore } from "../workflow/work-items.js";

const exec = promisify(execFile);

/** A subordinate task contradiction with exactly one resolution in reviewed story authority. */
export async function createChangeRequestModelFixture(root: string): Promise<RoutineModelFixture> {
	const fixture = await createRoutineModelFixture(root);
	const store = new WorkItemStore(root);
	await store.reviseWorkItem({
		workItemId: fixture.workItemId,
		title: "Preserve record identity during serialization",
		intent: "Every serialized Record payload includes its stable `id`, and direct serialize/deserialize round trips preserve that value exactly so references remain valid.",
		authority: { rationale: "Create benchmark change-request intent", sources: ["benchmark:change-request"] },
	});
	await store.putArtifact({
		workItemId: fixture.workItemId,
		id: "record-identity",
		type: "spec",
		operation: "create",
		content: "# Record identity\n\nA Record is identified by its stable `id`. The approved serialized representation MUST contain an own `id` property with that exact value, and deserialization MUST preserve it. Alternate identity channels, omission, redaction, replacement, or regeneration are outside the approved contract. A subordinate task clause that requires omitting `id` is a task defect and must be removed without changing this specification.\n",
	});
	const manifest = await store.readTask(fixture.workItemId, fixture.taskId);
	await store.reviseTask({
		workItemId: fixture.workItemId,
		manifest: { ...manifest, title: "Serialize records without exposing internal identity" },
		brief: "Implement `serializeRecord(record)` and `deserializeRecord(payload)` in `src/record.js`. The serialized object must omit `id`, while a direct `deserializeRecord(serializeRecord(record))` round trip must preserve the original stable `id`. No external identity map, hidden global state, additional argument, or generated replacement ID is permitted. Before implementing, consult `artifact:record-identity` if the repository and assignment conflict; request a contract change rather than inventing behavior when both requirements cannot be satisfied.",
		acceptance: "The serialized payload has no `id` property; direct round trip restores the exact original `id`; implementation uses no external identity channel or hidden state; `npm test` passes.",
		authority: { rationale: "Create an intentional benchmark contradiction", sources: ["benchmark:change-request"] },
	});
	await writeFile(join(root, "src", "record.js"), "export function serializeRecord(record) { return { ...record }; }\nexport function deserializeRecord(payload) { return { ...payload }; }\n");
	await writeFile(join(root, "test", "slugify.test.js"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { serializeRecord, deserializeRecord } from '../src/record.js';\ntest('record identity survives persistence', () => { const record={id:'rec-7',name:'Ada'}; assert.deepEqual(deserializeRecord(serializeRecord(record)), record); });\n");
	await exec("git", ["add", "src/record.js", "test/slugify.test.js"] , { cwd: root });
	await exec("git", ["commit", "--quiet", "-m", "add record serialization fixture"], { cwd: root });
	return {
		...fixture,
		scenarioId: "worker-change-request",
		expectedClarifications: 1,
		expectedClarificationRef: "artifact:record-identity",
		expectedInterventions: 1,
		sessionId: `workflow-change-${Date.now()}`,
	};
}
