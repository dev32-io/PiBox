import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverRepository } from "../repository.js";
import { SessionAgentRegistry, type AgentState } from "../../workflow-runtime/agent-registry.js";
import { LaunchCoordinator } from "../../workflow-runtime/launch-coordinator.js";
import { SubagentSupervisor } from "../supervisor.js";
import type { TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";
import { WorktreeManager } from "../worktrees.js";
import { reconcileReportedAgents } from "../agent-reconciliation.js";
import { RepositoryMutex } from "../idempotency.js";
import { HarnessRunStore } from "../run-store.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<void> {
	await exec("git", args, { cwd });
}

function manifest(): TaskManifest {
	return {
		schemaVersion: 1,
		id: "supervised-task",
		title: "Supervised task",
		status: "ready",
		dependsOn: [],
		references: { specs: [], designs: [], decisions: [] },
		execution: {
			resourceClaims: [],
			assignment: { agent: "implementer", tier: "medium", rationale: "test" },
		},
		assembly: { integrationUnit: "supervised-unit", intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: [], taskChecks: [], rationale: "fake process" },
	};
}

test("supervises a child contribution through a reconciler race without duplicate completion", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pibox-supervisor-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/.pibox/\n");
	await git(root, "add", "README.md", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "initial");
	await git(root, "branch", "-M", "develop");
	const remote = join(parent, "remote.git");
	await git(parent, "init", "--bare", "--quiet", remote);
	await git(root, "remote", "add", "origin", remote);
	await git(root, "push", "--quiet", "-u", "origin", "develop");
	const identity = await discoverRepository(root, join(parent, "home"));
	const store = new WorkItemStore(root);
	await store.create({ id: "supervised", title: "Supervised", kind: "change", branchKind: "feature", intent: "Exercise supervision" });
	await store.defineTask({ workItemId: "supervised", manifest: manifest(), brief: "Create child.txt", acceptance: "child.txt is committed" });
	await store.submitPlanning("supervised");
	const task = await store.readTask("supervised", "supervised-task");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("supervised");
	const allocation = await manager.allocate("supervised", task);

	const fake = join(parent, "fake-child.mjs");
	await writeFile(
		fake,
		`import { execFileSync } from "node:child_process";\nimport { mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync("child.txt", "from child\\n");\nexecFileSync("git", ["add", "child.txt"]);\nexecFileSync("git", ["commit", "-m", "child contribution"]);\nconst head=execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim();\nconst runRoot=join(process.env.PIBOX_HARNESS_PRIVATE_ROOT,"work-items",process.env.PIBOX_HARNESS_WORK_ITEM,"runs",process.env.PIBOX_HARNESS_RUN_ID);\nmkdirSync(runRoot,{recursive:true});\nwriteFileSync(join(runRoot,"handoff.json"),JSON.stringify({schemaVersion:1,type:"task_complete",runId:process.env.PIBOX_HARNESS_RUN_ID,taskId:process.env.PIBOX_HARNESS_TASK,summary:"fake complete",commits:[head],checks:[],expectedFailures:[],risks:[],completedAt:new Date().toISOString()}));\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}}));\n`,
	);
	const supervisor = new SubagentSupervisor(() => ({ command: process.execPath, args: [fake] }));
	const registry = new SessionAgentRegistry(identity.privateRoot, "session-test");
	await registry.initialize("main:session-test");
	const coordinator = new LaunchCoordinator(registry, "main:session-test", () => ({ command: process.execPath, args: [fake] }));
	const transition = registry.transition.bind(registry);
	registry.transition = async (agentId: string, state: AgentState, update = {}) => {
		const transitioned = await transition(agentId, state, update);
		if (state === "reported") {
			assert.equal(supervisor.activeRunIds().length, 1, "the supervisor must retain settlement ownership after child exit");
			const reconciliation = await reconcileReportedAgents({
				identity,
				registry,
				workItems: store,
				mutex: new RepositoryMutex(identity.commonDir ?? identity.root),
				excludedRunIds: new Set(supervisor.activeRunIds()),
			});
			assert.deepEqual(reconciliation, { completed: [], pending: [], errors: [] });
		}
		return transitioned;
	};
	const result = await supervisor.launchTask({
		identity,
		workItemId: "supervised",
		task,
		workspace: allocation.path,
		branch: allocation.branch,
		baseCommit: allocation.baseCommit,
		executionMode: allocation.isolation,
		planningRevision: (await store.read("supervised")).planning.revision,
		persistentContext: "# Persistent Implementation Context\n\nBuild the supervised fixture.\n",
		model: { provider: "fake", model: "fake", effort: "medium", requested: "luna:medium" },
		coordinator,
	});
	assert.equal(result.run.state, "completed");
	assert.equal(result.handoff?.summary, "fake complete");
	assert.equal((await store.readTask("supervised", "supervised-task")).status, "contribution_complete");
	assert.equal((await registry.list())[0]?.state, "completed");
	const runEvents = (await readFile(join(identity.privateRoot, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { runId?: string } });
	assert.equal(runEvents.filter((event) => event.data?.runId === result.run.id && (event.type === "run.completed" || event.type === "run.reconciled_completed")).length, 1);
	assert.equal(await readFile(join(allocation.path, "child.txt"), "utf8"), "from child\n");
});


test("task CI red returns changes to the same logical implementer before acceptance", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pibox-supervisor-ci-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/.pibox/\n");
	await git(root, "add", "README.md", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "initial");
	await git(root, "branch", "-M", "develop");
	const identity = await discoverRepository(root, join(parent, "home"));
	const store = new WorkItemStore(root);
	await store.create({ id: "ci-loop", title: "CI loop", kind: "change", branchKind: "feature", intent: "Return deterministic CI failures to the implementer" });
	const planned = manifest();
	planned.verification.taskChecks = ["test -f green.txt"];
	await store.defineTask({ workItemId: "ci-loop", manifest: planned, brief: "Create green.txt", acceptance: "green.txt exists" });
	await store.submitPlanning("ci-loop");
	const manager = new WorktreeManager(identity);
	const allocation = await manager.allocate("ci-loop", await store.readTask("ci-loop", planned.id));

	const fake = join(parent, "fake-ci-child.mjs");
	await writeFile(fake, `import { execFileSync } from "node:child_process";\nimport { existsSync, mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst second=existsSync("first.txt");\nconst file=second?"green.txt":"first.txt";\nwriteFileSync(file, second?"green\\n":"first\\n");\nexecFileSync("git",["add",file]);\nexecFileSync("git",["commit","-m",second?"repair CI":"submit red candidate"]);\nconst head=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();\nconst runRoot=join(process.env.PIBOX_HARNESS_PRIVATE_ROOT,"work-items",process.env.PIBOX_HARNESS_WORK_ITEM,"runs",process.env.PIBOX_HARNESS_RUN_ID);\nmkdirSync(runRoot,{recursive:true});\nwriteFileSync(join(runRoot,"handoff.json"),JSON.stringify({schemaVersion:1,type:"task_complete",runId:process.env.PIBOX_HARNESS_RUN_ID,taskId:process.env.PIBOX_HARNESS_TASK,summary:second?"CI repaired":"candidate submitted",commits:[head],checks:[],expectedFailures:[],risks:[],completedAt:new Date().toISOString()}));\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:second?"repaired":"submitted"}]}}));\n`);
	const registry = new SessionAgentRegistry(identity.privateRoot, "session-ci-loop");
	await registry.initialize("main:session-ci-loop");
	const coordinator = new LaunchCoordinator(registry, "main:session-ci-loop", () => ({ command: process.execPath, args: [fake] }));
	const supervisor = new SubagentSupervisor(() => ({ command: process.execPath, args: [fake] }));
	const launch = async () => supervisor.launchTask({
		identity, workItemId: "ci-loop", task: await store.readTask("ci-loop", planned.id), workspace: allocation.path, branch: allocation.branch,
		baseCommit: allocation.baseCommit, executionMode: allocation.isolation, planningRevision: (await store.read("ci-loop")).planning.revision,
		persistentContext: "# Persistent Implementation Context\n\nKeep CI green.\n", model: { provider: "fake", model: "fake", effort: "medium", requested: "medium" }, coordinator,
	});

	const first = await launch();
	assert.equal(first.run.state, "changes_requested");
	const rejected = await store.readTask("ci-loop", planned.id);
	assert.equal(rejected.status, "changes_requested");
	assert.equal(rejected.runtime?.deterministicFailure?.kind, "task_check");
	assert.match(rejected.runtime?.deterministicFailure?.attemptPath ?? "", /verification\/task-supervised-task\/check-1\/attempts\/001$/);
	const owner = (await registry.list())[0]!;
	assert.equal(owner.state, "reported", "CI rejection keeps the logical implementer resumable");

	const second = await launch();
	assert.equal(second.run.state, "completed");
	assert.equal((await store.readTask("ci-loop", planned.id)).status, "contribution_complete");
	const resumed = (await registry.list())[0]!;
	assert.equal(resumed.id, owner.id);
	assert.equal(resumed.attempts.length, 2, "CI repair is another process attempt in the same Pi session");
	assert.equal(resumed.state, "completed");
});
