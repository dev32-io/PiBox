import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverRepository } from "../repository.js";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";
import { SubagentSupervisor } from "../supervisor.js";
import type { TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";
import { WorktreeManager } from "../worktrees.js";

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
			isolation: "worktree",
			parallelism: "allowed",
			resourceClaims: [],
			complexity: "low",
			assignment: { role: "implementer", model: "luna", effort: "medium", minimumCapabilityRank: 0, allowFallback: true, rationale: "test" },
		},
		assembly: { integrationUnit: "supervised-unit", intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: [], taskChecks: [], rationale: "fake process" },
	};
}

test("supervises a child contribution through a validated terminal handoff", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pibox-supervisor-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, ".gitignore"), "/.worktree/\n");
	await git(root, "add", "README.md", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "initial");
	const identity = await discoverRepository(root, join(parent, "home"));
	const store = new WorkItemStore(root);
	await store.create({ id: "supervised", title: "Supervised", kind: "change", intent: "Exercise supervision" });
	await store.defineTask({ workItemId: "supervised", manifest: manifest(), brief: "Create child.txt", acceptance: "child.txt is committed" });
	await store.submitPlanning("supervised");
	await store.approve("supervised");
	const task = await store.readTask("supervised", "supervised-task");
	const allocation = await new WorktreeManager(identity).allocate("supervised", task);

	const fake = join(parent, "fake-child.mjs");
	await writeFile(
		fake,
		`import { execFileSync } from "node:child_process";\nimport { mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync("child.txt", "from child\\n");\nexecFileSync("git", ["add", "child.txt"]);\nexecFileSync("git", ["commit", "-m", "child contribution"]);\nconst head=execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim();\nconst runRoot=join(process.env.PIBOX_HARNESS_PRIVATE_ROOT,"work-items",process.env.PIBOX_HARNESS_WORK_ITEM,"runs",process.env.PIBOX_HARNESS_RUN_ID);\nmkdirSync(runRoot,{recursive:true});\nwriteFileSync(join(runRoot,"handoff.json"),JSON.stringify({schemaVersion:1,type:"task_complete",runId:process.env.PIBOX_HARNESS_RUN_ID,taskId:process.env.PIBOX_HARNESS_TASK,summary:"fake complete",commits:[head],checks:[],expectedFailures:[],risks:[],completedAt:new Date().toISOString()}));\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}}));\n`,
	);
	const supervisor = new SubagentSupervisor(() => ({ command: process.execPath, args: [fake] }));
	const registry = new SessionAgentRegistry(identity.privateRoot, "session-test");
	await registry.initialize("main:session-test");
	const coordinator = new LaunchCoordinator(registry, "main:session-test", () => ({ command: process.execPath, args: [fake] }));
	const result = await supervisor.launchTask({
		identity,
		workItemId: "supervised",
		task,
		workspace: allocation.path,
		branch: allocation.branch,
		baseCommit: allocation.baseCommit,
		planningRevision: 2,
		persistentContext: "# Persistent Implementation Context\n\nBuild the supervised fixture.\n",
		model: { provider: "fake", model: "fake", effort: "medium", requested: "luna:medium" },
		coordinator,
	});
	assert.equal(result.run.state, "completed");
	assert.equal(result.handoff?.summary, "fake complete");
	assert.equal((await store.readTask("supervised", "supervised-task")).status, "contribution_complete");
	assert.equal(await readFile(join(allocation.path, "child.txt"), "utf8"), "from child\n");
});
