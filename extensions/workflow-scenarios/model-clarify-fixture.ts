import { createRoutineModelFixture, type RoutineModelFixture } from "./model-suite.js";
import { WorkItemStore } from "../workflow/work-items.js";

/** Deliberately incomplete ticket used only to prove the task_clarify escape hatch. */
export async function createClarifyModelFixture(root: string): Promise<RoutineModelFixture> {
	const fixture = await createRoutineModelFixture(root);
	const store = new WorkItemStore(root);
	await store.putArtifact({
		workItemId: fixture.workItemId,
		id: "slug-normalization",
		type: "spec",
		operation: "create",
		content: "# Slug normalization\n\n## Required behavior\n\n- Convert ASCII letters to lowercase.\n- Replace every run of one or more non-alphanumeric ASCII characters with exactly one hyphen.\n- Remove leading and trailing hyphens.\n\n## Examples\n\n- `  Hello, Workflow World!  ` becomes `hello-workflow-world`.\n- `One___two---` becomes `one-two`.\n",
	});
	const manifest = await store.readTask(fixture.workItemId, fixture.taskId);
	await store.reviseTask({
		workItemId: fixture.workItemId,
		manifest,
		brief: "Implement `slugify(value)` in `src/slugify.js` while preserving its exported interface and adding no dependencies. The exact normalization semantics were intentionally omitted from this ticket to exercise a concrete clarification. Read `artifact:slug-normalization` with `task_clarify` once when that missing rule blocks implementation; do not broadly list or reread context.",
		acceptance: "The implementation matches every behavior and example in the canonical slug-normalization specification, `npm test` passes, and the contribution is committed with a clean worktree.",
		authority: { rationale: "Create a benchmark-only clarification boundary", sources: ["benchmark:task-clarify"] },
	});
	return { ...fixture, scenarioId: "targeted-task-clarify", expectedClarifications: 1, expectedClarificationRef: "artifact:slug-normalization", sessionId: `workflow-clarify-${Date.now()}` };
}
