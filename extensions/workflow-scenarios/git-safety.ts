import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discoverRepository } from "../workflow/repository.js";
import type { EvaluationManifest, TaskManifest } from "../workflow/types.js";
import { WorkItemStore } from "../workflow/work-items.js";
import { WorktreeManager } from "../workflow/worktrees.js";
import type { ScenarioDimension, WorkflowScenarioResult } from "./types.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }

function task(id: string): TaskManifest {
	return {
		schemaVersion: 1, id, title: id, status: "ready", dependsOn: [],
		execution: { resourceClaims: [`${id}-files`], assignment: { agent: "implementer", tier: "medium", rationale: "benchmark" } },
		assembly: { stageId: "parallel", intermediateState: "complete" },
		verification: { timing: "task", methods: [], taskChecks: ["true"], rationale: "benchmark" },
	};
}

async function fixture() {
	const parent = await mkdtemp(join(tmpdir(), "pibox-workflow-bench-"));
	const root = join(parent, "repo");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Workflow Bench");
	await git(root, "config", "user.email", "bench@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/.pibox/\n");
	await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "initial"); await git(root, "branch", "-M", "develop");
	const identity = await discoverRepository(root, join(parent, "home"));
	const store = new WorkItemStore(root);
	await store.create({ id: "merge-safety", title: "Merge safety", kind: "change", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Exercise atomic parallel integration" });
	for (const id of ["left", "right"]) await store.defineTask({ workItemId: "merge-safety", manifest: task(id), brief: `${id} contribution`, acceptance: `${id} accepted` });
	await store.submitPlanning("merge-safety");
	const manager = new WorktreeManager(identity); await manager.prepareFeatureBranch("merge-safety");
	const allocations = new Map<string, Awaited<ReturnType<WorktreeManager["allocate"]>>>();
	for (const id of ["left", "right"]) {
		const allocation = await manager.allocate("merge-safety", await store.readTask("merge-safety", id));
		allocations.set(id, allocation);
		await store.updateTask("merge-safety", id, { status: "running", runtime: { executionMode: allocation.isolation, branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
	}
	return { parent, root, store, manager, allocations };
}

function result(id: string, findings: string[]): WorkflowScenarioResult {
	const dimension = (name: ScenarioDimension["name"], weight: number, selected: string[]): ScenarioDimension => ({ name, weight, score: selected.length ? 0 : 100, findings: selected });
	const dimensions = [dimension("outcome", 25, findings), dimension("scheduling", 25, []), dimension("safety", 25, findings), dimension("autonomy", 15, []), dimension("protocol", 10, [])];
	return { scenarioId: id, passed: findings.length === 0, score: findings.length ? 50 : 100, terminal: findings.length ? "paused" : "complete", peakConcurrency: 2, stepStatuses: {}, dimensions, findings, trace: [] };
}

async function completeContribution(f: Awaited<ReturnType<typeof fixture>>, id: string, file: string, content: string): Promise<void> {
	const allocation = f.allocations.get(id)!;
	await writeFile(join(allocation.path, file), content);
	await git(allocation.path, "add", file);
	await git(allocation.path, "commit", "--quiet", "-m", `${id} contribution`);
	await f.store.updateTask("merge-safety", id, { status: "contribution_complete", runtime: { completedCommit: await git(allocation.path, "rev-parse", "HEAD") } });
}

export async function runAtomicConflictScenario(): Promise<WorkflowScenarioResult> {
	const f = await fixture(); const findings: string[] = [];
	try {
		await completeContribution(f, "left", "README.md", "left\n");
		await completeContribution(f, "right", "README.md", "right\n");
		const base = await git(f.root, "rev-parse", "HEAD");
		let rejected = false; try { await f.manager.mergeTask("merge-safety", "left"); } catch { rejected = true; }
		if (!rejected) findings.push("Conflicting parallel stage merged unexpectedly.");
		if (await git(f.root, "rev-parse", "HEAD") !== base) findings.push("Failed merge changed the feature-branch commit.");
		if (await git(f.root, "status", "--porcelain")) findings.push("Failed merge left the feature branch dirty.");
		if (await readFile(join(f.root, "README.md"), "utf8") !== "fixture\n") findings.push("Failed merge changed canonical file content.");
		for (const id of ["left", "right"]) if ((await f.store.readTask("merge-safety", id)).status !== "contribution_complete") findings.push(`Failed merge lost the ${id} contribution state.`);
		return result("atomic-parallel-conflict", findings);
	} finally { await rm(f.parent, { recursive: true, force: true }); }
}

export async function runPostCheckRollbackScenario(): Promise<WorkflowScenarioResult> {
	const f = await fixture(); const findings: string[] = [];
	try {
		await completeContribution(f, "left", "left.txt", "left\n");
		await completeContribution(f, "right", "right.txt", "right\n");
		const base = await git(f.root, "rev-parse", "HEAD");
		let rejected = false; try { await f.manager.mergeTask("merge-safety", "left", ["false"]); } catch { rejected = true; }
		if (!rejected) findings.push("Stage with a failing post-merge check was accepted.");
		if (await git(f.root, "rev-parse", "HEAD") !== base) findings.push("Failed post-merge check changed the feature-branch commit.");
		if (await git(f.root, "status", "--porcelain")) findings.push("Failed post-merge check left the feature branch dirty.");
		return result("post-check-rollback", findings);
	} finally { await rm(f.parent, { recursive: true, force: true }); }
}

export async function runDirtyCanonicalPreservationScenario(): Promise<WorkflowScenarioResult> {
	const f = await fixture(); const findings: string[] = [];
	try {
		await completeContribution(f, "left", "left.txt", "left\n");
		await completeContribution(f, "right", "right.txt", "right\n");
		await writeFile(join(f.root, "manual.txt"), "preserve me\n");
		let rejected = false; try { await f.manager.mergeTask("merge-safety", "left"); } catch { rejected = true; }
		if (!rejected) findings.push("Merge proceeded on a dirty canonical branch.");
		if (await readFile(join(f.root, "manual.txt"), "utf8") !== "preserve me\n") findings.push("Dirty canonical work was not preserved.");
		return result("dirty-canonical-preserved", findings);
	} finally { await rm(f.parent, { recursive: true, force: true }); }
}

export async function runFinalJourneyDedupScenario(): Promise<WorkflowScenarioResult> {
	const f = await fixture(); const findings: string[] = [];
	try {
		const planned: EvaluationManifest = {
			schemaVersion: 1, id: "planned-journey", type: "e2e", scope: { workItem: "merge-safety" },
			status: "planned", required: true, attempt: 0, methods: ["Legacy whole-branch journey"],
		};
		await f.store.defineEvaluation("merge-safety", planned);
		const finals = await f.store.ensureFinalEvaluations("merge-safety", 2);
		const item = await f.store.read("merge-safety");
		if (item.evaluations.some((evaluation) => evaluation.id === "final-e2e")) findings.push("Runtime inserted a duplicate final journey evaluation.");
		if (finals[0]?.id !== "planned-journey") findings.push(`Runtime did not adopt planned-journey; selected ${finals[0]?.id ?? "none"}.`);
		if (!item.evaluations.some((evaluation) => evaluation.id === "final-branch-review")) findings.push("Runtime did not retain the final branch review gate.");
		return result("final-journey-dedup", findings);
	} finally { await rm(f.parent, { recursive: true, force: true }); }
}

export const gitSafetyScenarios = [runAtomicConflictScenario, runPostCheckRollbackScenario, runDirtyCanonicalPreservationScenario, runFinalJourneyDedupScenario];
