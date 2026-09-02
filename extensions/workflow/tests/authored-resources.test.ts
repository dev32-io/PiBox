import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { CanonicalMutationCoordinator } from "../canonical-mutation.js";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { OrchestratorResourceService } from "../orchestrator-resources.js";
import { createStoryRuntimeState } from "../stage-state-machine.js";
import { StoryRuntimeStore } from "../story-runtime-store.js";
import { parseAuthoredTaskDocument, parseStoryDocument, parseStoryPlanDocument, WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim(); }
async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-authored-resources-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Resource Test");
	await git(root, "config", "user.email", "resource@example.test");
	await writeFile(join(root, "README.md"), "# Fixture\n");
	await git(root, "add", ".");
	await git(root, "commit", "--quiet", "-m", "initial");
	await git(root, "branch", "-M", "develop");
	return root;
}

const story = {
	schemaVersion: 1 as const,
	id: "free-form-story",
	title: "Free-form story",
	kind: "story" as const,
	spec: "# Spec\n\nAny Markdown structure is valid.",
	design: "# Design\n\nUse the existing repository boundary.",
	e2e: "# E2E\n\nRun the user journey and retain observable evidence.",
};
const task = {
	schemaVersion: 1 as const,
	id: "write-resources",
	title: "Write resources",
	dependsOn: [],
	description: "Write the target authored resource files.",
	scope: "Only story, plan, and task persistence.",
	delivery: "Return the implementation and passing focused checks.",
	checks: ["npm test -- authored-resources"],
	assignment: { agent: "implementer", tier: "medium" as const, rationale: "A bounded persistence implementation." },
};
const plan = { schemaVersion: 1 as const, stages: [{ id: "delivery", tasks: [task.id], mode: "sequential" as const, checks: ["npm run check"], review: { mode: "required" as const, focus: "Check exact target resource shape." } }] };

test("parses and round-trips exact target documents", () => {
	assert.deepEqual(parseStoryDocument(stringify(story)), story);
	assert.deepEqual(parseAuthoredTaskDocument(stringify(task)), task);
	assert.deepEqual(parseStoryPlanDocument(stringify(plan)), plan);
	assert.throws(() => parseStoryDocument(stringify({ ...story, intent: "legacy" })), /unknown field.*intent/i);
	assert.throws(() => parseAuthoredTaskDocument(stringify({ ...task, references: { specs: [] } })), /unknown field.*references/i);
	assert.throws(() => parseStoryPlanDocument(stringify({ ...plan, stages: [{ ...plan.stages[0], review: { mode: "required", maxIterations: 2 } }] })), /unknown field.*maxIterations/i);
	assert.throws(() => parseStoryPlanDocument(stringify({ ...plan, stages: [{ ...plan.stages[0], mode: undefined }] })), /must declare.*mode/i);
});

test("specialized flat writers render structured story and independently editable E2E cases", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await service.writeStory({
		id: "structured-story", title: "Structured story", kind: "story",
		outcome: "A user completes the bounded journey.", scope: "Include the journey; exclude unrelated administration.", behavior: "The system preserves one stable result and reports invalid input.", acceptance: "The valid journey succeeds; invalid input remains unchanged and visible.",
		approach: "Use the existing command boundary.", boundariesAndFlow: "The UI emits one command and renders its typed result.", failureAndVerification: "Typed failures do not persist; focused command tests establish the invariant.",
		e2eScope: "The primary disposable user journey.", e2eExclusions: "Production data and destructive operations.",
	});
	await service.writeE2e({ story: "work-item:structured-story", id: "E2E-001", title: "Complete the journey", exercise: "Use a disposable actor and submit valid input.", oracle: "One visible confirmation identifies one durable result.", proof: "Capture the confirmation, inspect the disposable result, then remove it." });
	await service.writeE2e({ ref: "work-item:structured-story/e2e:E2E-001", oracle: "Exactly one visible confirmation identifies exactly one durable result." });
	const authored = await store.readStory("structured-story");
	assert.match(authored.spec, /## Outcome[\s\S]+## Scope[\s\S]+## Behavior[\s\S]+## Acceptance/);
	assert.match(authored.design, /## Approach[\s\S]+## Boundaries and Flow[\s\S]+## Failure and Verification/);
	assert.match(authored.e2e, /## E2E-001 — Complete the journey[\s\S]+### Exercise[\s\S]+### Oracle[\s\S]+Exactly one visible confirmation[\s\S]+### Proof/);
	assert.equal((await service.compile("structured-story")).phase, "story");
	assert.deepEqual((await service.listSummaries("e2e", "structured-story")).map((entry) => entry.ref), ["work-item:structured-story/e2e:E2E-001"]);
});

test("legitimate todo domain language is not treated as placeholder content", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await service.writeStory({ id: "todo-app", title: "Todo app", outcome: "A user manages a local todo.", scope: "The todo lifecycle only.", behavior: "A todo can be completed.", acceptance: "The todo remains visible.", approach: "Use the existing todo boundary.", boundariesAndFlow: "The todo UI calls the todo store.", failureAndVerification: "Invalid todos remain unchanged and focused tests prove it.", e2eScope: "The local todo journey." });
	await service.writeE2e({ story: "work-item:todo-app", id: "E2E-001", title: "Create a todo", exercise: "Create one todo.", oracle: "The todo is visible.", proof: "Capture the visible todo." });
	assert.equal((await service.compile("todo-app")).phase, "story");
	await service.writeStory({ ref: "work-item:todo-app", outcome: "tbd" });
	await service.writeE2e({ ref: "work-item:todo-app/e2e:E2E-001", title: "TODO" });
	await assert.rejects(service.compile("todo-app"), /Story outcome contains placeholder content: "tbd"[\s\S]+E2E-001 title contains placeholder content: "TODO"/i);
});

test("story writers reject reserved nested headings before persistence", async (t) => {
	const root = await repository(t);
	const service = new OrchestratorResourceService(root, new WorkItemStore(root));
	await assert.rejects(service.writeStory({ id: "nested-headings", title: "Nested headings", outcome: "One result.", scope: "## Included\n\nThe result.", behavior: "One request returns it.", acceptance: "It is visible.", approach: "Use the boundary.", boundariesAndFlow: "One adapter owns it.", failureAndVerification: "Typed failure and focused proof.", e2eScope: "The result journey." }), /Story scope contains reserved level-2 heading ## Included; use a deeper heading or bold text/i);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
});

test("story compilation aggregates placeholders and missing E2E coverage without mutating drafts", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await service.writeStory({ id: "invalid-draft", title: "Invalid draft", outcome: "TBD", scope: "Only this path.", behavior: "A request returns a result.", acceptance: "The result is visible.", approach: "TODO", boundariesAndFlow: "One adapter owns the flow.", failureAndVerification: "Typed failure and focused proof.", e2eScope: "The disposable journey." });
	const before = await readFile(join(root, "agent-artifacts", "invalid-draft", "story.yaml"), "utf8");
	await assert.rejects(service.compile("invalid-draft"), (error: unknown) => {
		assert.match(String(error), /3 issues/);
		assert.match(String(error), /at least one authored case/);
		assert.match(String(error), /outcome contains placeholder content/);
		assert.match(String(error), /approach contains placeholder content/);
		return true;
	});
	assert.equal(await readFile(join(root, "agent-artifacts", "invalid-draft", "story.yaml"), "utf8"), before);
});

test("a complete story_write migrates an unstructured story and remains editable before runtime state", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await store.writeStoryDocument({ story });
	await assert.doesNotReject(service.listSummaries());
	await assert.rejects(service.writeStory({ ref: `work-item:${story.id}`, title: "Partial legacy edit" }), /Stored story spec is invalid; resend outcome, scope, behavior, and acceptance together/i);
	await service.writeStory({ ref: `work-item:${story.id}`, outcome: "A durable result.", scope: "The result path only.", behavior: "One request creates one result.", acceptance: "The result is observable.", approach: "Use the existing service.", boundariesAndFlow: "One adapter calls the service.", failureAndVerification: "Typed failures do not persist and focused tests prove it.", e2eScope: "The disposable result journey." });
	await service.writeE2e({ story: `work-item:${story.id}`, id: "E2E-001", title: "Create result", exercise: "Submit a disposable valid request.", oracle: "One result is visible.", proof: "Capture and remove the disposable result." });
	await store.writeAuthoredPlan({ story: await store.readStory(story.id), plan, tasks: [task] });
	await service.writeStory({ ref: `work-item:${story.id}`, acceptance: "Exactly one durable result is observable." });
	assert.match((await store.readStory(story.id)).spec, /Exactly one durable result is observable/);
	assert.equal((await service.compile(story.id)).phase, "plan");
});

test("complete legacy migration refuses to discard case-like E2E content", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await store.writeStoryDocument({ story: { ...story, id: "legacy-cases", e2e: "# E2E\n\n## E2E-001 — Legacy case\n\nUnstructured legacy content.\n" } });
	await assert.rejects(service.writeStory({ ref: "work-item:legacy-cases", outcome: "A durable result.", scope: "Only the result.", behavior: "A request returns it.", acceptance: "It is visible.", approach: "Use one boundary.", boundariesAndFlow: "One adapter owns it.", failureAndVerification: "Typed failure and focused proof.", e2eScope: "The result journey." }), /case-like sections that cannot be migrated without data loss/i);
	await assert.rejects(service.writeE2e({ story: "work-item:legacy-cases", id: "E2E-002", title: "New case", exercise: "Act.", oracle: "Observe.", proof: "Capture." }), /migrate it with a complete story_write before authoring cases/i);
});

test("flat writers reject conflicting refs and preserve whole-array replacement semantics", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await service.writeStory({ id: "writer-contract", title: "Writer contract", outcome: "Deliver one result.", scope: "Only the result.", behavior: "A request returns it.", acceptance: "It is visible.", approach: "Use one boundary.", boundariesAndFlow: "One adapter owns it.", failureAndVerification: "Typed failure and focused proof.", e2eScope: "The result journey." });
	await service.writeE2e({ story: "work-item:writer-contract", id: "E2E-001", title: "Observe result", exercise: "Submit one request.", oracle: "The result is visible.", proof: "Capture it." });
	await service.writeTask({ story: "work-item:writer-contract", id: "implement", title: "Implement result", dependsOn: ["first", "second"], description: "Implement the result.", scope: "Own the result only.", delivery: "Return the result with proof.", checks: ["check-a", "check-b"] });
	await service.writeStage({ story: "work-item:writer-contract", id: "delivery", mode: "sequential", tasks: ["implement", "later"], checks: ["stage-a", "stage-b"] });

	await assert.rejects(service.writeStory({ ref: "work-item:writer-contract", id: "other", title: "Wrong" }), /Story id other conflicts with ref id writer-contract/);
	await assert.rejects(service.writeE2e({ ref: "work-item:writer-contract/e2e:E2E-001", id: "E2E-002", title: "Wrong" }), /E2E case id E2E-002 conflicts/);
	await assert.rejects(service.writeE2e({ ref: "work-item:writer-contract/e2e:E2E-001", story: "work-item:other", title: "Wrong" }), /E2E case story work-item:other conflicts/);
	await assert.rejects(service.writeE2e({ ref: "work-item:writer-contract/e2e:E2E-001", title: "Two\nlines" }), /E2E title must be a single line/);
	await assert.rejects(service.writeTask({ ref: "work-item:writer-contract/task:implement", id: "other", title: "Wrong" }), /Task id other conflicts/);
	await assert.rejects(service.writeTask({ ref: "work-item:writer-contract/task:implement", story: "work-item:other", title: "Wrong" }), /Task story work-item:other conflicts/);
	await assert.rejects(service.writeStage({ ref: "work-item:writer-contract/stage:delivery", id: "other", mode: "concurrent" }), /Stage id other conflicts/);
	await assert.rejects(service.writeStage({ ref: "work-item:writer-contract/stage:delivery", story: "work-item:other", mode: "concurrent" }), /Stage story work-item:other conflicts/);
	await assert.rejects(service.writeStage({ ref: "work-item:writer-contract/stage:delivery", reviewFocus: "Missing policy" }), /reviewFocus requires reviewMode required or skip/);
	await assert.rejects(service.writeStory({ ref: "work-item:writer-contract", workingBranch: "feature/other" }), /creation-only story fields/);

	await service.writeStory({ ref: "work-item:writer-contract", e2eExclusions: "Destructive production paths." });
	await service.writeE2e({ ref: "work-item:writer-contract/e2e:E2E-001", oracle: "Exactly one result is visible." });
	assert.match((await store.readStory("writer-contract")).e2e, /## Exclusions[\s\S]+Destructive production paths/);
	await service.writeStory({ ref: "work-item:writer-contract", e2eExclusions: "" });
	assert.doesNotMatch((await store.readStory("writer-contract")).e2e, /## Exclusions/);
	await service.writeTask({ ref: "work-item:writer-contract/task:implement", dependsOn: ["first"], checks: ["check-c"] });
	await service.writeStage({ ref: "work-item:writer-contract/stage:delivery", tasks: ["implement"], checks: ["stage-c"], reviewMode: "required", reviewFocus: "Review the boundary" });
	await service.writeStage({ ref: "work-item:writer-contract/stage:delivery", reviewFocus: "   " });
	const revisedTask = await store.readAuthoredTask("writer-contract", "implement");
	const revisedStage = (await store.readStoryPlan("writer-contract", { draft: true })).stages[0]!;
	assert.deepEqual(revisedTask.dependsOn, ["first"]);
	assert.deepEqual(revisedTask.checks, ["check-c"]);
	assert.deepEqual(revisedStage.tasks, ["implement"]);
	assert.deepEqual(revisedStage.checks, ["stage-c"]);
	assert.deepEqual(revisedStage.review, { mode: "required" });
});

test("flat writer creation errors name required task and stage fields", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await service.writeStory({ id: "required-fields", title: "Required fields", outcome: "Deliver one result.", scope: "Only the result.", behavior: "A request returns it.", acceptance: "It is visible.", approach: "Use one boundary.", boundariesAndFlow: "One adapter owns it.", failureAndVerification: "Typed failure and focused proof.", e2eScope: "The result journey." });
	await assert.rejects(service.writeTask({ story: "work-item:required-fields", id: "missing-title", description: "Implement it.", scope: "Own it.", delivery: "Return it." }), /Task title is required/);
	await assert.rejects(service.writeStage({ story: "work-item:required-fields", id: "missing-mode" }), /Stage mode is required/);
});

test("draft task and stage relationships remain editable until aggregate compilation", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await service.writeStory({ id: "compiled-draft", title: "Compiled draft", outcome: "Deliver one result.", scope: "Only the result path.", behavior: "A valid request returns the result.", acceptance: "The result is observable.", approach: "Use the existing boundary.", boundariesAndFlow: "One adapter calls one service.", failureAndVerification: "Typed failures and focused tests.", e2eScope: "The disposable result journey." });
	await service.writeE2e({ story: "work-item:compiled-draft", id: "E2E-001", title: "Observe result", exercise: "Submit a disposable valid request.", oracle: "The result is visible.", proof: "Capture it and remove disposable state." });
	await service.writeTask({ story: "work-item:compiled-draft", id: "consumer", title: "Build consumer", dependsOn: ["foundation"], description: "Consume the future boundary.", scope: "Own the consumer only.", delivery: "Return the consumer with focused proof.", checks: ["npm test -- consumer"] });
	await service.writeStage({ story: "work-item:compiled-draft", id: "delivery", mode: "sequential", tasks: [] });
	await assert.rejects(service.compile("compiled-draft"), (error: unknown) => {
		assert.match(String(error), /3 issues/);
		assert.match(String(error), /must contain at least one task/);
		assert.match(String(error), /not assigned to a stage/);
		assert.match(String(error), /unknown or unscheduled task foundation/);
		return true;
	});
	await service.writeTask({ story: "work-item:compiled-draft", id: "foundation", title: "Build foundation", description: "Create the bounded interface.", scope: "Own the interface only.", delivery: "Return the interface with focused proof.", checks: ["npm test -- foundation"] });
	await service.writeStage({ ref: "work-item:compiled-draft/stage:delivery", tasks: ["foundation", "consumer"], reviewMode: "required", reviewFocus: "Interface compatibility" });
	const compiled = await service.compile("compiled-draft");
	assert.equal(compiled.phase, "plan");
	assert.deepEqual(compiled.counts, { e2eCases: 1, tasks: 2, stages: 1 });
});

test("workflow_compile rejects unknown verification profiles from otherwise valid drafts", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	config.verification = { defaultProfile: "project", profiles: { project: { shell: "/bin/sh", requiredEnvironment: [] } } };
	const service = new OrchestratorResourceService(root, store, config);
	await service.writeStory({ id: "profile-draft", title: "Profile draft", outcome: "Deliver one result.", scope: "Only the result path.", behavior: "A valid request returns the result.", acceptance: "The result is observable.", approach: "Use the existing boundary.", boundariesAndFlow: "One adapter calls one service.", failureAndVerification: "Typed failures and focused tests.", e2eScope: "The disposable result journey." });
	await service.writeE2e({ story: "work-item:profile-draft", id: "E2E-001", title: "Observe result", exercise: "Submit a disposable valid request.", oracle: "The result is visible.", proof: "Capture it and remove disposable state." });
	await service.writeTask({ story: "work-item:profile-draft", id: "implement", title: "Implement result", description: "Implement the result boundary.", scope: "Own the result only.", delivery: "Return the result with focused proof.", checks: [{ id: "focused", command: "true", profile: "missing" }] });
	await service.writeStage({ story: "work-item:profile-draft", id: "delivery", mode: "sequential", tasks: ["implement"] });
	await assert.rejects(service.compile("profile-draft"), /Task implement check focused selects unknown profile: missing/);
});

test("resource transaction gives actionable guidance for an unborn repository", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-authored-unborn-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Resource Test");
	await git(root, "config", "user.email", "resource@example.test");
	await writeFile(join(root, "README.md"), "uncommitted\n");
	const service = new OrchestratorResourceService(root, new WorkItemStore(root));
	let invoked = false;
	await assert.rejects(service.transaction("harness: unborn", async () => { invoked = true; }), /requires a repository with at least one commit and a checked-out develop or feature\/fix branch/i);
	assert.equal(invoked, false);
});

test("resource transaction reenters the shared store mutex and commits one authored change", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	const changed = await service.transaction("harness: write work-item", () => store.writeStoryDocument({ story }));
	assert.equal(typeof changed.commit, "string");
	assert.equal(await git(root, "branch", "--show-current"), `feature/${story.id}`);
	assert.equal(await git(root, "rev-list", "--count", "develop..HEAD"), "1");
	assert.equal(await git(root, "log", "-1", "--format=%s"), "harness(resource-api): write work-item");
	assert.equal((await store.readStory(story.id)).title, story.title);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("story transaction accepts a legitimate develop fast-forward before branching", async (t) => {
	const root = await repository(t);
	const remote = await mkdtemp(join(tmpdir(), "pibox-authored-remote-"));
	const updater = await mkdtemp(join(tmpdir(), "pibox-authored-updater-"));
	t.after(() => Promise.all([rm(remote, { recursive: true, force: true }), rm(updater, { recursive: true, force: true })]));
	await exec("git", ["init", "--bare", "--quiet", remote]);
	await git(root, "remote", "add", "origin", remote);
	await git(root, "push", "--quiet", "-u", "origin", "develop");
	await exec("git", ["clone", "--quiet", "--branch", "develop", remote, updater]);
	await git(updater, "config", "user.name", "Updater");
	await git(updater, "config", "user.email", "updater@example.test");
	await writeFile(join(updater, "UPSTREAM.md"), "upstream\n");
	await git(updater, "add", "."); await git(updater, "commit", "--quiet", "-m", "upstream change"); await git(updater, "push", "--quiet", "origin", "develop");
	const upstream = await git(updater, "rev-parse", "HEAD");
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	const changed = await service.transaction("harness: write work-item", () => store.writeStoryDocument({ story }));
	assert.equal(typeof changed.commit, "string");
	assert.equal(await git(root, "branch", "--show-current"), `feature/${story.id}`);
	assert.equal(await git(root, "merge-base", "HEAD", upstream), upstream);
	assert.equal(await readFile(join(root, "UPSTREAM.md"), "utf8"), "upstream\n");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("nested authoring commit failures restore owned files and index state", async (t) => {
	const root = await repository(t);
	const initial = new WorkItemStore(root);
	const initialService = new OrchestratorResourceService(root, initial);
	await initialService.writeStory({ id: story.id, title: story.title, outcome: "Deliver one result.", scope: "Only the result path.", behavior: "A valid request returns one result.", acceptance: "The result is observable.", approach: "Use the existing boundary.", boundariesAndFlow: "One adapter calls one service.", failureAndVerification: "Typed failures do not persist and focused checks prove the result.", e2eScope: "The disposable result journey." });
	await initialService.writeE2e({ story: `work-item:${story.id}`, id: "E2E-001", title: "Observe result", exercise: "Submit a disposable valid request.", oracle: "One result is visible.", proof: "Capture and remove the disposable result." });
	const authoredStory = await initial.readStory(story.id);
	await initial.writeAuthoredPlan({ story: authoredStory, plan, tasks: [task] });
	const beforeStory = await readFile(join(root, "agent-artifacts", story.id, "story.yaml"), "utf8");
	const beforeTask = await readFile(join(root, "agent-artifacts", story.id, "tasks", `${task.id}.yaml`), "utf8");
	class StagedFailureCoordinator extends CanonicalMutationCoordinator {
		override async commitHarness(paths: string[]): Promise<void> {
			await git(root, "add", "--", ...paths.map((path) => relative(root, path)));
			throw new Error("injected nested commit failure");
		}
	}
	const store = new WorkItemStore(root, new StagedFailureCoordinator(root));
	const service = new OrchestratorResourceService(root, store);
	await assert.rejects(service.writeStory({ ref: `work-item:${story.id}`, title: "Rejected title" }), /injected nested commit failure/);
	assert.equal(await readFile(join(root, "agent-artifacts", story.id, "story.yaml"), "utf8"), beforeStory);
	assert.equal(await git(root, "status", "--porcelain"), "");
	await assert.rejects(service.writeTask({ ref: `work-item:${story.id}/task:${task.id}`, description: "Rejected task edit" }), /injected nested commit failure/);
	assert.equal(await readFile(join(root, "agent-artifacts", story.id, "tasks", `${task.id}.yaml`), "utf8"), beforeTask);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("resource transaction restores branch and worktree when its squash commit fails", async (t) => {
	const root = await repository(t);
	class FailingSquashCoordinator extends CanonicalMutationCoordinator {
		commits = 0;
		override async commitHarness(paths: string[], message: string): Promise<void> {
			this.commits += 1;
			if (this.commits === 2) throw new Error("injected squash failure");
			await super.commitHarness(paths, message);
		}
	}
	const coordinator = new FailingSquashCoordinator(root);
	const store = new WorkItemStore(root, coordinator);
	const service = new OrchestratorResourceService(root, store);
	await assert.rejects(service.transaction("harness: write work-item", () => store.writeStoryDocument({ story })), /injected squash failure/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
	assert.equal(await git(root, "branch", "--list", `feature/${story.id}`), "");
	assert.equal(await git(root, "status", "--porcelain"), "");
	await assert.rejects(readFile(join(root, "agent-artifacts", story.id, "story.yaml")), /ENOENT/);
});

test("resource rollback preserves unrelated tracked edits made during squash failure", async (t) => {
	const root = await repository(t);
	class ConcurrentEditCoordinator extends CanonicalMutationCoordinator {
		commits = 0;
		override async commitHarness(paths: string[], message: string): Promise<void> {
			this.commits += 1;
			if (this.commits === 2) {
				await writeFile(join(root, "README.md"), "# Concurrent user edit\n");
				throw new Error("injected squash failure after concurrent edit");
			}
			await super.commitHarness(paths, message);
		}
	}
	const coordinator = new ConcurrentEditCoordinator(root);
	const store = new WorkItemStore(root, coordinator);
	const service = new OrchestratorResourceService(root, store);
	await assert.rejects(service.transaction("harness: write work-item", () => store.writeStoryDocument({ story })), /injected squash failure/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
	assert.equal(await git(root, "branch", "--list", `feature/${story.id}`), "");
	assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Concurrent user edit\n");
	assert.equal(await git(root, "status", "--porcelain"), "M README.md");
	await assert.rejects(readFile(join(root, "agent-artifacts", story.id, "story.yaml")), /ENOENT/);
});

test("resource rollback preserves unrelated edits when a nested authoring operation later fails", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await assert.rejects(service.transaction("harness: nested operation failure", async () => {
		await store.writeStoryDocument({ story });
		await writeFile(join(root, "README.md"), "# Concurrent edit after nested commit\n");
		throw new Error("injected operation failure after nested commit");
	}), /injected operation failure/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
	assert.equal(await git(root, "branch", "--list", `feature/${story.id}`), "");
	assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Concurrent edit after nested commit\n");
	assert.equal(await git(root, "status", "--porcelain"), "M README.md");
	await assert.rejects(readFile(join(root, "agent-artifacts", story.id, "story.yaml")), /ENOENT/);
});

test("persists story and plan as distinct review boundaries with one YAML per task", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await store.writeStoryDocument({ story });
	const storyRoot = join(root, "agent-artifacts", story.id);
	assert.deepEqual(await readdir(storyRoot), ["story.yaml"]);
	assert.equal((await store.readStory(story.id)).spec, story.spec);
	const shaped = await service.get(`work-item:${story.id}`) as any;
	assert.deepEqual(shaped.resource, story);

	await store.writeAuthoredPlan({ story, plan, tasks: [task] });
	assert.deepEqual((await readdir(storyRoot)).sort(), ["plan.yaml", "story.yaml", "tasks"]);
	assert.deepEqual(await readdir(join(storyRoot, "tasks")), [`${task.id}.yaml`]);
	assert.deepEqual(await store.readStoryPlan(story.id), plan);
	assert.deepEqual(await store.readAuthoredTask(story.id, task.id), task);
	for (const obsolete of ["index.yaml", "intent.md", "brief.md", "acceptance.md", "evaluations"]) {
		assert.equal((await readdir(storyRoot, { recursive: true })).some((entry) => String(entry).endsWith(obsolete)), false);
	}
	assert.equal((await store.readStory(story.id)).spec, story.spec);
	assert.equal((await store.readAuthoredTask(story.id, task.id)).description, task.description);
	assert.equal((await store.readStoryPlan(story.id)).stages[0]?.review && "maxIterations" in (await store.readStoryPlan(story.id)).stages[0]!.review!, false);
	const submitted = await store.submitPlanning(story.id);
	assert.equal(submitted.delivery?.workingBranch, `feature/${story.id}`);
	const head = await git(root, "rev-parse", "HEAD");
	const beforeStory = await readFile(join(storyRoot, "story.yaml"), "utf8");
	const beforePlan = await readFile(join(storyRoot, "plan.yaml"), "utf8");
	const begun = await store.beginExecution(story.id);
	assert.equal(begun.phase, "execution");
	assert.equal(begun.delivery?.executionStartCommit, head);
	assert.equal(await git(root, "rev-parse", "HEAD"), head);
	assert.equal(await readFile(join(storyRoot, "story.yaml"), "utf8"), beforeStory);
	assert.equal(await readFile(join(storyRoot, "plan.yaml"), "utf8"), beforePlan);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("reads, patches, and deletes semantic target task resources", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await store.writeStoryDocument({ story });
	await store.writeAuthoredPlan({ story, plan, tasks: [task] });
	await service.writeTask({ ref: `work-item:${story.id}/task:${task.id}`, description: "Revised complete task description." });
	assert.equal((await service.get(`work-item:${story.id}/task:${task.id}`) as any).resource.description, "Revised complete task description.");
	await service.delete(`work-item:${story.id}/task:${task.id}`, { authority: { rationale: "Delete task" } });
	assert.deepEqual((await store.readStoryPlan(story.id, { draft: true })).stages, [{ ...plan.stages[0]!, tasks: [] }]);
	assert.deepEqual(await readdir(join(root, "agent-artifacts", story.id, "tasks")), []);
});

test("submit validates target concurrency and on-disk task membership without legacy stores", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const dependent = { ...task, id: "dependent-task", title: "Dependent task", dependsOn: [task.id] };
	const concurrentPlan = { schemaVersion: 1 as const, stages: [{ id: "parallel", tasks: [task.id, dependent.id], mode: "concurrent" as const, checks: [] }] };
	await store.writeStoryDocument({ story });
	await store.writeAuthoredPlan({ story, plan: concurrentPlan, tasks: [task, dependent] });
	await assert.rejects(store.submitPlanning(story.id), /concurrent peers.*cannot block/i);

	const repaired = { ...concurrentPlan, stages: [{ ...concurrentPlan.stages[0]!, mode: "sequential" as const }] };
	await store.writeAuthoredPlan({ story, plan: repaired, tasks: [task, dependent], replace: true });
	await store.submitPlanning(story.id);
	await writeFile(join(root, "agent-artifacts", story.id, "tasks", "orphan.yaml"), stringify({ ...task, id: "orphan", title: "Orphan" }));
	await git(root, "add", ".");
	await git(root, "commit", "--quiet", "-m", "test: add malformed target topology");
	await assert.rejects(store.submitPlanning(story.id), /reference every authored task exactly once/i);
	await assert.rejects(readFile(join(root, "agent-artifacts", story.id, "index.yaml")), /ENOENT/);
});

test("target branch discovery remains exact across current and wrong branches", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const base = await git(root, "rev-parse", "HEAD");
	await store.writeStoryDocument({ story });
	await store.writeAuthoredPlan({ story, plan, tasks: [task] });
	assert.deepEqual((await store.listForCurrentBranch()).map((item) => item.id), [story.id]);
	assert.equal((await store.read(story.id)).delivery?.workingBranch, `feature/${story.id}`);
	assert.equal((await store.read(story.id)).delivery?.createdFromCommit, base);

	await git(root, "switch", "develop");
	assert.deepEqual(await store.listForCurrentBranch(), []);
	await assert.rejects(store.read(story.id), /Target story does not exist/);
	await git(root, "switch", "-c", "feature/wrong-branch");
	assert.deepEqual(await store.listForCurrentBranch(), []);
	await assert.rejects(store.read(story.id), /Target story does not exist/);
	assert.equal((await store.findDelivery(story.id))?.workingBranch, `feature/${story.id}`);
});

test("story revision remains bound to its persisted feature or fix branch", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.writeStoryDocument({ story });
	await git(root, "switch", "-c", "feature/wrong-branch");
	await assert.rejects(store.reviseStoryDocument({ ...story, spec: "wrong branch mutation" }), /bound feature\/fix branch/i);
	assert.equal((await readFile(join(root, "agent-artifacts", story.id, "story.yaml"), "utf8")).includes("wrong branch mutation"), false);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("plan authoring cannot rewrite the reviewed story", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.writeStoryDocument({ story });
	await assert.rejects(store.writeAuthoredPlan({ story: { ...story, spec: "Changed during planning" }, plan, tasks: [task] }), /cannot rewrite.*reviewed story/i);
	assert.equal((await readFile(join(root, "agent-artifacts", story.id, "story.yaml"), "utf8")).includes("Changed during planning"), false);
});

test("authored contracts become immutable as soon as authoritative state exists", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	await store.writeStoryDocument({ story });
	await store.writeAuthoredPlan({ story, plan, tasks: [task] });
	const head = await git(root, "rev-parse", "HEAD");
	const runtime = createStoryRuntimeState({ stages: [{ id: "delivery", mode: "sequential", tasks: [{ id: task.id }], checks: [], review: { mode: "required" } }] }, {
		storyId: story.id,
		contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: { [task.id]: `sha256:${"c".repeat(64)}` } },
		git: { canonicalBranch: `feature/${story.id}`, baseCommit: head },
	});
	await new StoryRuntimeStore(root, story.id).writeState(runtime);
	await assert.rejects(service.writeTask({ ref: `work-item:${story.id}/task:${task.id}`, description: "late mutation" }), /immutable once authoritative runtime state exists/i);
	await assert.rejects(store.writeAuthoredPlan({ story, plan: { ...plan, stages: [{ ...plan.stages[0]!, mode: "concurrent" }] }, tasks: [task], replace: true }), /immutable once authoritative runtime state exists/i);
	await assert.rejects(store.reviseStoryDocument({ ...story, spec: "late story mutation" }), /immutable once authoritative runtime state exists/i);
});
